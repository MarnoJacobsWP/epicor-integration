import AutoLoad from '@fastify/autoload';
import { join } from 'desm';
import fp from 'fastify-plugin';

export default fp(
  async function customers(fastify, opts) {
    await fastify.register(AutoLoad, {
      dir: join(import.meta.url, 'repositories'),
      dirNameRoutePrefix: false,
      indexPattern: /^customerRepository.js$/i,
      options: Object.assign({}, opts),
    });

    await fastify.register(AutoLoad, {
      dir: join(import.meta.url, 'services'),
      dirNameRoutePrefix: false,
      indexPattern: /.*Services(\.js|\.cjs)$/i,
      options: Object.assign({}, opts),
    });

    fastify.post('/syncCustomers', async (request, reply) => {
      try {
        const dateString = fastify.utils?.getSyncDate(fastify.constants.SYNC_INTERVAL) || new Date().toISOString();
        const result = await fastify.customerTask.task(dateString);
        return result;
      } catch (error) {
        fastify.log.error(`Customer sync failed: ${error.message}`);
        return reply.status(500).send({
          success: false,
          error: error.message,
        });
      }
    });

    fastify.log.info('Customers module loaded');
  },
  {
    name: 'customers',
  },
);