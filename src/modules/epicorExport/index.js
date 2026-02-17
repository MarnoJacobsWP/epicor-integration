import AutoLoad from '@fastify/autoload';
import { join } from 'desm';
import fp from 'fastify-plugin';

export default fp(
  async function epicorExport(fastify, opts) {
    const toBoolean = (value, fallback = false) => {
      if (value == null) return fallback;
      if (typeof value === 'boolean') return value;
      const normalized = String(value).trim().toLowerCase();
      if (['true', '1', 'yes', 'y'].includes(normalized)) return true;
      if (['false', '0', 'no', 'n'].includes(normalized)) return false;
      return fallback;
    };

    await fastify.register(AutoLoad, {
      dir: join(import.meta.url, 'services'),
      dirNameRoutePrefix: false,
      indexPattern: /.*Services(\.js|\.cjs)$/i,
      options: { ...opts },
    });

    fastify.get('/epicor/export/all', async (request, reply) => {
      try {
        const result = await fastify.epicorExportService.exportAllTables();
        return reply.send(result);
      } catch (error) {
        fastify.log.error(`Epicor export all failed: ${error.message}`);
        return reply.status(500).send({
          success: false,
          error: error.message,
        });
      }
    });

    fastify.get('/epicor/export/:table', async (request, reply) => {
      try {
        const { table } = request.params;
        const result = await fastify.epicorExportService.exportTable(table);
        return reply.send(result);
      } catch (error) {
        fastify.log.error(`Epicor export table failed: ${error.message}`);
        return reply.status(500).send({
          success: false,
          error: error.message,
        });
      }
    });

    fastify.get('/epicor/export/test/qseatetab', async (request, reply) => {
      try {
        const { maxQuotes, includeRecords, writeFile } = request.query || {};

        const result = await fastify.epicorExportService.testQSeatEtabByQuotes({
          maxQuotes,
          includeRecords: toBoolean(includeRecords, false),
          writeFile: toBoolean(writeFile, true),
        });

        return reply.send(result);
      } catch (error) {
        fastify.log.error(`Epicor qseatetab test export failed: ${error.message}`);
        return reply.status(500).send({
          success: false,
          error: error.message,
        });
      }
    });

    fastify.log.info('Epicor export module loaded');
  },
  {
    name: 'epicorExport',
  },
);
