import AutoLoad from '@fastify/autoload';
import { join } from 'desm';
import fp from 'fastify-plugin';

export default fp(
  async function sync(fastify, opts) {
    await fastify.register(AutoLoad, {
      dir: join(import.meta.url, 'repositories'),
      dirNameRoutePrefix: false,
      indexPattern: /^syncRepository.js$/i,
      options: { ...opts },
    });

    await fastify.register(AutoLoad, {
      dir: join(import.meta.url, 'services'),
      dirNameRoutePrefix: false,
      indexPattern: /.*Services(\.js|\.cjs)$/i,
      options: { ...opts },
    });

    fastify.get('/sync/status', async (request, reply) => {
      try {
        const status = await fastify.syncService.getSyncStatus();
        return status;
      } catch (error) {
        fastify.log.error(`Sync status failed: ${error.message}`);
        return reply.status(500).send({
          success: false,
          error: error.message,
        });
      }
    });

    fastify.post('/sync/all', async (request, reply) => {
      try {
        const dateString = fastify.utils?.getSyncDate(fastify.constants.SYNC_INTERVAL) || new Date().toISOString();
        const result = await fastify.syncService.runFullSync(dateString);
        return result;
      } catch (error) {
        fastify.log.error(`Full sync failed: ${error.message}`);
        return reply.status(500).send({
          success: false,
          error: error.message,
        });
      }
    });

    /**
     * POST /sync/test
     * Runs a full sync using the hardcoded FILTER_TIMESTAMP from constants.
     * Useful for reprocessing records that were missed.
     */
    fastify.post('/sync/test', async (request, reply) => {
      try {
        const timestamp = fastify.constants.FILTER_TIMESTAMP;
        fastify.log.info(`Test sync triggered with hardcoded timestamp: ${timestamp}`);
        const result = await fastify.syncService.runFullSync(timestamp, { skipCursor: true });
        return result;
      } catch (error) {
        fastify.log.error(`Test sync failed: ${error.message}`);
        return reply.status(500).send({
          success: false,
          error: error.message,
        });
      }
    });

    fastify.log.info('Sync module loaded');
  },
  {
    name: 'sync',
  },
);