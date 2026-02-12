import AutoLoad from '@fastify/autoload';
import { join } from 'desm';
import fp from 'fastify-plugin';

export default fp(
  async function epicorExport(fastify, opts) {
    await fastify.register(AutoLoad, {
      dir: join(import.meta.url, 'services'),
      dirNameRoutePrefix: false,
      indexPattern: /.*Services(\.js|\.cjs)$/i,
      options: Object.assign({}, opts),
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

    fastify.log.info('Epicor export module loaded');
  },
  {
    name: 'epicorExport',
  },
);
