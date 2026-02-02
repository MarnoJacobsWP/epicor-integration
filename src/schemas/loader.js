import { join } from 'desm';
import fp from 'fastify-plugin';
import { readFileSync } from 'node:fs';

const environmentVariables = JSON.parse(
  readFileSync(join(import.meta.url, './dotenv.json')),
);

export default fp(
  async function schemasRoot(fastify, opts) {
    fastify.addSchema(environmentVariables);
  },
  {
    name: 'schemasRoot',
  },
);