import fp from 'fastify-plugin';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status) {
  if (!status) return false;
  return status === 429 || (status >= 500 && status <= 599);
}

function getErrorChain(error) {
  const chain = [];
  let current = error;
  while (current && chain.length < 6) {
    chain.push(current);
    current = current.cause;
  }
  return chain;
}

function extractRetryContext(error) {
  const chain = getErrorChain(error);

  let status;
  let retryAfterHeader;
  for (const item of chain) {
    if (status == null && item?.response?.status != null) {
      status = item.response.status;
    }

    if (retryAfterHeader == null && item?.response?.headers?.['retry-after'] != null) {
      retryAfterHeader = item.response.headers['retry-after'];
    }
  }

  const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : undefined;
  return { status, retryAfterMs };
}

function computeDelay(attempt, baseDelayMs, retryAfterMs) {
  if (retryAfterMs) return retryAfterMs;
  const exponential = baseDelayMs * Math.pow(2, attempt - 1);
  const jitter = Math.floor(Math.random() * 100);
  return Math.min(exponential + jitter, 30000);
}

export default fp(
  async (fastify) => {
    const MAX_RETRIES = fastify.constants?.MAX_RETRIES || 3;

    async function backOff(fn, context = {}) {
      const baseDelayMs = 1000;
      const maxRetries = Math.max(MAX_RETRIES, 8);

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          return await fn();
        } catch (error) {
          const { status, retryAfterMs } = extractRetryContext(error);

          if (!isRetryableStatus(status)) {
            const message = `Backoff aborted after non-retryable error: ${error.message}: ${error.response}: ${error.response?.data}: ${error.response?.data?.message}`;
            throw new Error(message, { cause: error });
          }

          if (attempt >= maxRetries) {
            const message = `Backoff failed after ${maxRetries} retries: ${error.message}`;
            throw new Error(message, { cause: error });
          }

          const waitTime = computeDelay(attempt, baseDelayMs, retryAfterMs);
          const operation = context?.operation ? ` for ${context.operation}` : '';
          fastify.log.warn(
            `Attempt ${attempt} failed${operation}. Retrying in ${waitTime} ms...`,
          );
          await sleep(waitTime);
        }
      }

      throw new Error(`Backoff failed after ${MAX_RETRIES} retries.`);
    }

    fastify.decorate('backoff', backOff);
  },
  { name: 'backoff', dependencies: ['constants'] },
);