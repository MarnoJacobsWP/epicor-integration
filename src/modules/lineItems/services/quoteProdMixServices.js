import fp from 'fastify-plugin';
import { reconcileLineItems } from '../../shared/lineItemReconciliation.js';

const toSingleLineText = (value) => {
  if (value == null) return null;
  const text = String(value).trim();
  return text.length ? text : null;
};

const FIELD_MAPPINGS = [
  { epicor: 'QuoteDtl_QuoteNum', hubspot: 'quotedtl_quotenum', transform: Number },//Quote Num
  { epicor: 'ProdGrup_Character01', hubspot: 'prodgrup_character01', transform: toSingleLineText },//Product Group
  { epicor: 'Calculated_Total', hubspot: 'price', transform: Number },//Unit Price
];
/** Properties fetched from HubSpot for source filtering and comparison. */
const FETCH_PROPERTIES = ['name', 'price', 'quotedtl_quotenum', 'hs_sku'];

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
    const key = `${record.ProdGrup_Character01 || ''}|${record.Calculated_Total || ''}|${record.QuoteDtl_QuoteNum || ''}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(record);
    }
  }
  return unique;
}

/**
 * Filters HubSpot line items to only those originating from QuoteProdMix.
 * Identified by having quotedtl_quotenum set and hs_sku NOT set
 * (QSeatEtab items have hs_sku; OrderProdMix items lack quotedtl_quotenum).
 */
function filterQuoteProdMixItems(lineItems) {
  return lineItems.filter((item) => {
    const props = item.properties || {};
    const quoteNum = props.quotedtl_quotenum;
    const hsSku = props.hs_sku;
    const hasQuoteNum = quoteNum != null && String(quoteNum).trim() !== '';
    const hasSku = hsSku != null && String(hsSku).trim() !== '';
    return hasQuoteNum && !hasSku;
  });
}

async function quoteProdMixService(fastify, _) {
  const { HUBSPOT_ASSOCIATIONS } = fastify.constants;

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

    const epicorId = `${properties.quotedtl_quotenum}|${properties.prodgrup_character01 || ''}|${properties.price || ''}`;

    await fastify.lineItemRepository.insertDatabase({
      epicorId: String(epicorId),
      hubspotId: created.id,
      source: 'EpicorQuoteProdMix',
      quoteNum: properties.quotedtl_quotenum,
      action: 'create',
    }).catch(() =>
      fastify.lineItemRepository.updateDatabase(
        { epicorId: String(epicorId) },
        { hubspotId: created.id, source: 'EpicorQuoteProdMix', quoteNum: properties.quotedtl_quotenum, action: 'create' },
      ).catch(() => {})
    );

    return created;
  }

  async function reconcileAndSync(epicorRecords, dealId) {
    const results = { created: 0, deleted: 0, unchanged: 0, errors: 0 };

    const desiredItems = epicorRecords.map(buildCleanProperties);
    const allExisting = dealId ? await fetchExistingLineItems(dealId) : [];
    const sourceItems = filterQuoteProdMixItems(allExisting);

    fastify.log.info(
      `Deal ${dealId}: ${allExisting.length} total line items, ${sourceItems.length} QuoteProdMix, ${desiredItems.length} desired from Epicor`
    );

    const { toCreate, toDelete, unchangedCount } = reconcileLineItems(desiredItems, sourceItems);
    results.unchanged = unchangedCount;

    for (const item of toDelete) {
      try {
        await deleteHubSpotLineItem(item.id);
        fastify.log.info(`Deleted stale QuoteProdMix line item ${item.id} from deal ${dealId}`);
        results.deleted++;
      } catch (error) {
        fastify.log.error(`Failed to delete line item ${item.id}: ${error.message}`);
        results.errors++;
      }
    }

    for (const properties of toCreate) {
      try {
        const created = await createHubSpotLineItem(properties, dealId);
        fastify.log.info(`Created QuoteProdMix line item ${created.id} on deal ${dealId}`);
        results.created++;
      } catch (error) {
        fastify.log.error(`Failed to create QuoteProdMix line item on deal ${dealId}: ${error.message}`);
        results.errors++;
      }
    }

    fastify.log.info(
      `QuoteProdMix reconciliation for deal ${dealId}: ${results.created} created, ${results.deleted} deleted, ${results.unchanged} unchanged, ${results.errors} errors`
    );
    return results;
  }

  async function syncLineItemsForQuote(quoteNum, dealId) {
    fastify.log.info(`Fetching QuoteProdMix line items for quote ${quoteNum}`);
    const { records } = await fastify.epicorAdapter.fetchRelatedRecords(
      fastify.constants.ENDPOINTS.QUOTE_PROD_MIX,
      'QuoteDtl_QuoteNum',
      quoteNum
    );

    const uniqueRecords = records?.length ? deduplicateEpicorRecords(records) : [];

    if (!uniqueRecords.length && !dealId) {
      return { success: true, message: 'No QuoteProdMix line items for this quote', lineItemCount: 0 };
    }

    fastify.log.info(`Found ${records?.length || 0} QuoteProdMix records, deduplicated to ${uniqueRecords.length} for quote ${quoteNum}`);

    const results = await reconcileAndSync(uniqueRecords, dealId);

    return {
      success: true,
      lineItemCount: uniqueRecords.length,
      createdCount: results.created,
      deletedCount: results.deleted,
      unchangedCount: results.unchanged,
      errorCount: results.errors,
      prodgrupValues: [...new Set(uniqueRecords.map((r) => toSingleLineText(r.ProdGrup_Character01)).filter(Boolean))],
    };
  }

  async function task(dateString) {
    try {
      fastify.log.info('Processing Tasks for Quote Line Items');
      return { success: true, message: 'Quote line items processed by quote service' };
    } catch (error) {
      fastify.log.error(`Error processing Tasks for Quote Line Items: ${error.message}`);
      throw error;
    }
  }

  if (!fastify.hasDecorator('quoteProdMixService')) {
    fastify.decorate('quoteProdMixService', {
      syncLineItemsForQuote,
      task,
    });
  }
}

export default fp(quoteProdMixService, {
  name: 'quoteProdMixService',
  dependencies: [
    'lineItemRepository',
    'epicorAdapter',
    'hubspotAdapter',
    'backoff',
    'constants',
  ],
});
