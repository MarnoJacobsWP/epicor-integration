import fp from 'fastify-plugin';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export default fp(
  async (fastify) => {
    const MAX_RETRIES = fastify.constants?.MAX_RETRIES || 3;

    async function backOff(fn) {
      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          return await fn();
        } catch (error) {
          if (error.response && error.response.status === 429) {
            const waitTime = Math.log(attempt) * 1000;
            fastify.log.info(
              { module: 'Backoff' },
              `Attempt ${attempt} failed. Retrying in ${waitTime.toFixed(2)} ms...`,
            );
            await sleep(waitTime);
          } else {
            throw error;
          }
        }
      }
      throw new Error(`Failed after ${MAX_RETRIES} retries.`);
    }

    fastify.decorate('backoff', backOff);
  },
  { name: 'backoff', dependencies: ['constants'] },
);