import fastifyEnv from '@fastify/env';
import fp from 'fastify-plugin';

export default fp(
  async (fastify) => {
    await fastify.register(fastifyEnv, {
      confKey: 'config',
      schema: fastify.getSchema('schema:config:env'),
      dotenv: true,
    });
  },
  { name: 'appConfig' },
);