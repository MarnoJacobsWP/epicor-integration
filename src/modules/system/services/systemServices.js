import fp from 'fastify-plugin';
import os from 'node:os';

const buildMemoryStats = () => {
  const used = process.memoryUsage();
  return {
    rss: `${Math.round(used.rss / 1024 / 1024)}MB`,
    heapTotal: `${Math.round(used.heapTotal / 1024 / 1024)}MB`,
    heapUsed: `${Math.round(used.heapUsed / 1024 / 1024)}MB`,
    external: `${Math.round(used.external / 1024 / 1024)}MB`,
  };
};

const buildOsStats = () => ({
  platform: process.platform,
  arch: process.arch,
  cpus: os.cpus().length,
});

const getMongoStatus = async (fastify) => {
  if (!fastify.mongo) {
    return 'not_configured';
  }

  try {
    await fastify.mongo.db.command({ ping: 1 });
    return 'connected';
  } catch (error) {
    fastify.log.warn(`Mongo health check failed: ${error.message}`);
    return 'disconnected';
  }
};

const buildServiceStatus = (fastify) => ({
  mongo: fastify.mongo ? 'unknown' : 'not_configured',
  hubspot: fastify.hubspotAdapter ? 'connected' : 'disconnected',
  epicor: fastify.epicorAdapter ? 'connected' : 'disconnected',
});

const computeOverallStatus = (services) => {
  const allHealthy = Object.values(services).every(
    (status) => status === 'connected' || status === 'not_configured',
  );

  return {
    status: allHealthy ? 'healthy' : 'degraded',
    code: allHealthy ? 200 : 503,
  };
};

const buildRootPayload = (fastify) => ({
  status: 'OK',
  service: 'Epicor to HubSpot Integration',
  version: '1.0.0',
  environment: fastify.config?.NODE_ENV,
  timestamp: new Date().toISOString(),
  endpoints: {
    health: '/health',
    syncStatus: '/sync/status',
    syncContacts: 'POST /syncContacts',
    syncCustomers: 'POST /syncCustomers',
    syncOrders: 'POST /syncOrders',
    syncQuotes: 'POST /syncQuotes',
    fullSync: 'POST /sync/all',
  },
});

const buildMetricsPayload = () => ({
  timestamp: new Date().toISOString(),
  nodejs: {
    version: process.version,
    memory: process.memoryUsage(),
    uptime: process.uptime(),
  },
  os: buildOsStats(),
});

const buildHealthPayload = async (fastify) => {
  const services = buildServiceStatus(fastify);
  services.mongo = await getMongoStatus(fastify);

  const overall = computeOverallStatus(services);

  return {
    body: {
      server: 'healthy',
      timestamp: new Date().toISOString(),
      services,
      memory: buildMemoryStats(),
      uptime: `${Math.floor(process.uptime())}s`,
      status: overall.status,
      code: overall.code,
    },
    code: overall.code,
  };
};

export default fp(
  async (fastify) => {
    fastify.decorate('systemService', {
      buildHealthPayload: () => buildHealthPayload(fastify),
      buildRootPayload: () => buildRootPayload(fastify),
      buildMetricsPayload: () => buildMetricsPayload(),
    });
  },
  { name: 'systemServices' },
);
