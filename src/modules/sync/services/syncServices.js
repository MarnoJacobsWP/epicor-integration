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
   * Persist a Unix-seconds timestamp as the cursor so the next run
   * picks up from that point.
   *
   * When `timestamp` is supplied (recommended) the cursor is set to
   * that exact value — typically the moment just *before* the Epicor
   * fetch began.  This eliminates the gap where records modified
   * during processing would be skipped.
   *
   * @param {string} syncType  e.g. 'customers', 'orders', 'quotes'
   * @param {number} [timestamp]  Unix-seconds value; defaults to now.
   */
  async function advanceCursor(syncType, timestamp) {
    const ts = timestamp ?? Math.floor(Date.now() / 1000);
    await fastify.syncRepository.setSyncCursor(syncType, ts);
    fastify.log.info(`Advanced ${syncType} cursor to ${ts} (${new Date(ts * 1000).toISOString()})`);
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

  async function runFullSync(dateString, { skipCursor = false } = {}) {
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

    // When skipCursor is true, use the provided timestamp directly
    // instead of looking up the stored cursor.
    const getTimestamp = skipCursor
      ? async (_syncType, fallback) => {
          const ts = toUnixSeconds(fallback);
          fastify.log.info(`Using provided timestamp (skipCursor): ${ts}`);
          return ts;
        }
      : resolveTimestamp;

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
        const customerTs = await getTimestamp('customers', dateString);
        // Capture the moment before fetching so the cursor covers
        // any records modified while we are processing.
        const customerSyncStart = Math.floor(Date.now() / 1000);
        fastify.log.info(`Starting customers sync (query ts: ${customerTs}, cursor will advance to: ${customerSyncStart})...`);
        results.customers = await fastify.customerTask.task(customerTs);
        syncLog.recordsProcessed += results.customers?.syncedCount || 0;
        syncLog.errors += results.customers?.errorCount || 0;
        if (!skipCursor) await advanceCursor('customers', customerSyncStart);
      } catch (error) {
        fastify.log.error(`Customers sync failed: ${error.message}`);
        syncLog.errors++;
      }

      // Quotes phase: Quotes → QuoteProdMix → QSeatEtab (handled within quoteTask)
      try {
        const quoteTs = await getTimestamp('quotes', dateString);
        const quoteSyncStart = Math.floor(Date.now() / 1000);
        fastify.log.info(`Starting quotes sync (query ts: ${quoteTs}, cursor will advance to: ${quoteSyncStart})...`);
        results.quotes = await fastify.quoteTask.task(quoteTs);
        syncLog.recordsProcessed += results.quotes?.syncedCount || 0;
        syncLog.errors += results.quotes?.errorCount || 0;
        if (!skipCursor) await advanceCursor('quotes', quoteSyncStart);
      } catch (error) {
        fastify.log.error(`Quotes sync failed: ${error.message}`);
        syncLog.errors++;
      }

      // Orders phase: Orders → OrderProdMix → QSeatEtab (handled within orderTask)
      // Must run AFTER quotes are fully complete
      try {
        const orderTs = await getTimestamp('orders', dateString);
        const orderSyncStart = Math.floor(Date.now() / 1000);
        fastify.log.info(`Starting orders sync (query ts: ${orderTs}, cursor will advance to: ${orderSyncStart})...`);
        results.orders = await fastify.orderTask.task(orderTs);
        syncLog.recordsProcessed += results.orders?.syncedCount || 0;
        syncLog.errors += results.orders?.errorCount || 0;
        if (!skipCursor) await advanceCursor('orders', orderSyncStart);
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