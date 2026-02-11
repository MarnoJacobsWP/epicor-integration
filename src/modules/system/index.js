import AutoLoad from '@fastify/autoload';
import { join } from 'desm';
import fp from 'fastify-plugin';

export default fp(
  async function system(fastify, opts) {
    await fastify.register(AutoLoad, {
      dir: join(import.meta.url, 'services'),
      dirNameRoutePrefix: false,
      indexPattern: /.*Services(\.js|\.cjs)$/i,
      options: Object.assign({}, opts),
    });

    fastify.get('/health', async (request, reply) => {
      const result = await fastify.systemService.buildHealthPayload();
      return reply.code(result.code).send(result.body);
    });

    fastify.get('/', async () => fastify.systemService.buildRootPayload());

    fastify.get('/metrics', async () => fastify.systemService.buildMetricsPayload());

    fastify.log.info('System module loaded');
  },
  { name: 'system' },
);
