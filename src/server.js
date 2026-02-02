import Fastify from 'fastify';
import app from './app.js';
import { options } from './app.js';

const fastify = Fastify(options);

const start = async () => {
  try {

    await fastify.register(app, options);

    const host = process.env.HOST || '0.0.0.0';
    const port = 443; 

    await fastify.listen({ host, port });

    console.log(`Server running in ${process.env.NODE_ENV} mode`);
    console.log(`Server listening on https://${host}:${port}`);
    console.log(`Health check: https://${host}:${port}/health`);

    const signals = ['SIGINT', 'SIGTERM'];
    signals.forEach(signal => {
      process.on(signal, async () => {
        console.log(`Received ${signal}, starting graceful shutdown...`);
        await fastify.close();
        console.log('Server closed gracefully');
        process.exit(0);
      });
    });

  } catch (error) {
    console.error('Error starting server:', error);
    process.exit(1);
  }
};

start();