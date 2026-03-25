import AutoLoad from '@fastify/autoload';
import { join } from 'desm';
import fp from 'fastify-plugin';

export default fp(
  async function quotes(fastify, opts) {
    await fastify.register(AutoLoad, {
      dir: join(import.meta.url, 'services'),
      dirNameRoutePrefix: false,
      indexPattern: /.*Services(\.js|\.cjs)$/i,
      options: { ...opts },
    });

    fastify.post('/syncQuotes', async (request, reply) => {
      try {
        const timestamp = await fastify.syncService.resolveTimestamp('quotes');
        const result = await fastify.quoteTask.task(timestamp);
        await fastify.syncService.advanceCursorFromResult('quotes', result);
        return result;
      } catch (error) {
        fastify.log.error(`Quote sync failed: ${error.message}`);
        return reply.status(500).send({
          success: false,
          error: error.message,
        });
      }
    });

    fastify.log.info('Quotes module loaded');
  },
  {
    name: 'quotes',
  },
);