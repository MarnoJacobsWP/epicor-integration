import AutoLoad from '@fastify/autoload';
import { join } from 'desm';
import fp from 'fastify-plugin';

export default fp(
  async function orders(fastify, opts) {
    await fastify.register(AutoLoad, {
      dir: join(import.meta.url, 'services'),
      dirNameRoutePrefix: false,
      indexPattern: /.*Services(\.js|\.cjs)$/i,
      options: { ...opts },
    });

    fastify.post('/syncOrders', async (request, reply) => {
      try {
        const dateString = fastify.utils?.getSyncDate(fastify.constants.SYNC_INTERVAL) || new Date().toISOString();
        const result = await fastify.orderTask.task(dateString);
        return result;
      } catch (error) {
        fastify.log.error(`Order sync failed: ${error.message}`);
        return reply.status(500).send({
          success: false,
          error: error.message,
        });
      }
    });

    fastify.log.info('Orders module loaded');
  },
  {
    name: 'orders',
  },
);