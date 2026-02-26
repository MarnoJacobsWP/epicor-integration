import fp from 'fastify-plugin';

async function syncService(fastify, _) {
  async function updateDataBase(filter, data) {
    return await fastify.syncRepository.updateDatabase(filter, data);
  }

  async function createDataBase(data) {
    return await fastify.syncRepository.insertDatabase(data);
  }

  async function getSyncStatus() {
    const syncTypes = ['contacts', 'customers', 'orders', 'quotes', 'full'];
    const status = {};

    for (const syncType of syncTypes) {
      const lastSync = await fastify.syncRepository.findLastSync(syncType);
      status[syncType] = lastSync ? {
        lastRun: lastSync.createdAt,
        status: lastSync.status,
        recordsProcessed: lastSync.recordsProcessed,
        errors: lastSync.errors
      } : { lastRun: null, status: 'never_run' };
    }

    return status;
  }

  async function runFullSync(dateString) {
    const syncLog = {
      syncType: 'full',
      startTime: new Date(),
      status: 'running',
      recordsProcessed: 0,
      errors: 0
    };

    try {
      const createdLog = await createDataBase(syncLog);
      syncLog._id = createdLog.insertedId;

      const results = {
        customers: null,
        quotes: null,
        quoteProdMix: null,
        orders: null,
        orderProdMix: null,
      };

      try {
        fastify.log.info('Starting customers sync...');
        results.customers = await fastify.customerTask.task(dateString);
        syncLog.recordsProcessed += results.customers?.syncedCount || 0;
        syncLog.errors += results.customers?.errorCount || 0;
      } catch (error) {
        fastify.log.error(`Customers sync failed: ${error.message}`);
        syncLog.errors++;
      }

      try {
        fastify.log.info('Starting quotes sync...');
        results.quotes = await fastify.quoteTask.task(dateString);
        syncLog.recordsProcessed += results.quotes?.syncedCount || 0;
        syncLog.errors += results.quotes?.errorCount || 0;
      } catch (error) {
        fastify.log.error(`Quotes sync failed: ${error.message}`);
        syncLog.errors++;
      }

      try {
        fastify.log.info('Starting QuoteProdMix independent trigger...');
        results.quoteProdMix = await fastify.quoteProdMixService.task(dateString);
        syncLog.recordsProcessed += results.quoteProdMix?.synced || 0;
        syncLog.errors += results.quoteProdMix?.errors || 0;
      } catch (error) {
        fastify.log.error(`QuoteProdMix trigger failed: ${error.message}`);
        syncLog.errors++;
      }

      try {
        fastify.log.info('Starting orders sync...');
        results.orders = await fastify.orderTask.task(dateString);
        syncLog.recordsProcessed += results.orders?.syncedCount || 0;
        syncLog.errors += results.orders?.errorCount || 0;
      } catch (error) {
        fastify.log.error(`Orders sync failed: ${error.message}`);
        syncLog.errors++;
      }

      try {
        fastify.log.info('Starting OrderProdMix independent trigger...');
        results.orderProdMix = await fastify.orderProdMixService.task(dateString);
        syncLog.recordsProcessed += results.orderProdMix?.synced || 0;
        syncLog.errors += results.orderProdMix?.errors || 0;
      } catch (error) {
        fastify.log.error(`OrderProdMix trigger failed: ${error.message}`);
        syncLog.errors++;
      }

      syncLog.endTime = new Date();
      syncLog.status = 'completed';
      syncLog.durationMs = syncLog.endTime - syncLog.startTime;
      syncLog.results = results;

      await updateDataBase(
        { _id: syncLog._id },
        {
          endTime: syncLog.endTime,
          status: syncLog.status,
          durationMs: syncLog.durationMs,
          recordsProcessed: syncLog.recordsProcessed,
          errors: syncLog.errors,
          results: syncLog.results
        }
      );

      fastify.log.info(`Full sync completed in ${syncLog.durationMs}ms. Processed ${syncLog.recordsProcessed} records with ${syncLog.errors} errors.`);

      return {
        success: true,
        durationMs: syncLog.durationMs,
        recordsProcessed: syncLog.recordsProcessed,
        errors: syncLog.errors,
        results
      };
    } catch (error) {
      syncLog.status = 'failed';
      syncLog.error = error.message;
      syncLog.endTime = new Date();

      if (syncLog._id) {
        await updateDataBase(
          { _id: syncLog._id },
          {
            endTime: syncLog.endTime,
            status: syncLog.status,
            error: syncLog.error
          }
        );
      }

      fastify.log.error(`Full sync failed: ${error.message}`);
      throw error;
    }
  }

  async function task(dateString) {
    try {
      fastify.log.info('Processing full sync');
      return await runFullSync(dateString);
    } catch (error) {
      fastify.log.error(`Error processing full sync - ${error.message}`);
      throw error;
    }
  }

  if (!fastify.hasDecorator('syncService')) {
    fastify.decorate('syncService', {
      getSyncStatus,
      runFullSync,
      task,
    });
  }
}

export default fp(syncService, {
  name: 'syncService',
  dependencies: [
    'syncRepository',
    'contactServices',
    'customerServices',
    'orderServices',
    'quoteServices',
    'orderProdMixService',
    'quoteProdMixService',
  ],
});