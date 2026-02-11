import fp from 'fastify-plugin';

const FIELD_MAPPINGS = [
  { epicor: 'QuoteDtl_QuoteNum', hubspot: 'quotedtl_quotenum', transform: Number },
  { epicor: 'ProdGrup_Description', hubspot: 'prodgrup_description' },
  { epicor: 'QuoteDtl_PartNum', hubspot: 'quotedtl_partnum' },
  { epicor: 'QuoteDtl_LineDesc', hubspot: 'quotedtl_linedesc' },
  { epicor: 'QuoteDtl_OrderQty', hubspot: 'quotedtl_orderqty', transform: Number },
];

/**
 * Properties used to determine if a line item already exists on a deal.
 * If ALL of these HubSpot properties match an existing line item, it is skipped.
 */
const DEDUP_PROPERTIES = ['name', 'hs_sku', 'description', 'quantity', 'quotedtl_quotenum', 'prodgrup_description'];

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

/**
 * Checks whether a set of properties matches any existing HubSpot line item.
 * Returns the matching HubSpot line item or null.
 */
function findMatchingLineItem(existingLineItems, candidateProps) {
  return existingLineItems.find((existing) => {
    const hsProps = existing.properties || {};
    return DEDUP_PROPERTIES.every((key) => {
      const candidateVal = String(candidateProps[key] ?? '').trim();
      const existingVal = String(hsProps[key] ?? '').trim();
      return candidateVal === existingVal;
    });
  }) || null;
}

async function qSeatEtabService(fastify, _) {
  const { HUBSPOT_ASSOCIATIONS } = fastify.constants;

  async function createDataBase(data) {
    return await fastify.lineItemRepository.insertDatabase(data);
  }

  /**
   * Fetches existing HubSpot line items for a deal so we can compare properties
   * for dedup instead of relying on RowIdent (which changes each Epicor pull).
   */
  async function fetchExistingLineItems(dealId) {
    try {
      return await fastify.backoff(() =>
        fastify.hubspotAdapter.getLineItemsForDeal(dealId, DEDUP_PROPERTIES)
      );
    } catch (error) {
      fastify.log.warn(`Failed to fetch existing line items for deal ${dealId}: ${error.message}`);
      return [];
    }
  }

  async function processLineItemsIndividually(lineItems, dealId, results) {
    fastify.log.info(`Processing ${lineItems.length} QSeatEtab line items for deal ${dealId}`);

    const existingLineItems = dealId ? await fetchExistingLineItems(dealId) : [];
    fastify.log.info(`Found ${existingLineItems.length} existing line items on deal ${dealId}`);

    for (const lineItem of lineItems) {
      const quoteNum = lineItem.QuoteDtl_QuoteNum;

      try {
        const props = transformEpicorToHubSpot(lineItem);
        props.name = props.prodgrup_description || 'Unnamed Product';
        props.hs_sku = props.quotedtl_partnum;
        props.description = props.quotedtl_linedesc;
        props.quantity = props.quotedtl_orderqty || 0;

        const cleanProps = {};
        for (const [key, value] of Object.entries(props)) {
          if (value != null) cleanProps[key] = value;
        }

        // Property-based dedup: skip if all properties match an existing line item
        const match = findMatchingLineItem(existingLineItems, cleanProps);
        if (match) {
          fastify.log.info(`QSeatEtab line item for quote ${quoteNum} skipped (matches HubSpot line item ${match.id})`);
          results.skipped++;
          continue;
        }

        // No match found — create new line item
        const associations = dealId ? [{
          to: { id: dealId },
          types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: HUBSPOT_ASSOCIATIONS.LINE_ITEM_TO_DEAL }]
        }] : [];

        const created = await fastify.backoff(() =>
          fastify.hubspotAdapter.createLineItem({ properties: cleanProps, associations })
        );
        const lineItemId = created.id;

        await createDataBase({
          hubspotId: lineItemId,
          source: 'EpicorQSeatEtab',
          quoteNum,
          action: 'create'
        });

        // Track the newly created item so subsequent items in this batch can dedup against it
        existingLineItems.push({ id: lineItemId, properties: { ...cleanProps } });

        results.created++;

      } catch (error) {
        fastify.log.error(`QSeatEtab line item for quote ${quoteNum} failed: ${error.message}`);
        results.errors++;
      }
    }

    fastify.log.info(`QSeatEtab processing complete: ${results.created} created, ${results.skipped} skipped, ${results.errors} errors`);
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

    const results = {
      total: uniqueRecords.length,
      created: 0,
      updated: 0,
      errors: 0,
      skipped: 0,
    };

    await processLineItemsIndividually(uniqueRecords, dealId, results);

    fastify.log.info(`QSeatEtab sync for quote ${quoteNum} complete: ${results.created} created, ${results.skipped} skipped, ${results.errors} errors`);

    return {
      success: true,
      lineItemCount: uniqueRecords.length,
      createdCount: results.created,
      updatedCount: results.updated,
      errorCount: results.errors,
      skippedCount: results.skipped
    };
  }

  async function syncLineItemsForQuote(quoteNum, dealId) {
    fastify.log.info(`Fetching QSeatEtab line items for quote ${quoteNum}`);
    const { records } = await fastify.epicorAdapter.fetchRelatedRecords(
      fastify.constants.ENDPOINTS.QSEAT_ETAB,
      'QuoteDtl_QuoteNum',
      quoteNum
    );

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
