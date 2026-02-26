import fp from 'fastify-plugin';
import { reconcileLineItems } from '../../shared/lineItemReconciliation.js';

const toSingleLineText = (value) => {
  if (value == null) return null;
  const text = String(value).trim();
  return text.length ? text : null;
};

const FIELD_MAPPINGS = [
  { epicor: 'OrderDtl_OrderNum', hubspot: 'orderdtl_ordernum', transform: Number },//Sales Order Num
  { epicor: 'ProdGrup_Character01', hubspot: 'prodgrup_character01', transform: toSingleLineText },//Product Group
  { epicor: 'Calculated_Total', hubspot: 'price', transform: Number },//Unit Price
  { epicor: 'RowIdent', hubspot: 'rowident', transform: (v) => v ? String(v).trim() : null },//Row Ident
];

/** Properties fetched from HubSpot for source filtering and comparison. */
const FETCH_PROPERTIES = ['name', 'price', 'orderdtl_ordernum'];

function transformEpicorToHubSpot(epicorRecord) {
  const result = {};
  for (const { epicor, hubspot, transform } of FIELD_MAPPINGS) {
    const value = epicorRecord[epicor];
    if (value != null) {
      const transformed = transform ? transform(value) : value;
      if (transformed != null) result[hubspot] = transformed;
    }
  }
  return result;
}

function buildCleanProperties(epicorRecord) {
  const props = transformEpicorToHubSpot(epicorRecord);
  props.name = props.prodgrup_character01 || 'Unnamed Product';
  props.quantity = 1;

  const clean = {};
  for (const [key, value] of Object.entries(props)) {
    if (value != null) clean[key] = value;
  }
  return clean;
}

function deduplicateEpicorRecords(records) {
  const seen = new Set();
  const unique = [];
  for (const record of records) {
    const key = `${record.ProdGrup_Character01 || ''}|${record.Calculated_Total || ''}|${record.OrderDtl_OrderNum || ''}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(record);
    }
  }
  return unique;
}

/** Filters HubSpot line items to only those originating from OrderProdMix. */
function filterOrderProdMixItems(lineItems) {
  return lineItems.filter((item) => {
    const orderNum = item.properties?.orderdtl_ordernum;
    return orderNum != null && String(orderNum).trim() !== '';
  });
}

async function orderProdMixService(fastify, _) {
  const { ENDPOINTS, HUBSPOT_ASSOCIATIONS } = fastify.constants;

  async function fetchExistingLineItems(dealId) {
    try {
      return await fastify.backoff(() =>
        fastify.hubspotAdapter.getLineItemsForDeal(dealId, FETCH_PROPERTIES)
      );
    } catch (error) {
      fastify.log.warn(`Failed to fetch existing line items for deal ${dealId}: ${error.message}`);
      return [];
    }
  }

  async function deleteHubSpotLineItem(lineItemId) {
    await fastify.backoff(() => fastify.hubspotAdapter.deleteLineItem(lineItemId));
    await fastify.lineItemRepository.deleteDatabase({ hubspotId: String(lineItemId) }).catch(() => {});
  }

  async function createHubSpotLineItem(properties, dealId) {
    const associations = dealId && HUBSPOT_ASSOCIATIONS.LINE_ITEM_TO_DEAL != null
      ? [{
          to: { id: dealId },
          types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: HUBSPOT_ASSOCIATIONS.LINE_ITEM_TO_DEAL }],
        }]
      : [];

    const created = await fastify.backoff(() =>
      fastify.hubspotAdapter.createLineItem({ properties, associations })
    );

    const epicorId = properties.rowident
      || `${properties.orderdtl_ordernum}|${properties.prodgrup_character01 || ''}|${properties.price || ''}`;

    await fastify.lineItemRepository.insertDatabase({
      epicorId: String(epicorId),
      hubspotId: created.id,
      source: 'EpicorOrderProdMix',
      orderNum: properties.orderdtl_ordernum,
      action: 'create',
    }).catch(() =>
      fastify.lineItemRepository.updateDatabase(
        { epicorId: String(epicorId) },
        { hubspotId: created.id, source: 'EpicorOrderProdMix', orderNum: properties.orderdtl_ordernum, action: 'create' },
      ).catch(() => {})
    );

    return created;
  }

  /**
   * Reconciles Epicor OrderProdMix records against HubSpot line items.
   * @param {Array} epicorRecords - Desired Epicor records
   * @param {string} dealId - HubSpot deal ID
   * @param {{ clearAll?: boolean }} options
   *   When clearAll is true, ALL existing line items on the deal are deleted
   *   (regardless of source) before creating OrderProdMix items. Used when
   *   a deal has both a quote and an order — order takes precedence.
   */
  async function reconcileAndSync(epicorRecords, dealId, { clearAll = false } = {}) {
    const results = { created: 0, deleted: 0, unchanged: 0, errors: 0 };

    const desiredItems = epicorRecords.map(buildCleanProperties);
    const allExisting = dealId ? await fetchExistingLineItems(dealId) : [];

    if (clearAll) {
      // Order takes precedence: nuke every line item on the deal, then recreate.
      fastify.log.info(
        `Deal ${dealId}: clearAll mode — removing all ${allExisting.length} existing line items before OrderProdMix sync`
      );

      for (const item of allExisting) {
        try {
          await deleteHubSpotLineItem(item.id);
          results.deleted++;
        } catch (error) {
          fastify.log.error(`Failed to delete line item ${item.id} during clearAll: ${error.message}`);
          results.errors++;
        }
      }

      // After clearing, create every desired item (no reconciliation needed).
      for (const properties of desiredItems) {
        try {
          const created = await createHubSpotLineItem(properties, dealId);
          fastify.log.info(`Created OrderProdMix line item ${created.id} on deal ${dealId}`);
          results.created++;
        } catch (error) {
          fastify.log.error(`Failed to create OrderProdMix line item on deal ${dealId}: ${error.message}`);
          results.errors++;
        }
      }

      fastify.log.info(
        `OrderProdMix clearAll for deal ${dealId}: ${results.created} created, ${results.deleted} deleted, ${results.errors} errors`
      );
      return results;
    }

    // Normal reconciliation: only touch OrderProdMix-sourced items.
    const sourceItems = filterOrderProdMixItems(allExisting);

    fastify.log.info(
      `Deal ${dealId}: ${allExisting.length} total line items, ${sourceItems.length} OrderProdMix, ${desiredItems.length} desired from Epicor`
    );

    const { toCreate, toDelete, unchangedCount } = reconcileLineItems(desiredItems, sourceItems);
    results.unchanged = unchangedCount;

    for (const item of toDelete) {
      try {
        await deleteHubSpotLineItem(item.id);
        fastify.log.info(`Deleted stale OrderProdMix line item ${item.id} from deal ${dealId}`);
        results.deleted++;
      } catch (error) {
        fastify.log.error(`Failed to delete line item ${item.id}: ${error.message}`);
        results.errors++;
      }
    }

    for (const properties of toCreate) {
      try {
        const created = await createHubSpotLineItem(properties, dealId);
        fastify.log.info(`Created OrderProdMix line item ${created.id} on deal ${dealId}`);
        results.created++;
      } catch (error) {
        fastify.log.error(`Failed to create OrderProdMix line item on deal ${dealId}: ${error.message}`);
        results.errors++;
      }
    }

    fastify.log.info(
      `OrderProdMix reconciliation for deal ${dealId}: ${results.created} created, ${results.deleted} deleted, ${results.unchanged} unchanged, ${results.errors} errors`
    );
    return results;
  }

  /**
   * Sync OrderProdMix line items for a single order to a HubSpot deal.
   * @param {number|string} orderNum
   * @param {string} dealId
   * @param {{ clearAll?: boolean }} options - Pass clearAll:true when the deal
   *   has both a quote and an order so order takes precedence.
   */
  async function syncLineItemsForOrder(orderNum, dealId, options = {}) {
    fastify.log.info(`Fetching OrderProdMix line items for order ${orderNum}`);
    const { records, metadata } = await fastify.epicorAdapter.fetchRelatedRecords(
      ENDPOINTS.ORDER_PROD_MIX,
      'OrderDtl_OrderNum',
      orderNum
    );

    const uniqueRecords = records?.length ? deduplicateEpicorRecords(records) : [];

    if (!uniqueRecords.length && !dealId) {
      return { success: true, message: 'No line items for this order', lineItemCount: 0 };
    }

    fastify.log.info(`Found ${records?.length || 0} OrderProdMix records, deduplicated to ${uniqueRecords.length} for order ${orderNum}`);

    const results = await reconcileAndSync(uniqueRecords, dealId, options);

    return {
      success: true,
      lineItemCount: uniqueRecords.length,
      createdCount: results.created,
      deletedCount: results.deleted,
      unchangedCount: results.unchanged,
      errorCount: results.errors,
      metadata,
    };
  }

  /**
   * Independent Calculated_Time trigger for OrderProdMix.
   * Fetches OrderProdMix records that changed recently, groups by order number,
   * finds the corresponding HubSpot deals, and runs reconciliation.
   */
  async function task(dateString) {
    try {
      fastify.log.info('Processing independent OrderProdMix Calculated_Time trigger...');

      const { records, metadata } = await fastify.epicorAdapter.fetchFilteredRecords(
        ENDPOINTS.ORDER_PROD_MIX
      );

      if (!records?.length) {
        fastify.log.info('No recently changed OrderProdMix records found');
        return { success: true, message: 'No OrderProdMix changes detected', metadata };
      }

      // Group records by order number
      const byOrder = new Map();
      for (const record of records) {
        const orderNum = record.OrderDtl_OrderNum;
        if (!orderNum) continue;
        if (!byOrder.has(orderNum)) byOrder.set(orderNum, []);
        byOrder.get(orderNum).push(record);
      }

      fastify.log.info(`OrderProdMix trigger: ${records.length} records across ${byOrder.size} orders`);

      const results = { synced: 0, skipped: 0, errors: 0 };

      for (const [orderNum, orderRecords] of byOrder) {
        try {
          // Find the HubSpot deal for this order
          const searchData = await fastify.backoff(() =>
            fastify.hubspotAdapter.searchDealsByProperty('orderhed_ordernum', [orderNum])
          );
          const deal = searchData.results?.[0];

          if (!deal?.id) {
            fastify.log.debug(`OrderProdMix trigger: No deal found for order ${orderNum}, skipping`);
            results.skipped++;
            continue;
          }

          const dealId = deal.id;
          const uniqueRecords = deduplicateEpicorRecords(orderRecords);

          // Independent trigger: only reconcile OrderProdMix-sourced items.
          // QSeatEtab items are untouched (they have their own source filter).
          await reconcileAndSync(uniqueRecords, dealId);
          fastify.log.info(`OrderProdMix trigger: Reconciled ${uniqueRecords.length} items for order ${orderNum} (deal ${dealId})`);
          results.synced++;
        } catch (error) {
          fastify.log.error(`OrderProdMix trigger failed for order ${orderNum}: ${error.message}`);
          results.errors++;
        }
      }

      fastify.log.info(`OrderProdMix trigger complete: ${results.synced} synced, ${results.skipped} skipped, ${results.errors} errors`);
      return { success: true, ...results, metadata };
    } catch (error) {
      fastify.log.error(`Error processing OrderProdMix trigger: ${error.message}`);
      throw error;
    }
  }

  if (!fastify.hasDecorator('orderProdMixService')) {
    fastify.decorate('orderProdMixService', {
      syncLineItemsForOrder,
      task,
    });
  }
}

export default fp(orderProdMixService, {
  name: 'orderProdMixService',
  dependencies: [
    'lineItemRepository',
    'epicorAdapter',
    'hubspotAdapter',
    'backoff',
    'constants',
  ],
});
