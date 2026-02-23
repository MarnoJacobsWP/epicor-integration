import fp from 'fastify-plugin';
import path from 'node:path';
import fs from 'node:fs/promises';

const normalizeTableKey = (table) => String(table || '').trim().toUpperCase();

const sanitizeFileName = (name) => name.replaceAll(/[^a-zA-Z0-9-_]/g, '_');
const HARDCODED_QSEAT_ETAB_QUOTE_NUM = 161247;

async function epicorExportService(fastify, _) {
  const { ENDPOINTS } = fastify.constants;
  const BAQ_ID = '68138';

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

  const buildBaqDataUrl = (endpoint, queryParams = {}) => {
    const baseUrl = String(fastify.config?.BASE_URL || '').replace(/\/+$/, '');
    if (!baseUrl) {
      throw new Error('Missing BASE_URL configuration for Epicor API');
    }

    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(queryParams || {})) {
      if (value == null || value === '') continue;
      params.set(key, String(value));
    }

    const queryString = params.toString();
    const suffix = queryString ? `?${queryString}` : '';
    return `${baseUrl}/${endpoint}(${BAQ_ID})/Data${suffix}`;
  };

  const fetchAllBaqDataRecords = async (endpoint, extraParams = {}) => {
    const top = fastify.constants?.PAGINATION?.TOP || 50000;
    let skip = 0;
    const allRecords = [];
    let pagesFetched = 0;
    const startTime = Date.now();
    let lastUrl = null;

    while (true) {
      const requestUrl = buildBaqDataUrl(endpoint, {
        $top: top,
        $skip: skip,
        ...extraParams,
      });
      lastUrl = requestUrl;

      const response = await fastify.epicorAdapter._makeRequest(requestUrl);
      const records = response?.data?.value || [];
      pagesFetched++;

      if (!records.length) break;
      allRecords.push(...records);

      if (records.length < top) break;
      skip += top;
    }

    return {
      requestUrl: lastUrl,
      records: allRecords,
      metadata: {
        totalRecords: allRecords.length,
        pagesFetched,
        elapsedTimeMs: Date.now() - startTime,
      },
    };
  };

  const fetchRecordsForTable = async (tableKey, endpoint) => {
    try {
      return await fastify.epicorAdapter.fetchAllRecords(endpoint);
    } catch (error) {
      const status = error?.response?.status;
      const isBadRequest = status === 400 || String(error?.message || '').includes('400 Bad Request');
      const shouldUseBaqFallback = isBadRequest && ['QUOTES', 'QUOTE_PROD_MIX'].includes(tableKey);

      if (!shouldUseBaqFallback) {
        throw error;
      }

      fastify.log.warn(`Falling back to BAQ Data endpoint for ${tableKey} due to ${error.message}`);
      return await fetchAllBaqDataRecords(endpoint);
    }
  };

  const isEntitySetDescriptor = (records) => {
    return records.length === 1
      && records[0]?.url === 'Data'
      && records[0]?.kind === 'EntitySet';
  };

  const fetchQSeatEtabForQuote = async (quoteNum) => {
    const qseatEndpoint = ENDPOINTS.QSEAT_ETAB;
    const baseUrl = String(fastify.config?.BASE_URL || '').replace(/\/+$/, '');
    const normalizedQuoteNum = String(quoteNum ?? '').trim();

    if (!qseatEndpoint || !baseUrl || !normalizedQuoteNum) {
      throw new Error('Missing endpoint, base URL, or quote number for QSeatEtab fetch');
    }

    const encodedQuoteNum = encodeURIComponent(normalizedQuoteNum);
    const candidateUrls = [
      `${baseUrl}/${qseatEndpoint}(${BAQ_ID})/Data?QuoteNum=${encodedQuoteNum}`,
      `${baseUrl}/${qseatEndpoint}(${BAQ_ID})/Data/?QuoteNum=${encodedQuoteNum}`,
      `${baseUrl}/${qseatEndpoint}(${BAQ_ID})/?QuoteNum=${encodedQuoteNum}`,
    ];

    let lastError = null;

    for (const url of candidateUrls) {
      try {
        const response = await fastify.epicorAdapter._makeRequest(url);
        const records = response?.data?.value || [];

        if (isEntitySetDescriptor(records)) {
          continue;
        }

        fastify.log.info(`Fetched ${records.length} QSeatEtab records for quote ${normalizedQuoteNum}`);
        return records;
      } catch (error) {
        lastError = error;
      }
    }

    if (lastError) throw lastError;
    return [];
  };

  const exportQSeatEtabByQuoteNumbers = async () => {
    const quoteEndpoint = ENDPOINTS.QUOTES;
    const qseatEndpoint = ENDPOINTS.QSEAT_ETAB;

    if (!quoteEndpoint || !qseatEndpoint) {
      throw new Error('Missing QUOTES or QSEAT_ETAB endpoint configuration');
    }

    const quoteData = await fetchRecordsForTable('QUOTES', quoteEndpoint);
    const quoteNumbers = [...new Set(
      (quoteData.records || [])
        .map((quote) => extractQuoteNum(quote))
        .filter(Boolean)
    )];

    const records = [];
    const perQuote = [];
    const startTime = Date.now();

    for (const quoteNum of quoteNumbers) {
      try {
        const qseatRecords = await fetchQSeatEtabForQuote(quoteNum);
        const count = qseatRecords.length;
        if (count > 0) {
          records.push(...qseatRecords);
        }

        perQuote.push({ quoteNum, totalRecords: count });
      } catch (error) {
        perQuote.push({ quoteNum, error: error.message });
      }
    }

    const payload = {
      table: 'QSEAT_ETAB',
      endpoint: qseatEndpoint,
      exportedAt: new Date().toISOString(),
      source: 'quote-driven',
      quoteNumbersProcessed: quoteNumbers.length,
      metadata: {
        totalRecords: records.length,
        pagesFetched: 0,
        elapsedTimeMs: Date.now() - startTime,
      },
      perQuote,
      records,
    };

    const filePath = await writeJsonFile('QSEAT_ETAB', payload);

    return {
      success: true,
      table: 'QSEAT_ETAB',
      endpoint: qseatEndpoint,
      exportDir,
      filePath,
      totalRecords: payload.metadata.totalRecords,
      pagesFetched: payload.metadata.pagesFetched,
      elapsedTimeMs: payload.metadata.elapsedTimeMs,
      quoteNumbersProcessed: quoteNumbers.length,
    };
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

    if (key === 'QSEAT_ETAB') {
      return await exportQSeatEtabByQuoteNumbers();
    }

    const { records, metadata } = await fetchRecordsForTable(key, endpoint);
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
      try {
        const result = await exportTable(tableKey);
        results.push(result);
      } catch (error) {
        fastify.log.error(`Export failed for ${tableKey}: ${error.message}`);
        results.push({
          success: false,
          table: tableKey,
          error: error.message,
        });
      }
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

    const quotesResponse = await fetchRecordsForTable('QUOTES', quoteEndpoint);
    const quoteNumbers = [...new Set(
      (quotesResponse.records || [])
        .map((quote) => extractQuoteNum(quote))
        .filter(Boolean)
    )].slice(0, quoteLimit);

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
      quotesFetched: quotesResponse.metadata?.totalRecords || quoteNumbers.length,
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
    const quoteNum = String(quoteNumInput).trim();
    if (!quoteNum) {
      throw new TypeError('Quote number is required');
    }

    const baseUrl = String(fastify.config?.BASE_URL || '').replace(/\/+$/, '');
    if (!baseUrl) {
      throw new Error('Missing BASE_URL configuration for Epicor API');
    }

    const startTime = Date.now();
    const encodedQuoteNum = encodeURIComponent(quoteNum);
    const candidateUrls = [
      `${baseUrl}/${qseatEndpoint}(68138)/Data?QuoteNum=${encodedQuoteNum}`,
      `${baseUrl}/${qseatEndpoint}(68138)/Data/?QuoteNum=${encodedQuoteNum}`,
      `${baseUrl}/${qseatEndpoint}(68138)/?QuoteNum=${encodedQuoteNum}`,
    ];

    let requestUrl = candidateUrls[0];
    let records = [];
    let lastError = null;

    for (const url of candidateUrls) {
      try {
        const response = await fastify.epicorAdapter._makeRequest(url);
        const candidateRecords = response?.data?.value || [];

        const isEntitySetDescriptor = candidateRecords.length === 1
          && candidateRecords[0]?.url === 'Data'
          && candidateRecords[0]?.kind === 'EntitySet';

        if (isEntitySetDescriptor) {
          continue;
        }

        requestUrl = url;
        records = candidateRecords;
        break;
      } catch (error) {
        lastError = error;
      }
    }

    if (!records.length && lastError) {
      throw lastError;
    }

    const metadata = {
      totalRecords: records.length,
      pagesFetched: 1,
      elapsedTimeMs: Date.now() - startTime,
    };

    const payload = {
      test: 'qseatetab-hardcoded-quote',
      endpoint: qseatEndpoint,
      exportedAt: new Date().toISOString(),
      hardcodedQuoteNum: quoteNum,
      requestUrl,
      filterMode: 'direct-baq-quote-param',
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

  const exportQuotesOnly = async () => {
    const endpoint = ENDPOINTS.QUOTES;
    if (!endpoint) {
      throw new Error('Missing QUOTES endpoint configuration');
    }

    const { records, metadata } = await fetchRecordsForTable('QUOTES', endpoint);
    const payload = {
      table: 'QUOTES',
      endpoint,
      exportedAt: new Date().toISOString(),
      metadata,
      records,
    };

    const filePath = await writeJsonFile('QUOTES', payload);

    return {
      success: true,
      table: 'QUOTES',
      endpoint,
      exportDir,
      filePath,
      totalRecords: metadata.totalRecords,
      pagesFetched: metadata.pagesFetched,
      elapsedTimeMs: metadata.elapsedTimeMs,
    };
  };

  const exportQuoteProdMixByQuotes = async () => {
    const quoteEndpoint = ENDPOINTS.QUOTES;
    const quoteProdMixEndpoint = ENDPOINTS.QUOTE_PROD_MIX;

    if (!quoteEndpoint || !quoteProdMixEndpoint) {
      throw new Error('Missing QUOTES or QUOTE_PROD_MIX endpoint configuration');
    }

    fastify.log.info('Fetching all quotes to drive QuoteProdMix export...');
    const quoteData = await fetchRecordsForTable('QUOTES', quoteEndpoint);
    const quoteNumbers = [...new Set(
      (quoteData.records || [])
        .map((quote) => extractQuoteNum(quote))
        .filter(Boolean)
    )];

    fastify.log.info(`Found ${quoteNumbers.length} unique quote numbers, fetching QuoteProdMix for each...`);

    const records = [];
    const perQuote = [];
    const startTime = Date.now();

    for (const quoteNum of quoteNumbers) {
      try {
        const result = await fastify.epicorAdapter.fetchRelatedRecords(
          quoteProdMixEndpoint,
          'QuoteDtl_QuoteNum',
          quoteNum
        );
        const count = result.metadata.totalRecords;
        if (count > 0) {
          records.push(...result.records);
        }
        perQuote.push({ quoteNum, totalRecords: count });
      } catch (error) {
        perQuote.push({ quoteNum, error: error.message });
      }
    }

    const payload = {
      table: 'QUOTE_PROD_MIX',
      endpoint: quoteProdMixEndpoint,
      exportedAt: new Date().toISOString(),
      source: 'quote-driven',
      quoteNumbersProcessed: quoteNumbers.length,
      metadata: {
        totalRecords: records.length,
        pagesFetched: 0,
        elapsedTimeMs: Date.now() - startTime,
      },
      perQuote,
      records,
    };

    const filePath = await writeJsonFile('QUOTE_PROD_MIX', payload);

    return {
      success: true,
      table: 'QUOTE_PROD_MIX',
      endpoint: quoteProdMixEndpoint,
      exportDir,
      filePath,
      totalRecords: payload.metadata.totalRecords,
      quoteNumbersProcessed: quoteNumbers.length,
      elapsedTimeMs: payload.metadata.elapsedTimeMs,
    };
  };

  fastify.decorate('epicorExportService', {
    exportAllTables,
    exportTable,
    exportQuotesOnly,
    exportQuoteProdMixByQuotes,
    exportQSeatEtabByQuoteNumbers,
    testQSeatEtabByQuotes,
    exportQSeatEtabForHardcodedQuote,
  });
}

export default fp(epicorExportService, {
  name: 'epicorExportService',
  dependencies: ['epicorAdapter', 'constants', 'appConfig'],
});
