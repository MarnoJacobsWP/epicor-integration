import fp from 'fastify-plugin';

async function dbHealth(fastify, opts) {
  // Only run if MongoDB is configured
  if (!fastify.mongo) {
    fastify.log.warn('MongoDB not configured, skipping health checks');
    return;
  }
  
  // Add health check endpoint for MongoDB
  fastify.addHook('onReady', async function () {
    try {
      await fastify.mongo.db.command({ ping: 1 });
      fastify.log.info('MongoDB health check passed');
    } catch (error) {
      fastify.log.error('MongoDB health check failed:', error.message);
      // Avoid terminating the process for health check failures.
    }
  });
  
  // MongoDB event listeners
  if (fastify.mongo.client) {
    fastify.mongo.client.on('serverClosed', (event) => {
      fastify.log.warn('MongoDB connection closed');
    });
    
    fastify.mongo.client.on('serverHeartbeatFailed', (event) => {
      fastify.log.error('MongoDB heartbeat failed:', event);
    });
    
    fastify.mongo.client.on('connectionPoolCreated', (event) => {
      fastify.log.debug('MongoDB connection pool created');
    });
    
    fastify.mongo.client.on('connectionPoolReady', (event) => {
      fastify.log.debug('MongoDB connection pool ready');
    });
  }
  
  // Periodic health check (every 5 minutes)
  const healthCheckInterval = setInterval(async () => {
    try {
      if (fastify.mongo && fastify.mongo.db) {
        await fastify.mongo.db.command({ ping: 1 });
      }
    } catch (error) {
      fastify.log.error('Periodic MongoDB health check failed:', error.message);
    }
  }, 5 * 60 * 1000);
  
  // Clean up interval on close
  fastify.addHook('onClose', async () => {
    clearInterval(healthCheckInterval);
  });
}

export default fp(dbHealth, {
  name: 'dbHealth',
  dependencies: ['mongo']
});