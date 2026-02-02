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
        fastify.log.debug(`HTTP Request: ${config.method?.toUpperCase()} ${config.url}`);
        return config;
      },
      (error) => {
        fastify.log.error('HTTP Request Error:', error.message);
        return Promise.reject(error);
      }
    );

    // Add response interceptor for logging
    httpClient.interceptors.response.use(
      (response) => {
        fastify.log.debug(`HTTP Response: ${response.status} ${response.config.url}`);
        return response;
      },
      (error) => {
        fastify.log.error('HTTP Response Error:', {
          url: error.config?.url,
          method: error.config?.method,
          status: error.response?.status,
          message: error.message
        });
        return Promise.reject(error);
      }
    );

    fastify.decorate('httpClient', httpClient);
  },
  { name: 'httpClient' }
);