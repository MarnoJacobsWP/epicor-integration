import fp from 'fastify-plugin';

const VALID_PRODGRUP_OPTIONS = [
  'Discounted Products', 'E-Tables', 'EVO', 'Free Standing', 'Glass',
  'New Casegoods, Training Tables', 'Panel Sales', 'Peds / Laterals',
  'Power Beam', 'Seating', 'PET', 'Xpand', 'Unknown Option'
];

const toValidProdGrup = (v) => {
  if (!v) return 'Unknown Option';
  return VALID_PRODGRUP_OPTIONS.includes(v) ? v : 'Unknown Option';
};

const FIELD_MAPPINGS = [
  { epicor: 'QuoteDtl_QuoteNum', hubspot: 'quotedtl_quotenum', transform: Number },
  { epicor: 'ProdGrup_Character01', hubspot: 'prodgrup_characterna', transform: toValidProdGrup },
  { epicor: 'Calculated_Total', hubspot: 'price', transform: Number },
];

/**
 * Properties used to determine if a line item already exists on a deal.
 * If ALL of these HubSpot properties match an existing line item, it is skipped.
 */
const DEDUP_PROPERTIES = ['name', 'price', 'quotedtl_quotenum', 'prodgrup_characterna'];

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

async function quoteProdMixService(fastify, _) {
  const { HUBSPOT_ASSOCIATIONS } = fastify.constants;
  let dealProdGrupPropertyCache = null;

  async function createDataBase(data) {
    return await fastify.lineItemRepository.insertDatabase(data);
  }

  async function appendDealProdGrupValue(dealId, prodGrupValue) {
    if (!dealId || !prodGrupValue) return;

    const propertyName = 'prodgrup_characterna';
    try {
      if (dealProdGrupPropertyCache === null) {
        dealProdGrupPropertyCache = await fastify.hubspotAdapter.getObjectProperty('deals', propertyName);
      }

      if (!dealProdGrupPropertyCache) {
        fastify.log.warn(`Deal ${dealId} - ${propertyName} property not found on deals; skipping update`);
        return;
      }

      const options = Array.isArray(dealProdGrupPropertyCache.options)
        ? dealProdGrupPropertyCache.options
        : [];

      const normalizedValue = String(prodGrupValue).trim();
      let optionValue = normalizedValue;
      if (options.length > 0) {
        const optionMatch = options.find(opt =>
          String(opt?.label || '').trim().toLowerCase() === normalizedValue.toLowerCase() ||
          String(opt?.value || '').trim().toLowerCase() === normalizedValue.toLowerCase()
        );
        if (!optionMatch?.value) {
          fastify.log.warn(`Deal ${dealId} - ${propertyName} unknown option "${normalizedValue}"; skipping update`);
          return;
        }
        optionValue = optionMatch.value;
      }

      const isMultiSelect = String(dealProdGrupPropertyCache.fieldType || '').toLowerCase() === 'checkbox';

      const deal = await fastify.backoff(() =>
        fastify.hubspotAdapter.getDealById({ dealId, properties: [propertyName] })
      );

      const existing = deal?.properties?.[propertyName] || '';
      if (isMultiSelect) {
        const values = new Set(String(existing).split(';').filter(Boolean));
        values.add(optionValue);

        const updated = Array.from(values).join(';');
        if (updated && updated !== existing) {
          await fastify.backoff(() =>
            fastify.hubspotAdapter.updateDeal({
              dealId,
              properties: { [propertyName]: updated }
            })
          );
        }
      } else if (optionValue && optionValue !== existing) {
        await fastify.backoff(() =>
          fastify.hubspotAdapter.updateDeal({
            dealId,
            properties: { [propertyName]: optionValue }
          })
        );
      }
    } catch (error) {
      fastify.log.warn(`Deal ${dealId} - Failed to append prodgrup value "${prodGrupValue}": ${error.message}`);
    }
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
    fastify.log.info(`Processing ${lineItems.length} QuoteProdMix line items for deal ${dealId}`);

    const existingLineItems = dealId ? await fetchExistingLineItems(dealId) : [];
    fastify.log.info(`Found ${existingLineItems.length} existing line items on deal ${dealId}`);

    for (const lineItem of lineItems) {
      const quoteNum = lineItem.QuoteDtl_QuoteNum;

      try {
        const props = transformEpicorToHubSpot(lineItem);
        props.name = props.prodgrup_characterna || 'Unnamed Product';

        const cleanProps = {};
        for (const [key, value] of Object.entries(props)) {
          if (value != null) cleanProps[key] = value;
        }

        // Property-based dedup: skip if all properties match an existing line item
        const match = findMatchingLineItem(existingLineItems, cleanProps);
        if (match) {
          fastify.log.info(`QuoteProdMix line item for quote ${quoteNum} skipped (matches HubSpot line item ${match.id})`);
          results.skipped++;
          continue;
        }

        // No match found — create new line item
        if (dealId && HUBSPOT_ASSOCIATIONS.LINE_ITEM_TO_DEAL == null) {
          throw new Error('Missing HUBSPOT_ASSOCIATION_LINE_ITEM_TO_DEAL for line item associations');
        }

        const associations = dealId ? [{
          to: { id: dealId },
          types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: HUBSPOT_ASSOCIATIONS.LINE_ITEM_TO_DEAL }]
        }] : [];

        const created = await fastify.backoff(() =>
          fastify.hubspotAdapter.createLineItem({ properties: cleanProps, associations })
        );
        const lineItemId = created.id;

        const epicorId = lineItem.SysRowID
          || lineItem.QuoteDtl_SysRowID
          || `${quoteNum}|${lineItem.ProdGrup_Character01 || ''}|${lineItem.Calculated_Total || ''}`
          || lineItemId;

        await createDataBase({
          epicorId: String(epicorId),
          hubspotId: lineItemId,
          source: 'EpicorQuoteProdMix',
          quoteNum,
          action: 'create'
        });

        // Track the newly created item so subsequent items in this batch can dedup against it
        existingLineItems.push({ id: lineItemId, properties: { ...cleanProps } });

        results.created++;

        if (dealId) {
          await appendDealProdGrupValue(dealId, props.prodgrup_characterna);
        }

      } catch (error) {
        fastify.log.error(`QuoteProdMix line item for quote ${quoteNum} failed: ${error.message}`);
        results.errors++;
      }
    }

    fastify.log.info(`QuoteProdMix processing complete: ${results.created} created, ${results.skipped} skipped, ${results.errors} errors`);
  }

  async function syncLineItemsForQuoteWithData(quoteNum, dealId, quoteRecords) {
    if (!quoteRecords.length) {
      return { success: true, message: 'No QuoteProdMix line items for this quote', lineItemCount: 0 };
    }

    // Dedup Epicor records by composite key (ProdGrup + Total + QuoteNum)
    const seen = new Set();
    const uniqueRecords = [];
    for (const record of quoteRecords) {
      const key = `${record.ProdGrup_Character01 || ''}|${record.Calculated_Total || ''}|${record.QuoteDtl_QuoteNum || ''}`;
      if (!seen.has(key)) {
        seen.add(key);
        uniqueRecords.push(record);
      }
    }

    fastify.log.info(`Found ${quoteRecords.length} QuoteProdMix records, deduplicated to ${uniqueRecords.length} for quote ${quoteNum}`);

    const results = {
      total: uniqueRecords.length,
      created: 0,
      updated: 0,
      errors: 0,
      skipped: 0,
    };

    await processLineItemsIndividually(uniqueRecords, dealId, results);

    fastify.log.info(`QuoteProdMix sync for quote ${quoteNum} complete: ${results.created} created, ${results.skipped} skipped, ${results.errors} errors`);

    return {
      success: true,
      lineItemCount: uniqueRecords.length,
      createdCount: results.created,
      updatedCount: results.updated,
      errorCount: results.errors,
      skippedCount: results.skipped,
      prodgrupValues: [...new Set(uniqueRecords.map(r => toValidProdGrup(r.ProdGrup_Character01)).filter(Boolean))]
    };
  }

  async function syncLineItemsForQuote(quoteNum, dealId) {
    fastify.log.info(`Fetching QuoteProdMix line items for quote ${quoteNum}`);
    const { records } = await fastify.epicorAdapter.fetchRelatedRecords(
      fastify.constants.ENDPOINTS.QUOTE_PROD_MIX,
      'QuoteDtl_QuoteNum',
      quoteNum
    );

    if (!records?.length) {
      fastify.log.info(`No QuoteProdMix line items found for quote ${quoteNum}`);
      return { success: true, message: 'No QuoteProdMix line items for this quote', lineItemCount: 0 };
    }

    return await syncLineItemsForQuoteWithData(quoteNum, dealId, records);
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
      syncLineItemsForQuoteWithData,
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
