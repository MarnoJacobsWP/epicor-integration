import AutoLoad from '@fastify/autoload';
import Sensible from '@fastify/sensible';
import UnderPressure from '@fastify/under-pressure';
import { join } from 'desm';
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
      'sync',
      'system',
      'epicorExport'
    ];

    for (const moduleName of modules) {
      if (fastify[`${moduleName}Task`] || fastify[`${moduleName}Service`]) {
        fastify.log.debug(`Module ${moduleName} already loaded, skipping...`);
        continue;
      }
      const { default: modulePlugin } = await import(`./modules/${moduleName}/index.js`);
      await fastify.register(modulePlugin, { ...opts });
    }

    fastify.log.info('Epicor Integration API initialized successfully');
  } catch (error) {
    fastify.log.error(`Error initializing application: ${error.message}`);
    throw error;
  }
}