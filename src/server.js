import Fastify from 'fastify';
import app from './app.js';
import { options } from './app.js';

const fastify = Fastify(options);

const start = async () => {
  try {
    await fastify.register(app, options);
    const host = process.env.HOST || '0.0.0.0';
    const port = 443;
    
    const protocol = 'http';
    
    await fastify.listen({ host, port });
    console.log(`Server running in ${process.env.NODE_ENV} mode`);
    console.log(`Server listening on ${protocol}://${host}:${port}`);
    console.log(`Health check: ${protocol}://${host}:${port}/health`);
    
    const signals = ['SIGINT', 'SIGTERM'];
    signals.forEach((signal) => {
      process.on(signal, async () => {
        console.log(`Received ${signal}, shutting down...`);
        await fastify.close();
        process.exit(0);
      });
    });

    process.on('uncaughtException', (error) => {
      console.error('Uncaught Exception:', error);
      process.exit(1);
    });

    process.on('unhandledRejection', (reason, promise) => {
      console.error('Unhandled Rejection at:', promise, 'reason:', reason);
      process.exit(1);
    });
    
  } catch (error) {
    console.error('Error starting server:', error);
    process.exit(1);
  }
};

start();