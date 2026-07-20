import fp from 'fastify-plugin';
import * as core from './core.js';

/**
 * File Audit Module
 *
 * Read-only diagnostics and backfill migrations for the Quote / Sales Order
 * PDFs uploaded to HubSpot Files and referenced from the quote_pdf /
 * sales_order_pdf deal properties. All logic lives in ./core.js so the exact
 * same operations can run from the local CLI (scripts/hubspotBackfill.js)
 * without deploying to Lightsail. Every operation is HubSpot-only.
 *
 * Routes accept optional { dealIds, limit } (JSON body or query string) to scope
 * a run. There is no dry-run: a POST APPLIES the changes immediately.
 *   POST /fileAudit/diagnose       — read-only report (access, folder drift, name issues)
 *   POST /fileAudit/backfillAccess — set files to PUBLIC_NOT_INDEXABLE (in-place PATCH)
 *   POST /fileAudit/fixNames       — repair ".pdf.pdf" -> ".pdf" (in-place rename)
 *   POST /fileAudit/backfillFolder — move files to canonical folder (if drift confirmed)
 */

export default fp(
  async function fileAudit(fastify, _opts) {
    const folders = {
      quotesFolder: fastify.config?.HUBSPOT_FILES_FOLDER_PATH || '/Quotes',
      ordersFolder: fastify.config?.HUBSPOT_SALES_ORDER_FILES_FOLDER_PATH || '/Sales Orders',
    };

    const ctx = {
      adapter: fastify.hubspotAdapter,
      run: (fn, operation) => fastify.backoff(fn, { operation }),
      log: fastify.log,
      // Epicor-backed regeneration (only reachable on Lightsail). Used by
      // core.regenerate to replace files HubSpot refuses to re-visibility.
      regenerateQuote: (quoteNum, dealId, previousFileId) =>
        fastify.quoteTask.regenerateQuotePdf(quoteNum, dealId, previousFileId),
      regenerateOrder: (orderNum, dealId, previousFileId) =>
        fastify.orderTask.regenerateSalesOrderPdf(orderNum, dealId, previousFileId),
    };

    const route = (path, fn) => {
      fastify.post(path, async (request, reply) => {
        // Merge query params with the JSON body so scoping works either way
        // (`?limit=5` or a JSON body). These routes APPLY changes immediately.
        const input = { ...(request.query || {}), ...(request.body || {}) };
        try {
          fastify.log.info(`fileAudit ${path}: APPLYING — input=${JSON.stringify(input)}`);
          return await fn(ctx, folders, input);
        } catch (error) {
          fastify.log.error(`fileAudit ${path} failed: ${error.message}`);
          return reply.status(500).send({ success: false, error: error.message });
        }
      });
    };

    route('/fileAudit/diagnose', core.diagnose);
    route('/fileAudit/backfillAccess', core.backfillAccess);
    route('/fileAudit/fixNames', core.fixNames);
    route('/fileAudit/backfillFolder', core.backfillFolder);
    route('/fileAudit/regenerate', core.regenerate);
    route('/fileAudit/fixPdfNumberMismatch', core.fixPdfNumberMismatch);

    fastify.log.info('FileAudit module loaded');
  },
  {
    name: 'fileAudit',
    dependencies: ['hubspotAdapter', 'backoff', 'quotes', 'orders'],
  },
);
