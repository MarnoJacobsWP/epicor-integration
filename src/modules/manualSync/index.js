import fp from 'fastify-plugin';

/**
 * Manual Sync Module
 *
 * Provides a single POST /manualSync route that accepts specific
 * Order Numbers and/or Quote Numbers, fetches them from Epicor,
 * and processes them through the exact same pipeline used by the
 * automated sync (orders → processOrdersIndividually,
 * quotes → processQuotesIndividually).
 *
 * ── Usage ──────────────────────────────────────────────────────
 * Edit the ORDER_NUMS and QUOTE_NUMS arrays below, then hit the
 * route.  If an array is empty it is simply skipped.
 */

// ─── CONFIGURE THESE ───────────────────────────────────────────
const ORDER_NUMS = [
  205840,205839,205836,205830,205827
];

const QUOTE_NUMS = [

];

// Customer IDs (CustID) or Customer Numbers (CustNum) to target
const CUSTOMER_IDS = [
];
// ───────────────────────────────────────────────────────────────

export default fp(
  async function manualSync(fastify, _opts) {
    const { ENDPOINTS } = fastify.constants;

    /**
     * Fetch order records from Epicor for specified order numbers
     * and run them through the standard order processing pipeline.
     */
    async function processManualOrders(orderNums) {
      if (!orderNums.length) {
        return { skipped: true, message: 'No order numbers provided' };
      }

      fastify.log.info(`Manual sync: fetching ${orderNums.length} order(s) from Epicor...`);

      const allRecords = [];

      for (const orderNum of orderNums) {
        try {
          const { records } = await fastify.epicorAdapter.fetchRelatedRecords(
            ENDPOINTS.ORDERS,
            'OrderHed_OrderNum',
            orderNum,
          );

          if (records?.length) {
            allRecords.push(...records);
            fastify.log.info(`Manual sync: Order ${orderNum} — fetched ${records.length} record(s)`);
          } else {
            fastify.log.warn(`Manual sync: Order ${orderNum} — no records returned from Epicor`);
          }
        } catch (error) {
          fastify.log.error(`Manual sync: Order ${orderNum} Epicor fetch failed: ${error.message}`);
        }
      }

      if (!allRecords.length) {
        return { success: false, message: 'No order records found in Epicor' };
      }

      // Deduplicate – keep latest per OrderNum
      const orderMap = new Map();
      for (const record of allRecords) {
        const num = record.OrderHed_OrderNum;
        const existing = orderMap.get(num);
        if (!existing || record.Calculated_Time > existing.Calculated_Time) {
          orderMap.set(num, record);
        }
      }

      const uniqueRecords = Array.from(orderMap.values());
      fastify.log.info(`Manual sync: ${uniqueRecords.length} unique order(s) to process`);

      const results = { total: uniqueRecords.length, created: 0, updated: 0, errors: 0, skipped: 0 };
      await fastify.orderTask.processOrdersIndividually(uniqueRecords, results);

      fastify.log.info(
        `Manual order sync complete: ${results.created} created, ${results.updated} updated, ${results.errors} errors`,
      );

      return { success: true, ...results };
    }

    /**
     * Fetch quote records from Epicor for specified quote numbers
     * and run them through the standard quote processing pipeline.
     */
    async function processManualQuotes(quoteNums) {
      if (!quoteNums.length) {
        return { skipped: true, message: 'No quote numbers provided' };
      }

      fastify.log.info(`Manual sync: fetching ${quoteNums.length} quote(s) from Epicor...`);

      const allRecords = [];

      for (const quoteNum of quoteNums) {
        try {
          const { records } = await fastify.epicorAdapter.fetchRelatedRecords(
            ENDPOINTS.QUOTES,
            'QuoteHed_QuoteNum',
            quoteNum,
          );

          if (records?.length) {
            allRecords.push(...records);
            fastify.log.info(`Manual sync: Quote ${quoteNum} — fetched ${records.length} record(s)`);
          } else {
            fastify.log.warn(`Manual sync: Quote ${quoteNum} — no records returned from Epicor`);
          }
        } catch (error) {
          fastify.log.error(`Manual sync: Quote ${quoteNum} Epicor fetch failed: ${error.message}`);
        }
      }

      if (!allRecords.length) {
        return { success: false, message: 'No quote records found in Epicor' };
      }

      // Deduplicate – keep latest per QuoteNum
      const quoteMap = new Map();
      for (const record of allRecords) {
        const num = record.QuoteHed_QuoteNum;
        const existing = quoteMap.get(num);
        if (!existing || record.Calculated_Time > existing.Calculated_Time) {
          quoteMap.set(num, record);
        }
      }

      const uniqueRecords = Array.from(quoteMap.values());
      fastify.log.info(`Manual sync: ${uniqueRecords.length} unique quote(s) to process`);

      const results = { total: uniqueRecords.length, created: 0, updated: 0, errors: 0, skipped: 0 };
      await fastify.quoteTask.processQuotesIndividually(uniqueRecords, results);

      fastify.log.info(
        `Manual quote sync complete: ${results.created} created, ${results.updated} updated, ${results.errors} errors`,
      );

      return { success: true, ...results };
    }

    /**
     * Fetch customer records from Epicor for specified Customer IDs
     * or Customer Numbers and run them through the standard customer
     * processing pipeline.
     *
     * Each value is tried against both Customer_CustID and
     * Customer_CustNum so you can pass either identifier.
     */
    async function processManualCustomers(customerIds) {
      if (!customerIds.length) {
        return { skipped: true, message: 'No customer IDs provided' };
      }

      fastify.log.info(`Manual sync: fetching ${customerIds.length} customer(s) from Epicor...`);

      // Pull the full customer dataset (no per-record filter field exists
      // in the BAQ), then cherry-pick the requested IDs.
      let allEpicorCustomers;
      try {
        const { records } = await fastify.epicorAdapter.fetchAllRecords(ENDPOINTS.CUSTOMERS);
        allEpicorCustomers = records || [];
      } catch (error) {
        fastify.log.error(`Manual sync: Epicor customer fetch failed: ${error.message}`);
        return { success: false, message: `Epicor fetch failed: ${error.message}` };
      }

      if (!allEpicorCustomers.length) {
        return { success: false, message: 'No customer records returned from Epicor' };
      }

      // Normalize the requested IDs for comparison
      const requestedSet = new Set(customerIds.map((id) => String(id).trim()));

      const matched = allEpicorCustomers.filter((c) => {
        const custId = String(c.Customer_CustID ?? '').trim();
        const custNum = String(c.Customer_CustNum ?? '').trim();
        return requestedSet.has(custId) || requestedSet.has(custNum);
      });

      if (!matched.length) {
        fastify.log.warn(
          `Manual sync: None of the requested customer IDs [${[...requestedSet].join(', ')}] were found in Epicor`,
        );
        return {
          success: false,
          message: 'No matching customer records found in Epicor',
          requestedIds: [...requestedSet],
        };
      }

      // Deduplicate – keep latest per CustID
      const customerMap = new Map();
      for (const record of matched) {
        const key = String(record.Customer_CustID || record.Customer_CustNum).trim();
        const existing = customerMap.get(key);
        if (!existing || record.Calculated_Time > existing.Calculated_Time) {
          customerMap.set(key, record);
        }
      }

      const uniqueRecords = Array.from(customerMap.values());
      fastify.log.info(`Manual sync: ${uniqueRecords.length} unique customer(s) to process`);

      const results = { total: uniqueRecords.length, created: 0, updated: 0, errors: 0, skipped: 0 };
      await fastify.customerTask.processCustomersIndividually(uniqueRecords, results);

      fastify.log.info(
        `Manual customer sync complete: ${results.created} created, ${results.updated} updated, ${results.errors} errors`,
      );

      return { success: true, ...results };
    }

    // ── Route ───────────────────────────────────────────────────
    fastify.post('/manualSync', async (request, reply) => {
      try {
        // Allow overriding via request body, fall back to hard-coded arrays
        const orderNums = request.body?.orderNums ?? ORDER_NUMS;
        const quoteNums = request.body?.quoteNums ?? QUOTE_NUMS;
        const customerIds = request.body?.customerIds ?? CUSTOMER_IDS;

        fastify.log.info(
          `Manual sync triggered — Orders: [${orderNums.join(', ')}], Quotes: [${quoteNums.join(', ')}], Customers: [${customerIds.join(', ')}]`,
        );

        const [orderResults, quoteResults, customerResults] = await Promise.all([
          processManualOrders(orderNums),
          processManualQuotes(quoteNums),
          processManualCustomers(customerIds),
        ]);

        return {
          success: true,
          orders: orderResults,
          quotes: quoteResults,
          customers: customerResults,
        };
      } catch (error) {
        fastify.log.error(`Manual sync failed: ${error.message}`);
        return reply.status(500).send({
          success: false,
          error: error.message,
        });
      }
    });

    fastify.log.info('ManualSync module loaded');
  },
  {
    name: 'manualSync',
    dependencies: [
      'customers',
      'orders',
      'quotes',
      'epicorAdapter',
      'hubspotAdapter',
      'backoff',
      'constants',
    ],
  },
);
