import fastify from 'fastify';
import { options } from './src/app.js';
import app from './src/app.js';

async function start() {
  const server = fastify(options);
  
  try {
    await server.register(app);
    
    const PORT = 443;
    const HOST = process.env.HOST || '0.0.0.0';
    
    await server.listen({
      port: PORT,
      host: HOST
    });
    
    server.log.info(`Server running on port ${PORT}`);
    
    process.on('SIGINT', () => {
      server.log.info('Received SIGINT. Shutting down gracefully...');
      server.close(() => {
        server.log.info('Server closed');
        process.exit(0);
      });
    });
    
    process.on('SIGTERM', () => {
      server.log.info('Received SIGTERM. Shutting down gracefully...');
      server.close(() => {
        server.log.info('Server closed');
        process.exit(0);
      });
    });
    
  } catch (err) {
    server.log.error('Error starting server:', err);
    process.exit(1);
  }
}

start();