import fp from 'fastify-plugin';
import fastifyRateLimit from '@fastify/rate-limit';

async function rateLimiter(fastify, opts) {
  await fastify.register(fastifyRateLimit, {
    global: true,
    max: parseInt(process.env.RATE_LIMIT_MAX) || 100,
    timeWindow: parseInt(process.env.RATE_LIMIT_WINDOW) || 60000,
    cache: 10000,
    allowList: ['127.0.0.1', '::1'],
    skipOnError: false,
    keyGenerator: function (request) {
      return request.headers['x-forwarded-for'] || 
             request.headers['x-real-ip'] || 
             request.ip;
    },
    errorResponseBuilder: function (request, context) {
      return {
        success: false,
        error: `Rate limit exceeded. Retry in ${context.after}`,
        code: 'RATE_LIMIT_EXCEEDED',
        retryAfter: context.after,
        limit: context.max,
        timestamp: new Date().toISOString(),
      };
    },
    addHeaders: {
      'x-ratelimit-limit': true,
      'x-ratelimit-remaining': true,
      'x-ratelimit-reset': true,
      'retry-after': true
    }
  });
}

export default fp(rateLimiter, {
  name: 'rateLimiter'
});