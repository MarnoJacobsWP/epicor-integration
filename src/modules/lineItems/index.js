import AutoLoad from '@fastify/autoload';
import { join } from 'desm';
import fp from 'fastify-plugin';

export default fp(
  async function lineItems(fastify, opts) {
    await fastify.register(AutoLoad, {
      dir: join(import.meta.url, 'services'),
      dirNameRoutePrefix: false,
      indexPattern: /orderProdMixServices\.js$/i,
      options: { ...opts },
    });

    await fastify.register(AutoLoad, {
      dir: join(import.meta.url, 'services'),
      dirNameRoutePrefix: false,
      indexPattern: /quoteProdMixServices\.js$/i,
      options: { ...opts },
    });

    await fastify.register(AutoLoad, {
      dir: join(import.meta.url, 'services'),
      dirNameRoutePrefix: false,
      indexPattern: /qSeatEtabServices\.js$/i,
      options: { ...opts },
    });

    fastify.log.info('Line Items module loaded');
  },
  {
    name: 'lineItems',
  },
);