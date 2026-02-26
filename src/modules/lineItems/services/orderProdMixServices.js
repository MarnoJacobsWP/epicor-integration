import fp from 'fastify-plugin';
import { reconcileLineItems, deduplicateDesiredItems, buildMatchKey } from '../../shared/lineItemReconciliation.js';

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

  async function reconcileAndSync(epicorRecords, dealId) {
    const results = { created: 0, deleted: 0, unchanged: 0, errors: 0 };

    // Deduplicate desired items by Name + Amount before reconciliation
    const rawDesired = epicorRecords.map(buildCleanProperties);
    const desiredItems = deduplicateDesiredItems(rawDesired, (item) => buildMatchKey(item.name, item.price));
    if (rawDesired.length !== desiredItems.length) {
      fastify.log.info(`OrderProdMix: Deduped desired items from ${rawDesired.length} to ${desiredItems.length} by name+amount`);
    }

    const allExisting = dealId ? await fetchExistingLineItems(dealId) : [];
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

  async function syncLineItemsForOrder(orderNum, dealId) {
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

    const results = await reconcileAndSync(uniqueRecords, dealId);

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

  async function task(dateString) {
    try {
      fastify.log.info('Processing Tasks for Order Line Items');
      return { success: true, message: 'Order line items processed by order service' };
    } catch (error) {
      fastify.log.error(`Error processing Tasks for Order Line Items: ${error.message}`);
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
