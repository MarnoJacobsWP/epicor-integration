import fp from 'fastify-plugin';
import path from 'node:path';
import fs from 'node:fs/promises';

const normalizeTableKey = (table) => String(table || '').trim().toUpperCase();

const sanitizeFileName = (name) => name.replace(/[^a-zA-Z0-9-_]/g, '_');

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

  fastify.decorate('epicorExportService', {
    exportAllTables,
    exportTable,
  });
}

export default fp(epicorExportService, {
  name: 'epicorExportService',
  dependencies: ['epicorAdapter', 'constants', 'appConfig'],
});
