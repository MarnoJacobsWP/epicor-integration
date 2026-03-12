import fp from 'fastify-plugin';
import { toUnixSeconds } from '../../../utils/dateHelper.js';

async function syncService(fastify, _) {
  // ── Mutex ──────────────────────────────────────────────────────
  let syncRunning = false;

  async function updateDataBase(filter, data) {
    return await fastify.syncRepository.updateDatabase(filter, data);
  }

  async function createDataBase(data) {
    return await fastify.syncRepository.insertDatabase(data);
  }

  // ── Cursor helpers ─────────────────────────────────────────────
  /**
   * Return a Unix-seconds timestamp for a given sync type.
   * Priority: stored cursor → dateString fallback → now-5 min.
   */
  async function resolveTimestamp(syncType, dateStringFallback) {
    const cursor = await fastify.syncRepository.getSyncCursor(syncType);
    if (cursor) {
      fastify.log.info(`Using stored cursor for ${syncType}: ${cursor}`);
      return cursor;
    }
    const ts = toUnixSeconds(dateStringFallback);
    fastify.log.info(`No cursor for ${syncType}, falling back to computed timestamp: ${ts}`);
    return ts;
  }

  /**
   * Persist the current Unix-seconds time as the cursor so the next
   * run picks up where this one started.
   */
  async function advanceCursor(syncType) {
    const now = Math.floor(Date.now() / 1000);
    await fastify.syncRepository.setSyncCursor(syncType, now);
    fastify.log.info(`Advanced ${syncType} cursor to ${now}`);
  }

  async function getSyncStatus() {
    const syncTypes = ['contacts', 'customers', 'orders', 'quotes', 'full'];
    const status = {};

    for (const syncType of syncTypes) {
      const lastSync = await fastify.syncRepository.findLastSync(syncType);
      const cursor  = await fastify.syncRepository.getSyncCursor(syncType);
      status[syncType] = lastSync ? {
        lastRun: lastSync.createdAt,
        status: lastSync.status,
        recordsProcessed: lastSync.recordsProcessed,
        errors: lastSync.errors,
        cursor: cursor ?? null,
      } : { lastRun: null, status: 'never_run', cursor: cursor ?? null };
    }

    return status;
  }

  async function runFullSync(dateString) {
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
        const customerTs = await resolveTimestamp('customers', dateString);
        fastify.log.info('Starting customers sync...');
        results.customers = await fastify.customerTask.task(customerTs);
        syncLog.recordsProcessed += results.customers?.syncedCount || 0;
        syncLog.errors += results.customers?.errorCount || 0;
        await advanceCursor('customers');
      } catch (error) {
        fastify.log.error(`Customers sync failed: ${error.message}`);
        syncLog.errors++;
      }

      // Quotes phase: Quotes → QuoteProdMix → QSeatEtab (handled within quoteTask)
      try {
        const quoteTs = await resolveTimestamp('quotes', dateString);
        fastify.log.info('Starting quotes sync...');
        results.quotes = await fastify.quoteTask.task(quoteTs);
        syncLog.recordsProcessed += results.quotes?.syncedCount || 0;
        syncLog.errors += results.quotes?.errorCount || 0;
        await advanceCursor('quotes');
      } catch (error) {
        fastify.log.error(`Quotes sync failed: ${error.message}`);
        syncLog.errors++;
      }

      // Orders phase: Orders → OrderProdMix → QSeatEtab (handled within orderTask)
      // Must run AFTER quotes are fully complete
      try {
        const orderTs = await resolveTimestamp('orders', dateString);
        fastify.log.info('Starting orders sync...');
        results.orders = await fastify.orderTask.task(orderTs);
        syncLog.recordsProcessed += results.orders?.syncedCount || 0;
        syncLog.errors += results.orders?.errorCount || 0;
        await advanceCursor('orders');
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
      resolveTimestamp,
      advanceCursor,
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