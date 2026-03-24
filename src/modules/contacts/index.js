import AutoLoad from '@fastify/autoload';
import { join } from 'desm';
import fp from 'fastify-plugin';

export default fp(
  async function contacts(fastify, opts) {
    await fastify.register(AutoLoad, {
      dir: join(import.meta.url, 'services'),
      dirNameRoutePrefix: false,
      indexPattern: /.*Services(\.js|\.cjs)$/i,
      options: { ...opts },
    });

    fastify.post('/syncContacts', async (request, reply) => {
      try {
        const timestamp = await fastify.syncService.resolveTimestamp('contacts');
        const syncStart = Math.floor(Date.now() / 1000);
        const result = await fastify.contactTask.task(timestamp);
        if (result?.syncedCount > 0) await fastify.syncService.advanceCursor('contacts', syncStart);
        return result;
      } catch (error) {
        fastify.log.error(`Contact sync failed: ${error.message}`);
        return reply.status(500).send({
          success: false,
          error: error.message,
        });
      }
    });

    fastify.log.info('Contacts module loaded');
  },
  {
    name: 'contacts',
  },
);