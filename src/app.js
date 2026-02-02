import AutoLoad from '@fastify/autoload';
import Sensible from '@fastify/sensible';
import UnderPressure from '@fastify/under-pressure';
import { join } from 'desm';
import os from 'node:os';
import * as utils from './utils/dateHelper.js';

export const options = {
  trustProxy: true,
  disableRequestLogging: process.env.NODE_ENV === 'production',
  bodyLimit: parseInt(process.env.BODY_LIMIT) || 1048576,
  requestTimeout: parseInt(process.env.MAX_REQUEST_TIMEOUT) || 60000,
  logger: {
    level: process.env.LOG_LEVEL || 'info',
    transport: process.env.NODE_ENV === 'production' ? undefined : {
      target: 'pino-pretty',
      options: {
        translateTime: 'yyyy-mm-dd HH:MM:ss Z',
        ignore: 'pid,hostname',
      },
    },
    serializers: {
      req(request) {
        return {
          method: request.method,
          url: request.url,
          hostname: request.hostname,
          remoteAddress: request.ip,
          remotePort: request.socket.remotePort,
        };
      },
    },
  },
};

export default async function app(fastify, opts) {
  try {
    // Decorate fastify with utils
    fastify.decorate('utils', utils);

    // Register error handler early
    await fastify.register(import('./plugins/errorHandler.js'));

    // Register Sensible for HTTP utilities
    await fastify.register(Sensible);

    // Register Under Pressure for load handling
    await fastify.register(UnderPressure, {
      maxEventLoopDelay: 1000,
      maxHeapUsedBytes: 1000000000,
      maxRssBytes: 1000000000,
      maxEventLoopUtilization: 0.98,
      exposeStatusRoute: {
        routeOpts: {
          logLevel: 'warn',
        },
        routeSchema: {
          hide: true,
        },
        url: '/pressure',
      },
    });

    // Register rate limiting for production
    if (process.env.NODE_ENV === 'production') {
      await fastify.register(import('./plugins/rateLimit.js'));
    }

    // Load schemas
    await fastify.register(AutoLoad, {
      dir: join(import.meta.url, 'schemas'),
      indexPattern: /^loader.js$/i,
    });

    // Load configuration
    await fastify.register(AutoLoad, {
      dir: join(import.meta.url, 'config'),
      indexPattern: /^no$/i,
      dirNameRoutePrefix: false,
      options: { ...opts },
    });

    // Load plugins
    await fastify.register(AutoLoad, {
      dir: join(import.meta.url, 'plugins'),
      indexPattern: /^no$/i,
      options: { ...opts },
    });

    // Load adapters
    await fastify.register(AutoLoad, {
      dir: join(import.meta.url, 'adapters'),
      indexPattern: /^no$/i,
      options: { ...opts },
    });

    // Load modules
    const modules = [
      'contacts',
      'customers',
      'lineItems',
      'orders',
      'quotes',
      'sync'
    ];

    for (const module of modules) {
      if (fastify[`${module}Task`] || fastify[`${module}Service`]) {
        fastify.log.debug(`Module ${module} already loaded, skipping...`);
        continue;
      }
      await fastify.register(AutoLoad, {
        dir: join(import.meta.url, `modules/${module}`),
        dirNameRoutePrefix: false,
        indexPattern: /.*index(\.js|\.cjs)$/i,
        autohooks: false,
        options: { ...opts },
      });
    }

    fastify.get('/health', async (request, reply) => {
      const checks = {
        server: 'healthy',
        timestamp: new Date().toISOString(),
        services: {}
      };

      // Check MongoDB
      try {
        if (fastify.mongo) {
          await fastify.mongo.db.command({ ping: 1 });
          checks.services.mongo = 'connected';
        } else {
          checks.services.mongo = 'not_configured';
        }
      } catch (error) {
        checks.services.mongo = 'disconnected';
      }

      // Check HubSpot
      checks.services.hubspot = fastify.hubspotAdapter ? 'connected' : 'disconnected';

      // Check Epicor
      checks.services.epicor = fastify.epicorAdapter ? 'connected' : 'disconnected';

      // Check memory usage
      const used = process.memoryUsage();
      checks.memory = {
        rss: `${Math.round(used.rss / 1024 / 1024)}MB`,
        heapTotal: `${Math.round(used.heapTotal / 1024 / 1024)}MB`,
        heapUsed: `${Math.round(used.heapUsed / 1024 / 1024)}MB`,
        external: `${Math.round(used.external / 1024 / 1024)}MB`,
      };

      // Check uptime
      checks.uptime = `${Math.floor(process.uptime())}s`;

      // Determine overall health
      const allHealthy = Object.values(checks.services).every(
        status => status === 'connected' || status === 'not_configured'
      );
      
      checks.status = allHealthy ? 'healthy' : 'degraded';
      checks.code = allHealthy ? 200 : 503;

      return reply.code(checks.code).send(checks);
    });

    // Root endpoint
    fastify.get('/', async (request, reply) => {
      return {
        status: 'OK',
        service: 'Epicor to HubSpot Integration',
        version: '1.0.0',
        environment: process.env.NODE_ENV,
        timestamp: new Date().toISOString(),
        endpoints: {
          health: '/health',
          syncStatus: '/sync/status',
          syncContacts: 'POST /syncContacts',
          syncCustomers: 'POST /syncCustomers',
          syncOrders: 'POST /syncOrders',
          syncQuotes: 'POST /syncQuotes',
          fullSync: 'POST /sync/all'
        }
      };
    });

    // Metrics endpoint for monitoring
    fastify.get('/metrics', async (request, reply) => {
      const metrics = {
        timestamp: new Date().toISOString(),
        nodejs: {
          version: process.version,
          memory: process.memoryUsage(),
          uptime: process.uptime(),
        },
        os: {
          platform: process.platform,
          arch: process.arch,
          cpus: os.cpus().length,
        }
      };
      return metrics;
    });

    fastify.log.info('Epicor Integration API initialized successfully');
  } catch (error) {
    fastify.log.error(`Error initializing application: ${error.message}`);
    console.error('Initialization error:', error);
    throw error;
  }
}