import fp from 'fastify-plugin';

async function errorHandler(fastify, opts) {
  fastify.setErrorHandler(function (error, request, reply) {
    const statusCode = error.statusCode || 500;

    fastify.log.error({
      error: {
        message: error.message,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
        code: error.code,
        name: error.name,
      },
      request: {
        id: request.id,
        method: request.method,
        url: request.url,
        params: request.params,
        query: request.query,
      },
    }, 'Request error');

    const message = statusCode === 500 && process.env.NODE_ENV === 'production'
      ? 'Internal server error'
      : error.message;

    const response = {
      success: false,
      error: message,
      code: error.code || 'INTERNAL_ERROR',
      timestamp: new Date().toISOString(),
    };

    if (process.env.NODE_ENV === 'development') {
      response.stack = error.stack;
    }

    reply.status(statusCode).send(response);
  });

  if (!fastify.hasDecorator('notFoundHandlerSet')) {
    fastify.setNotFoundHandler(function (request, reply) {
      fastify.log.warn({
        request: {
          id: request.id,
          method: request.method,
          url: request.url,
        }
      }, 'Route not found');

      reply.status(404).send({
        success: false,
        error: `Route ${request.method}:${request.url} not found`,
        code: 'ROUTE_NOT_FOUND',
        timestamp: new Date().toISOString(),
      });
    });

    fastify.decorate('notFoundHandlerSet', true);
  }

  process.on('uncaughtException', (error) => {
    fastify.log.fatal({
      error: {
        message: error.message,
        stack: error.stack,
      }
    }, 'Uncaught exception');

    setTimeout(() => process.exit(1), 1000);
  });

  process.on('unhandledRejection', (reason) => {
    fastify.log.error({
      reason: reason.message || reason,
      stack: reason.stack,
    }, 'Unhandled promise rejection');
  });
}

export default fp(errorHandler, { name: 'errorHandler' });
