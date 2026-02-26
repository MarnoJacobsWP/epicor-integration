import fp from 'fastify-plugin';
import { reconcileLineItems, buildMatchKey, deduplicateDesiredItems } from '../../shared/lineItemReconciliation.js';

const FIELD_MAPPINGS = [
  { epicor: 'QuoteDtl_QuoteNum', hubspot: 'quotedtl_quotenum', transform: Number },//Quote Num
  { epicor: 'ProdGrup_Description', hubspot: 'prodgrup_description' },//Prod Group
  { epicor: 'QuoteDtl_PartNum', hubspot: 'quotedtl_partnum' },//Part
  { epicor: 'QuoteDtl_LineDesc', hubspot: 'quotedtl_linedesc' },//Product Description
  { epicor: 'QuoteDtl_OrderQty', hubspot: 'quantity', transform: Number },//Quantity
  { epicor: 'RowIdent', hubspot: 'rowident' },//Row Ident
];

/** Properties fetched from HubSpot for source filtering and dedup comparison. */
const FETCH_PROPERTIES = ['name', 'hs_sku', 'quotedtl_quotenum'];
const ALLOWED_PROD_GROUPS = new Set(['E-Tables', 'New Seating']);

/**
 * Custom key functions for QSeatEtab reconciliation.
 * QSeatEtab items use name + hs_sku for matching (they have no price field).
 */
const QSEAT_ETAB_KEY_OPTIONS = {
  desiredKeyFn: (item) => buildMatchKey(item.name, item.hs_sku),
  existingKeyFn: (item) => {
    const props = item.properties || {};
    return buildMatchKey(props.name, props.hs_sku);
  },
};

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

  if (props.prodgrup_description && !ALLOWED_PROD_GROUPS.has(props.prodgrup_description)) {
    delete props.prodgrup_description;
  }

  props.name = props.prodgrup_description || 'Unnamed Product';
  props.hs_sku = props.quotedtl_partnum;
  props.description = props.quotedtl_linedesc;

  const clean = {};
  for (const [key, value] of Object.entries(props)) {
    if (value != null) clean[key] = value;
  }
  return clean;
}

/**
 * Filters HubSpot line items to only those originating from QSeatEtab.
 * QSeatEtab items are identified by having hs_sku set
 * (QuoteProdMix items lack hs_sku; OrderProdMix items lack quotedtl_quotenum).
 */
function filterQSeatEtabItems(lineItems) {
  return lineItems.filter((item) => {
    const hsSku = item.properties?.hs_sku;
    return hsSku != null && String(hsSku).trim() !== '';
  });
}

function isEntitySetDescriptor(records) {
  return records.length === 1
    && records[0]?.url === 'Data'
    && records[0]?.kind === 'EntitySet';
}

async function fetchQSeatEtabRecordsForQuote(fastify, quoteNum) {
  const endpoint = fastify.constants.ENDPOINTS.QSEAT_ETAB;
  const baseUrl = String(fastify.config?.BASE_URL || '').replace(/\/+$/, '');
  const normalizedQuoteNum = String(quoteNum ?? '').trim();

  if (!endpoint || !baseUrl || !normalizedQuoteNum) {
    throw new Error('Missing endpoint, base URL, or quote number for QSeatEtab fetch');
  }

  const encodedQuoteNum = encodeURIComponent(normalizedQuoteNum);
  const candidateUrls = [
    `${baseUrl}/${endpoint}(68138)/Data?QuoteNum=${encodedQuoteNum}`,
    `${baseUrl}/${endpoint}(68138)/Data/?QuoteNum=${encodedQuoteNum}`,
    `${baseUrl}/${endpoint}(68138)/?QuoteNum=${encodedQuoteNum}`,
  ];

  let lastError = null;

  for (const url of candidateUrls) {
    try {
      const response = await fastify.epicorAdapter._makeRequest(url);
      const records = response?.data?.value || [];

      if (isEntitySetDescriptor(records)) {
        continue;
      }

      fastify.log.info(`Fetched ${records.length} QSeatEtab line items for quote ${normalizedQuoteNum} via ${url}`);
      return records;
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError) throw lastError;
  return [];
}

async function qSeatEtabService(fastify, _) {
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

    const epicorId = properties.rowident
      || `${properties.quotedtl_quotenum}|${properties.hs_sku || ''}|${properties.name || ''}`;

    await fastify.lineItemRepository.insertDatabase({
      epicorId: String(epicorId),
      hubspotId: created.id,
      source: 'EpicorQSeatEtab',
      quoteNum: properties.quotedtl_quotenum,
      action: 'create',
    }).catch(() =>
      fastify.lineItemRepository.updateDatabase(
        { epicorId: String(epicorId) },
        { hubspotId: created.id, source: 'EpicorQSeatEtab', quoteNum: properties.quotedtl_quotenum, action: 'create' },
      ).catch(() => {})
    );

    return created;
  }

  /**
   * Reconciles Epicor QSeatEtab records against HubSpot line items.
   * Uses multiset matching on name + hs_sku to determine creates, updates, and deletes.
   */
  async function reconcileAndSync(epicorRecords, dealId) {
    const results = { created: 0, updated: 0, deleted: 0, unchanged: 0, errors: 0 };

    const rawDesired = epicorRecords.map(buildCleanProperties);
    const desiredItems = deduplicateDesiredItems(rawDesired, QSEAT_ETAB_KEY_OPTIONS.desiredKeyFn);

    if (rawDesired.length !== desiredItems.length) {
      fastify.log.info(`QSeatEtab: Deduped desired items from ${rawDesired.length} to ${desiredItems.length} by name+sku`);
    }

    const allExisting = dealId ? await fetchExistingLineItems(dealId) : [];
    const sourceItems = filterQSeatEtabItems(allExisting);

    fastify.log.info(
      `Deal ${dealId}: ${allExisting.length} total line items, ${sourceItems.length} QSeatEtab, ${desiredItems.length} desired from Epicor`
    );

    const { toCreate, toUpdate, toDelete, unchangedCount } = reconcileLineItems(
      desiredItems,
      sourceItems,
      QSEAT_ETAB_KEY_OPTIONS
    );
    results.unchanged = unchangedCount;

    // Delete stale QSeatEtab items no longer present in Epicor
    for (const item of toDelete) {
      try {
        await deleteHubSpotLineItem(item.id);
        fastify.log.info(`Deleted stale QSeatEtab line item ${item.id} from deal ${dealId}`);
        results.deleted++;
      } catch (error) {
        fastify.log.error(`Failed to delete QSeatEtab line item ${item.id}: ${error.message}`);
        results.errors++;
      }
    }

    // Update matched items with fresh properties
    for (const { existingId, properties } of toUpdate) {
      try {
        await fastify.backoff(() =>
          fastify.hubspotAdapter.updateLineItem({ lineItemId: existingId, properties })
        );
        fastify.log.info(`Updated QSeatEtab line item ${existingId} on deal ${dealId}`);
        results.updated++;
      } catch (error) {
        fastify.log.error(`Failed to update QSeatEtab line item ${existingId}: ${error.message}`);
        results.errors++;
      }
    }

    // Create new items
    for (const properties of toCreate) {
      try {
        const created = await createHubSpotLineItem(properties, dealId);
        fastify.log.info(`Created QSeatEtab line item ${created.id} on deal ${dealId}`);
        results.created++;
      } catch (error) {
        fastify.log.error(`Failed to create QSeatEtab line item on deal ${dealId}: ${error.message}`);
        results.errors++;
      }
    }

    fastify.log.info(
      `QSeatEtab reconciliation for deal ${dealId}: ${results.created} created, ${results.updated} updated, ${results.deleted} deleted, ${results.unchanged} unchanged, ${results.errors} errors`
    );
    return results;
  }

  async function syncLineItemsForQuoteWithData(quoteNum, dealId, quoteRecords) {
    if (!quoteRecords.length) {
      return { success: true, message: 'No QSeatEtab line items for this quote', lineItemCount: 0 };
    }

    // Dedup Epicor records by composite key (Description + PartNum + LineDesc + OrderQty + QuoteNum)
    const seen = new Set();
    const uniqueRecords = [];
    for (const record of quoteRecords) {
      const key = [
        record.ProdGrup_Description || '',
        record.QuoteDtl_PartNum || '',
        record.QuoteDtl_LineDesc || '',
        record.QuoteDtl_OrderQty || '',
        record.QuoteDtl_QuoteNum || '',
      ].join('|');
      if (!seen.has(key)) {
        seen.add(key);
        uniqueRecords.push(record);
      }
    }

    fastify.log.info(`Found ${quoteRecords.length} QSeatEtab records, deduplicated to ${uniqueRecords.length} for quote ${quoteNum}`);

    const results = await reconcileAndSync(uniqueRecords, dealId);

    return {
      success: true,
      lineItemCount: uniqueRecords.length,
      createdCount: results.created,
      updatedCount: results.updated,
      deletedCount: results.deleted,
      unchangedCount: results.unchanged,
      errorCount: results.errors,
    };
  }

  async function syncLineItemsForQuote(quoteNum, dealId) {
    fastify.log.info(`Fetching QSeatEtab line items for quote ${quoteNum}`);
    const records = await fetchQSeatEtabRecordsForQuote(fastify, quoteNum);

    if (!records?.length) {
      fastify.log.info(`No QSeatEtab line items found for quote ${quoteNum}`);
      return { success: true, message: 'No QSeatEtab line items for this quote', lineItemCount: 0 };
    }

    return await syncLineItemsForQuoteWithData(quoteNum, dealId, records);
  }

  async function task(dateString) {
    try {
      fastify.log.info('Processing Tasks for QSeatEtab Line Items');
      return { success: true, message: 'QSeatEtab line items processed by quote service' };
    } catch (error) {
      fastify.log.error(`Error processing Tasks for QSeatEtab Line Items: ${error.message}`);
      throw error;
    }
  }

  if (!fastify.hasDecorator('qSeatEtabService')) {
    fastify.decorate('qSeatEtabService', {
      syncLineItemsForQuote,
      syncLineItemsForQuoteWithData,
      task,
    });
  }
}

export default fp(qSeatEtabService, {
  name: 'qSeatEtabService',
  dependencies: [
    'lineItemRepository',
    'epicorAdapter',
    'hubspotAdapter',
    'backoff',
    'constants',
  ],
});
