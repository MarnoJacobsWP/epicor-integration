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

  // ── Cursor helpers ─────────────────────────────────────────────
  /**
   * Return a Unix-seconds timestamp for a given sync type.
   *
   * Uses the EARLIER of:
   *   • the stored cursor (important when the server was down > LOOKBACK_BUFFER)
   *   • now − LOOKBACK_BUFFER (ensures a rolling overlap every run)
   *
   * If no cursor exists yet, falls back to dateStringFallback → now-5 min.
   */
  async function resolveTimestamp(syncType, dateStringFallback) {
    const lookbackTs = Math.floor(Date.now() / 1000) - LOOKBACK_BUFFER;
    const cursor = await fastify.syncRepository.getSyncCursor(syncType);

    if (cursor) {
      const effective = Math.min(cursor, lookbackTs);
      fastify.log.info(
        `Cursor for ${syncType}: stored=${cursor}, lookback=${lookbackTs}, using=${effective} (${new Date(effective * 1000).toISOString()})`,
      );
      return effective;
    }

    const ts = toUnixSeconds(dateStringFallback);
    const effective = Math.min(ts, lookbackTs);
    fastify.log.info(
      `No cursor for ${syncType}, fallback=${ts}, lookback=${lookbackTs}, using=${effective} (${new Date(effective * 1000).toISOString()})`,
    );
    return effective;
  }

  /**
   * Persist a Unix-seconds timestamp as the cursor so the next run
   * picks up from that point.  The cursor only moves forward — if
   * the supplied value is older than the stored cursor, it is a no-op.
   *
   * @param {string} syncType  e.g. 'customers', 'orders', 'quotes'
   * @param {number} [timestamp]  Unix-seconds value; defaults to now.
   */
  async function advanceCursor(syncType, timestamp) {
    const ts = timestamp ?? Math.floor(Date.now() / 1000);
    const currentCursor = await fastify.syncRepository.getSyncCursor(syncType);
    if (currentCursor && currentCursor >= ts) {
      fastify.log.debug(`Cursor for ${syncType} already at ${currentCursor}, not regressing to ${ts}`);
      return;
    }
    await fastify.syncRepository.setSyncCursor(syncType, ts);
    fastify.log.info(`Advanced ${syncType} cursor to ${ts} (${new Date(ts * 1000).toISOString()})`);
  }

  /**
   * Decide how to advance the cursor after a sync run for a given entity.
   *
   * • If records were successfully synced (created + updated > 0):
   *   advance to the max Calculated_Time from the fetched data.
   *   This ensures the cursor tracks what we've actually seen, not
   *   the wall-clock time — so records with older Calculated_Time
   *   values are never skipped.
   *
   * • If records were fetched but ALL failed HubSpot processing:
   *   do NOT advance — those records need to be retried.
   *
   * • If no records were returned by Epicor:
   *   advance to (now − LOOKBACK_BUFFER) so the cursor keeps moving
   *   forward without jumping past the safety overlap zone.
   */
  async function advanceCursorFromResult(syncType, result) {
    const actuallyProcessed = (result?.createdCount || 0) + (result?.updatedCount || 0);

    if (actuallyProcessed > 0 && result?.maxCalcTime > 0) {
      fastify.log.info(`${syncType}: ${actuallyProcessed} records synced, advancing cursor to maxCalcTime=${result.maxCalcTime}`);
      await advanceCursor(syncType, result.maxCalcTime);
      return;
    }

    if (result?.syncedCount > 0 && actuallyProcessed === 0) {
      fastify.log.warn(`${syncType}: ${result.syncedCount} records fetched but 0 synced to HubSpot — cursor NOT advanced`);
      return;
    }

    // No records returned by Epicor — safe to advance to the lookback boundary
    const lookbackTs = Math.floor(Date.now() / 1000) - LOOKBACK_BUFFER;
    fastify.log.info(`${syncType}: No records found, advancing cursor to lookback boundary ${lookbackTs}`);
    await advanceCursor(syncType, lookbackTs);
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
        fastify.log.info(`Starting customers sync (query ts: ${customerTs})...`);
        results.customers = await fastify.customerTask.task(customerTs);
        syncLog.recordsProcessed += results.customers?.syncedCount || 0;
        syncLog.errors += results.customers?.errorCount || 0;
        if (!skipCursor) await advanceCursorFromResult('customers', results.customers);
      } catch (error) {
        fastify.log.error(`Customers sync failed: ${error.message}`);
        syncLog.errors++;
      }

      // Quotes phase: Quotes → QuoteProdMix → QSeatEtab (handled within quoteTask)
      try {
        const quoteTs = await getTimestamp('quotes', dateString);
        fastify.log.info(`Starting quotes sync (query ts: ${quoteTs})...`);
        results.quotes = await fastify.quoteTask.task(quoteTs);
        syncLog.recordsProcessed += results.quotes?.syncedCount || 0;
        syncLog.errors += results.quotes?.errorCount || 0;
        if (!skipCursor) await advanceCursorFromResult('quotes', results.quotes);
      } catch (error) {
        fastify.log.error(`Quotes sync failed: ${error.message}`);
        syncLog.errors++;
      }

      // Orders phase: Orders → OrderProdMix → QSeatEtab (handled within orderTask)
      // Must run AFTER quotes are fully complete
      try {
        const orderTs = await getTimestamp('orders', dateString);
        fastify.log.info(`Starting orders sync (query ts: ${orderTs})...`);
        results.orders = await fastify.orderTask.task(orderTs);
        syncLog.recordsProcessed += results.orders?.syncedCount || 0;
        syncLog.errors += results.orders?.errorCount || 0;
        if (!skipCursor) await advanceCursorFromResult('orders', results.orders);
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
      advanceCursorFromResult,
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