import fp from 'fastify-plugin';
import path from 'node:path';
import fs from 'node:fs/promises';

const normalizeTableKey = (table) => String(table || '').trim().toUpperCase();

const sanitizeFileName = (name) => name.replaceAll(/[^a-zA-Z0-9-_]/g, '_');
const HARDCODED_QSEAT_ETAB_QUOTE_NUM = 161247;

async function epicorExportService(fastify, _) {
  const { ENDPOINTS } = fastify.constants;

  const exportDir = fastify.config?.EXPORT_DIR
    ? path.resolve(fastify.config.EXPORT_DIR)
    : path.resolve(process.cwd(), 'data', 'epicor-exports');

  const ensureExportDir = async () => {
    await fs.mkdir(exportDir, { recursive: true });
  };

  const getEndpointForTable = (table) => {
    const key = normalizeTableKey(table);
    if (!key || !ENDPOINTS[key]) {
      return { key, endpoint: null };
    }
    return { key, endpoint: ENDPOINTS[key] };
  };

  const writeJsonFile = async (tableKey, payload) => {
    await ensureExportDir();
    const safeName = sanitizeFileName(tableKey);
    const filePath = path.join(exportDir, `${safeName}.json`);
    await fs.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8');
    return filePath;
  };

  const exportTable = async (table) => {
    const { key, endpoint } = getEndpointForTable(table);
    if (!endpoint) {
      return {
        success: false,
        error: `Unknown table: ${table}`,
        availableTables: Object.keys(ENDPOINTS),
      };
    }

    const { records, metadata } = await fastify.epicorAdapter.fetchAllRecords(endpoint);
    const payload = {
      table: key,
      endpoint,
      exportedAt: new Date().toISOString(),
      metadata,
      records,
    };

    const filePath = await writeJsonFile(key, payload);

    return {
      success: true,
      table: key,
      endpoint,
      exportDir,
      filePath,
      totalRecords: metadata.totalRecords,
      pagesFetched: metadata.pagesFetched,
      elapsedTimeMs: metadata.elapsedTimeMs,
    };
  };

  const exportAllTables = async () => {
    const results = [];

    for (const tableKey of Object.keys(ENDPOINTS)) {
      const result = await exportTable(tableKey);
      results.push(result);
    }

    const successes = results.filter((r) => r.success).length;
    const failures = results.length - successes;

    return {
      success: failures === 0,
      exportDir,
      totalTables: results.length,
      successes,
      failures,
      results,
    };
  };

  const toPositiveInteger = (value, fallback) => {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return parsed;
  };

  const extractQuoteNum = (quoteRecord) => {
    const candidates = [
      quoteRecord?.QuoteHed_QuoteNum,
      quoteRecord?.QuoteNum,
      quoteRecord?.quoteNum,
    ];

    for (const candidate of candidates) {
      if (candidate == null) continue;
      const normalized = String(candidate).trim();
      if (normalized) return normalized;
    }

    return null;
  };

  const testQSeatEtabByQuotes = async ({ maxQuotes = 25, includeRecords = false, writeFile = true } = {}) => {
    const quoteLimit = Math.min(toPositiveInteger(maxQuotes, 25), 500);

    const quoteEndpoint = ENDPOINTS.QUOTES;
    const qseatEndpoint = ENDPOINTS.QSEAT_ETAB;

    if (!quoteEndpoint || !qseatEndpoint) {
      throw new Error('Missing QUOTES or QSEAT_ETAB endpoint configuration');
    }

    const quotesResponse = await fastify.epicorAdapter.fetchLimitedRecords(quoteEndpoint, quoteLimit);
    const quoteNumbers = [...new Set(
      (quotesResponse.records || [])
        .map((quote) => extractQuoteNum(quote))
        .filter(Boolean)
    )];

    const perQuoteResults = [];
    let totalQseatRecords = 0;

    for (const quoteNum of quoteNumbers) {
      try {
        const { records, metadata } = await fastify.epicorAdapter.fetchRelatedRecords(
          qseatEndpoint,
          'QuoteDtl_QuoteNum',
          quoteNum
        );

        totalQseatRecords += records.length;

        perQuoteResults.push({
          quoteNum,
          totalRecords: metadata.totalRecords,
          pagesFetched: metadata.pagesFetched,
          elapsedTimeMs: metadata.elapsedTimeMs,
          ...(includeRecords ? { records } : {}),
        });
      } catch (error) {
        perQuoteResults.push({
          quoteNum,
          error: error.message,
        });
      }
    }

    const payload = {
      test: 'qseatetab-by-quote',
      endpoint: qseatEndpoint,
      exportedAt: new Date().toISOString(),
      quoteSampleSizeRequested: quoteLimit,
      quotesFetched: quotesResponse.metadata.totalRecords,
      quoteNumbersUsed: quoteNumbers.length,
      totalQseatRecords,
      successfulQueries: perQuoteResults.filter((item) => !item.error).length,
      failedQueries: perQuoteResults.filter((item) => item.error).length,
      results: perQuoteResults,
    };

    let filePath = null;
    if (writeFile) {
      filePath = await writeJsonFile(`QSEAT_ETAB_TEST_${Date.now()}`, payload);
    }

    return {
      success: true,
      exportDir,
      filePath,
      ...payload,
    };
  };

  const exportQSeatEtabForHardcodedQuote = async (quoteNumOverride) => {
    const qseatEndpoint = ENDPOINTS.QSEAT_ETAB;
    if (!qseatEndpoint) {
      throw new Error('Missing QSEAT_ETAB endpoint configuration');
    }

    const quoteNumInput = quoteNumOverride ?? HARDCODED_QSEAT_ETAB_QUOTE_NUM;
    const quoteNum = Number.parseInt(quoteNumInput, 10);
    if (!Number.isFinite(quoteNum)) {
      throw new TypeError(`Quote number must be numeric. Received: ${quoteNumInput}`);
    }

    const filterField = 'QuoteDtl_QuoteNum';
    const filterAttempts = [
      {
        mode: 'numeric',
        filterValue: quoteNum,
        filter: `${filterField} eq ${quoteNum}`,
      },
      {
        mode: 'quoted-string',
        filterValue: `'${quoteNum}'`,
        filter: `${filterField} eq '${quoteNum}'`,
      },
    ];

    let response = null;
    let successfulFilter = null;
    let successfulMode = null;
    let lastError = null;

    for (const attempt of filterAttempts) {
      try {
        response = await fastify.epicorAdapter.fetchRelatedRecords(
          qseatEndpoint,
          filterField,
          attempt.filterValue
        );
        successfulFilter = attempt.filter;
        successfulMode = attempt.mode;
        break;
      } catch (error) {
        lastError = error;
        const status = error?.response?.status;
        const is400 = status === 400 || String(error?.message || '').includes('400 Bad Request');
        if (!is400 || attempt.mode === 'quoted-string') {
          throw error;
        }
      }
    }

    if (!response) {
      throw new Error(`Failed to query QSEAT_ETAB for quote ${quoteNum}: ${lastError?.message || 'Unknown error'}`);
    }

    const { records, metadata } = response;

    const payload = {
      test: 'qseatetab-hardcoded-quote',
      endpoint: qseatEndpoint,
      exportedAt: new Date().toISOString(),
      hardcodedQuoteNum: quoteNum,
      filter: successfulFilter,
      filterMode: successfulMode,
      metadata,
      records,
    };

    const filePath = await writeJsonFile(`QSEAT_ETAB_${quoteNum}_${Date.now()}`, payload);

    return {
      success: true,
      exportDir,
      filePath,
      quoteNum,
      totalRecords: metadata.totalRecords,
      pagesFetched: metadata.pagesFetched,
      elapsedTimeMs: metadata.elapsedTimeMs,
    };
  };

  fastify.decorate('epicorExportService', {
    exportAllTables,
    exportTable,
    testQSeatEtabByQuotes,
    exportQSeatEtabForHardcodedQuote,
  });
}

export default fp(epicorExportService, {
  name: 'epicorExportService',
  dependencies: ['epicorAdapter', 'constants', 'appConfig'],
});
