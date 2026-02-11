import axios from 'axios';
import fp from 'fastify-plugin';
import https from 'node:https';

export default fp(
  async (fastify) => {
    const allowInsecureTls = fastify.config?.ALLOW_INSECURE_TLS === true;
    const httpsAgent = new https.Agent({
      rejectUnauthorized: !allowInsecureTls,
    });

    if (allowInsecureTls) {
      fastify.log.warn('TLS certificate verification is disabled for outbound requests');
    }

    const httpClient = axios.create({
      httpsAgent,
      timeout: 30000,
      maxContentLength: 50 * 1024 * 1024,
    });

    // Add request interceptor for logging
    httpClient.interceptors.request.use(
      (config) => {
        fastify.log.debug(`HTTP request: ${config.method?.toUpperCase()} ${config.url}`);
        return config;
      },
      (error) => {
        fastify.log.error(`HTTP request error: ${error.message}`);
        return Promise.reject(error);
      }
    );

    // Add response interceptor for logging
    httpClient.interceptors.response.use(
      (response) => {
        fastify.log.debug(`HTTP response: ${response.status} ${response.config.url}`);
        return response;
      },
      (error) => {
        fastify.log.error(
          `HTTP response error: ${error.config?.method?.toUpperCase() || 'UNKNOWN'} ${error.config?.url || 'unknown'} - ${error.response?.status || 'unknown'} ${error.response?.statusText || ''} - ${error.message}`,
        );
        return Promise.reject(error);
      }
    );

    fastify.decorate('httpClient', httpClient);
  },
  { name: 'httpClient' }
);