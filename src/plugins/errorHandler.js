import fp from 'fastify-plugin';

async function errorHandler(fastify, opts) {
  fastify.setErrorHandler((error, request, reply) => {
    const statusCode = error.statusCode || 500;
    fastify.log.error({ error, request }, 'Request error');

    const message =
      statusCode === 500 && process.env.NODE_ENV === 'production'
        ? 'Internal server error'
        : error.message;

    const response = {
      success: false,
      error: message,
      code: error.code || 'INTERNAL_ERROR',
      timestamp: new Date().toISOString(),
    };

    if (process.env.NODE_ENV === 'development') response.stack = error.stack;

    reply.status(statusCode).send(response);
  });

  try {
    fastify.setNotFoundHandler((request, reply) => {
      fastify.log.warn({ request }, 'Route not found');
      reply.status(404).send({
        success: false,
        error: `Route ${request.method}:${request.url} not found`,
        code: 'ROUTE_NOT_FOUND',
        timestamp: new Date().toISOString(),
      });
    });
  } catch (err) {
    fastify.log.warn('NotFoundHandler already set, skipping...');
  }

  process.on('uncaughtException', (error) => {
    fastify.log.fatal({ error }, 'Uncaught exception');
    setTimeout(() => process.exit(1), 1000);
  });

  process.on('unhandledRejection', (reason) => {
    fastify.log.error({ reason }, 'Unhandled promise rejection');
  });
}

export default fp(errorHandler, { name: 'errorHandler' });
