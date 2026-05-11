import fastifyEnv from '@fastify/env';
import fp from 'fastify-plugin';

export default fp(
  async (fastify) => {
    await fastify.register(fastifyEnv, {
      confKey: 'config',
      schema: fastify.getSchema('schema:config:env'),
      dotenv: true,
    });

    fastify.log.info({
      cwd: process.cwd(),
      nodeEnv: fastify.config?.NODE_ENV || null,
      baseUrlConfigured: Boolean(fastify.config?.BASE_URL),
      hubspotTokenConfigured: Boolean(fastify.config?.HUBSPOT_ACCESS_TOKEN),
      mongoConfigured: Boolean(fastify.config?.MONGO_URI),
      epicorQuotePdfUrlConfigured: Boolean(fastify.config?.EPICOR_QUOTE_PDF_URL),
      epicorSalesOrderPdfUrlConfigured: Boolean(fastify.config?.EPICOR_SALES_ORDER_PDF_URL),
      epicorCompanyConfigured: Boolean(fastify.config?.EPICOR_COMPANY),
      hubspotFilesFolderPathConfigured: Boolean(fastify.config?.HUBSPOT_FILES_FOLDER_PATH),
      hubspotFilesAccessConfigured: Boolean(fastify.config?.HUBSPOT_FILES_ACCESS),
    }, 'App config loaded');
  },
  { name: 'appConfig' },
);