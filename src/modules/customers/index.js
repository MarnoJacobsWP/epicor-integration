import AutoLoad from '@fastify/autoload';
import { join } from 'desm';
import fp from 'fastify-plugin';

export default fp(
  async function customers(fastify, opts) {
    await fastify.register(AutoLoad, {
      dir: join(import.meta.url, 'services'),
      dirNameRoutePrefix: false,
      indexPattern: /.*Services(\.js|\.cjs)$/i,
      options: { ...opts },
    });

    fastify.post('/syncCustomers', async (request, reply) => {
      try {
        const timestamp = await fastify.syncService.resolveTimestamp('customers');
        const syncStart = Math.floor(Date.now() / 1000);
        const result = await fastify.customerTask.task(timestamp);
        if (result?.syncedCount > 0) await fastify.syncService.advanceCursor('customers', syncStart);
        return result;
      } catch (error) {
        fastify.log.error(`Customer sync failed: ${error.message}`);
        return reply.status(500).send({
          success: false,
          error: error.message,
        });
      }
    });

    if (process.env.NODE_ENV !== 'production') {
      fastify.get('/debug/customer/:customerId', async (request, reply) => {
      try {
        const { customerId } = request.params;
        const dateString = fastify.utils?.getSyncDate(fastify.constants.SYNC_INTERVAL) || new Date().toISOString();
        
        const { records } = await fastify.epicorAdapter.fetchFilteredRecords(fastify.constants.ENDPOINTS.CUSTOMERS);
        
        const customer = records.find(c => 
          String(c.Customer_CustID) === customerId || 
          String(c.Customer_CustNum) === customerId
        );
        
        if (!customer) {
          return reply.status(404).send({
            success: false,
            message: `Customer ${customerId} not found`
          });
        }
        
        let properties;
        if (fastify.customerTask.transformEpicorToHubSpot) {
          properties = fastify.customerTask.transformEpicorToHubSpot(customer);
        } else {
          const { transformEpicorToHubSpot } = await import('./services/customerServices.js');
          properties = transformEpicorToHubSpot(customer);
        }
        
        return {
          success: true,
          customerId,
          epicorData: customer,
          hubspotProperties: properties,
          validation: {
            hasId: !!properties.customer_id,
            hasName: !!properties.name,
            allProperties: Object.keys(properties)
          }
        };
        
      } catch (error) {
        fastify.log.error(`Debug customer failed: ${error.message}`);
        return reply.status(500).send({
          success: false,
          error: error.message,
        });
      }
    });
    }

    fastify.log.info('Customers module loaded');
  },
  {
    name: 'customers',
  },
);