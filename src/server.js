import Fastify from 'fastify';
import app from './app.js';
import { options } from './app.js';

const fastify = Fastify(options);

const start = async () => {
  try {
    await fastify.register(app, options);

    const host = fastify.config?.HOST || '0.0.0.0';
    const port = Number(fastify.config?.PORT || 3000);

    await fastify.listen({ host, port });

    fastify.log.info(`Server running in ${fastify.config?.NODE_ENV} mode`);
    fastify.log.info(`Server listening on http://${host}:${port}`);
    fastify.log.info(`Health check available at http://${host}:${port}/health`);

    const signals = ['SIGINT', 'SIGTERM'];
    signals.forEach((signal) => {
      process.on(signal, async () => {
        fastify.log.info(`Received ${signal}, shutting down...`);
        try {
          await fastify.close();
          process.exit(0);
        } catch (closeError) {
          fastify.log.error(`Shutdown failed: ${closeError.message}`);
          process.exit(1);
        }
      });
    });

    process.on('uncaughtException', (error) => {
      fastify.log.error(`Uncaught exception: ${error.message}`);
      process.exit(1);
    });

    process.on('unhandledRejection', (reason) => {
      const message = reason instanceof Error ? reason.message : String(reason);
      fastify.log.error(`Unhandled rejection: ${message}`);
      process.exit(1);
    });
  } catch (error) {
    fastify.log.error(`Error starting server: ${error.message}`);
    process.exit(1);
  }
};

start();