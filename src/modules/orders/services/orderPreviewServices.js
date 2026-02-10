import fp from 'fastify-plugin';

const parseTimestamp = (value) => {
  if (value === undefined || value === null || value === '') return null;

  const numeric = Number(value);
  if (!Number.isNaN(numeric) && Number.isFinite(numeric)) {
    return Math.floor(numeric);
  }

  const parsed = Date.parse(value);
  if (!Number.isNaN(parsed)) {
    return Math.floor(parsed / 1000);
  }

  return null;
};

async function orderPreviewService(fastify) {
  if (fastify.hasDecorator('orderPreviewRoutes')) {
    return;
  }

  fastify.decorate('orderPreviewRoutes', true);

  fastify.get('/test/orders', async (request, reply) => {
    const { ENDPOINTS, FILTER_TIMESTAMP } = fastify.constants;
    const requestedTimestamp = parseTimestamp(request.query?.timestamp);

    if (request.query?.timestamp && requestedTimestamp === null) {
      return reply.status(400).send({
        success: false,
        message: 'Invalid timestamp. Use epoch seconds or an ISO date string.'
      });
    }

    const effectiveTimestamp = requestedTimestamp ?? FILTER_TIMESTAMP;

    fastify.log.info(`Test Orders fetch using timestamp ${effectiveTimestamp}`);

    const { records, metadata } = await fastify.epicorAdapter.fetchFilteredRecords(
      ENDPOINTS.ORDERS,
      effectiveTimestamp
    );

    return {
      success: true,
      timestamp: effectiveTimestamp,
      metadata,
      records
    };
  });
}

export default fp(orderPreviewService, {
  name: 'orderPreviewServices',
  dependencies: ['epicorAdapter', 'constants'],
});
