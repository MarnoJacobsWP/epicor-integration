import fastifyMongodb from '@fastify/mongodb';
import fp from 'fastify-plugin';

const mongoDBConfiguration = async (fastify, opts) => {
  const mongoUri = fastify.config.MONGO_URI;
  
  if (!mongoUri) {
    fastify.log.error('MONGO_URI is not configured');
    throw new Error('MONGO_URI is required');
  }
  
  // Connection options for production
  const options = {
    forceClose: true,
    url: mongoUri,
    maxPoolSize: process.env.NODE_ENV === 'production' ? 50 : 10,
    minPoolSize: process.env.NODE_ENV === 'production' ? 10 : 2,
    maxIdleTimeMS: 30000,
    socketTimeoutMS: 45000,
    serverSelectionTimeoutMS: 30000,
    connectTimeoutMS: 30000,
    retryWrites: true,
    w: 'majority'
  };
  
  try {
    await fastify.register(fastifyMongodb, options);
    
    // Test connection
    await fastify.mongo.db.command({ ping: 1 });
    fastify.log.info(`MongoDB connected successfully to ${mongoUri.split('@')[1] || mongoUri}`);
    
    // Create indexes for better performance
    try {
      await fastify.mongo.db.collection('contacts').createIndex({ epicorId: 1 }, { unique: true });
      await fastify.mongo.db.collection('customers').createIndex({ epicorId: 1 }, { unique: true });
      await fastify.mongo.db.collection('orders').createIndex({ epicorId: 1 }, { unique: true });
      await fastify.mongo.db.collection('quotes').createIndex({ epicorId: 1 }, { unique: true });
      await fastify.mongo.db.collection('line_items').createIndex({ epicorId: 1 }, { unique: true });
      await fastify.mongo.db.collection('sync_logs').createIndex({ syncType: 1, createdAt: -1 });
      
      fastify.log.debug('MongoDB indexes created');
    } catch (indexError) {
      fastify.log.warn(`Could not create MongoDB indexes: ${indexError.message}`);
    }
    
  } catch (error) {
    fastify.log.error(`MongoDB connection failed: ${error.message}`);
    throw error;
  }
};

export default fp(mongoDBConfiguration, {
  name: 'mongo',
  dependencies: ['appConfig'],
});