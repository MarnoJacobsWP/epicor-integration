import fp from 'fastify-plugin';
import { toUnixSeconds } from '../../../utils/dateHelper.js';
import { LOOKBACK_BUFFER } from '../../../config/constants.js';

async function syncService(fastify, _) {
  // ── Mutex ──────────────────────────────────────────────────────
  let syncRunning = false;

  async function updateDataBase(filter, data) {
    return await fastify.syncRepository.updateDatabase(filter, data);
  }

  async function createDataBase(data) {
    return await fastify.syncRepository.insertDatabase(data);
  }

  // ── Timestamp helper ───────────────────────────────────────────
  /**
   * Return a Unix-seconds timestamp = now − LOOKBACK_BUFFER.
   *
   * The integration runs every 5 minutes and always looks back
   * 10 minutes (LOOKBACK_BUFFER = 600s).  This guarantees a
   * 5-minute overlap so no records are ever skipped.
   */
  function getLookbackTimestamp() {
    return Math.floor(Date.now() / 1000) - LOOKBACK_BUFFER;
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
        errors: lastSync.errors,
      } : { lastRun: null, status: 'never_run' };
    }

    const lookbackTs = getLookbackTimestamp();
    status._lookbackTimestamp = lookbackTs;
    status._lookbackISO = new Date(lookbackTs * 1000).toISOString();

    return status;
  }

  async function runFullSync(dateString, { overrideTimestamp } = {}) {
    // ── Guard: prevent overlapping runs ──────────────────────────
    if (syncRunning) {
      fastify.log.warn('Full sync already in progress — skipping this run');
      return { success: false, message: 'Sync already in progress', skipped: true };
    }
    syncRunning = true;

    const syncLog = {
      syncType: 'full',
      startTime: new Date(),
      status: 'running',
      recordsProcessed: 0,
      errors: 0
    };

    // When overrideTimestamp is provided (e.g. /sync/test), use it directly.
    // Otherwise compute now − LOOKBACK_BUFFER.
    const filterTimestamp = overrideTimestamp
      ? toUnixSeconds(overrideTimestamp)
      : getLookbackTimestamp();

    fastify.log.info(
      `Full sync starting with filter timestamp: ${filterTimestamp} (${new Date(filterTimestamp * 1000).toISOString()})`,
    );

    try {
      const createdLog = await createDataBase(syncLog);
      syncLog._id = createdLog.insertedId;

      const results = {
        customers: null,
        orders: null,
        quotes: null,
      };

      // ── Customers ──────────────────────────────────────────────
      try {
        fastify.log.info(`Starting customers sync (filter ts: ${filterTimestamp})...`);
        results.customers = await fastify.customerTask.task(filterTimestamp);
        syncLog.recordsProcessed += results.customers?.syncedCount || 0;
        syncLog.errors += results.customers?.errorCount || 0;
      } catch (error) {
        fastify.log.error(`Customers sync failed: ${error.message}`);
        syncLog.errors++;
      }

      // Quotes phase: Quotes → QuoteProdMix → QSeatEtab (handled within quoteTask)
      try {
        fastify.log.info(`Starting quotes sync (filter ts: ${filterTimestamp})...`);
        results.quotes = await fastify.quoteTask.task(filterTimestamp);
        syncLog.recordsProcessed += results.quotes?.syncedCount || 0;
        syncLog.errors += results.quotes?.errorCount || 0;
      } catch (error) {
        fastify.log.error(`Quotes sync failed: ${error.message}`);
        syncLog.errors++;
      }

      // Orders phase: Orders → OrderProdMix → QSeatEtab (handled within orderTask)
      // Must run AFTER quotes are fully complete
      try {
        fastify.log.info(`Starting orders sync (filter ts: ${filterTimestamp})...`);
        results.orders = await fastify.orderTask.task(filterTimestamp);
        syncLog.recordsProcessed += results.orders?.syncedCount || 0;
        syncLog.errors += results.orders?.errorCount || 0;
      } catch (error) {
        fastify.log.error(`Orders sync failed: ${error.message}`);
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
    } finally {
      syncRunning = false;
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
      getLookbackTimestamp,
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
  ],
});