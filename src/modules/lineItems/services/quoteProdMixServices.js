import fp from 'fastify-plugin';

const toSingleLineText = (value) => {
  if (value == null) return null;
  const text = String(value).trim();
  return text.length ? text : null;
};

const FIELD_MAPPINGS = [
  { epicor: 'QuoteDtl_QuoteNum', hubspot: 'quotedtl_quotenum', transform: Number },
  { epicor: 'ProdGrup_Character01', hubspot: 'prodgrup_character01', transform: toSingleLineText },
  { epicor: 'Calculated_Total', hubspot: 'price', transform: Number },
];

/**
 * Properties used to determine if a line item already exists on a deal.
 * If ALL of these HubSpot properties match an existing line item, it is skipped.
 * Order/quote numbers are intentionally ignored to dedupe across order/quote syncs.
 */
const DEDUP_PROPERTIES = ['name', 'price'];

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

function extractHubspotErrorContext(error) {
  const chain = [];
  let current = error;
  while (current && chain.length < 5) {
    chain.push(current);
    current = current.cause;
  }

  let status;
  let message;
  for (const err of chain) {
    if (status == null && err?.response?.status != null) status = err.response.status;
    if (!message) {
      message = err?.response?.data?.message
        || err?.response?.data?.error
        || err?.message
        || message;
    }
  }

  const combinedMessage = chain.map((err) => err?.message).filter(Boolean).join(' | ');
  return { status, message, combinedMessage };
}

async function quoteProdMixService(fastify, _) {
  const { HUBSPOT_ASSOCIATIONS } = fastify.constants;

  async function upsertLineItemRecord(data) {
    const query = { epicorId: String(data.epicorId) };
    const existing = await fastify.lineItemRepository.findByQuery(query);
    if (existing) {
      await fastify.lineItemRepository.updateDatabase(query, data);
      return { updated: true, existing };
    }
    await fastify.lineItemRepository.insertDatabase(data);
    return { created: true };
  }

  function getEpicorId(lineItem, quoteNum, fallbackId) {
    return lineItem.SysRowID
      || lineItem.QuoteDtl_SysRowID
      || `${quoteNum}|${lineItem.ProdGrup_Character01 || ''}|${lineItem.Calculated_Total || ''}`
      || fallbackId;
  }

  async function appendDealProdGrupValue(dealId, prodGrupValue) {
    return;
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
        props.name = props.prodgrup_character01 || 'Unnamed Product';
        props.quantity = 1;

        const cleanProps = {};
        for (const [key, value] of Object.entries(props)) {
          if (value != null) cleanProps[key] = value;
        }

        const epicorId = getEpicorId(lineItem, quoteNum);
        const existingRecord = null;

        // Property-based dedup: skip if all properties match an existing line item
        const match = findMatchingLineItem(existingLineItems, cleanProps);
        if (match) {
          const lineItemId = match.id;
          await fastify.backoff(() =>
            fastify.hubspotAdapter.updateLineItem({ lineItemId, properties: cleanProps })
          );

          if (dealId && HUBSPOT_ASSOCIATIONS.LINE_ITEM_TO_DEAL != null) {
            await fastify.hubspotAdapter.ensureAssociation(
              'line_items',
              lineItemId,
              'deals',
              dealId,
              HUBSPOT_ASSOCIATIONS.LINE_ITEM_TO_DEAL
            );
          }

          if (epicorId) {
            await upsertLineItemRecord({
              epicorId: String(epicorId),
              hubspotId: lineItemId,
              source: 'EpicorQuoteProdMix',
              quoteNum,
              action: 'update'
            });
          }

          fastify.log.info(`QuoteProdMix line item for quote ${quoteNum} updated on existing HubSpot line item ${lineItemId}`);
          results.updated++;
          continue;
        }

        if (existingRecord?.hubspotId) {
          const lineItemId = existingRecord.hubspotId;
          let needsCreate = false;

          try {
            await fastify.backoff(() =>
              fastify.hubspotAdapter.updateLineItem({ lineItemId, properties: cleanProps })
            );
          } catch (error) {
            const { status, message, combinedMessage } = extractHubspotErrorContext(error);
            const combined = String(combinedMessage || '');
            const notFound = status === 404
              || String(message || '').toLowerCase().includes('resource not found')
              || combined.toLowerCase().includes('resource not found')
              || /\b404\b/.test(combined);

            if (notFound) {
              await fastify.lineItemRepository.deleteDatabase({ epicorId: String(epicorId) });
              fastify.log.warn(`QuoteProdMix line item ${lineItemId} not found; recreating for quote ${quoteNum}`);
              needsCreate = true;
            } else {
              throw error;
            }
          }

          if (!needsCreate) {
            if (dealId && HUBSPOT_ASSOCIATIONS.LINE_ITEM_TO_DEAL != null) {
              await fastify.hubspotAdapter.ensureAssociation(
                'line_items',
                lineItemId,
                'deals',
                dealId,
                HUBSPOT_ASSOCIATIONS.LINE_ITEM_TO_DEAL
              );
            }

            await fastify.lineItemRepository.updateDatabase(
              { epicorId: String(epicorId) },
              {
                hubspotId: lineItemId,
                source: 'EpicorQuoteProdMix',
                quoteNum,
                action: 'update',
              }
            );

            existingLineItems.push({ id: lineItemId, properties: { ...cleanProps } });
            results.updated++;

            if (dealId) {
              await appendDealProdGrupValue(dealId, props.prodgrup_character01);
            }
            continue;
          }
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

        if (dealId && HUBSPOT_ASSOCIATIONS.LINE_ITEM_TO_DEAL != null) {
          await fastify.hubspotAdapter.ensureAssociation(
            'line_items',
            lineItemId,
            'deals',
            dealId,
            HUBSPOT_ASSOCIATIONS.LINE_ITEM_TO_DEAL
          );
        }

        const resolvedEpicorId = epicorId || getEpicorId(lineItem, quoteNum, lineItemId);

        await upsertLineItemRecord({
          epicorId: String(resolvedEpicorId),
          hubspotId: lineItemId,
          source: 'EpicorQuoteProdMix',
          quoteNum,
          action: 'create'
        });

        // Track the newly created item so subsequent items in this batch can dedup against it
        existingLineItems.push({ id: lineItemId, properties: { ...cleanProps } });

        results.created++;

        if (dealId) {
          await appendDealProdGrupValue(dealId, props.prodgrup_character01);
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
      prodgrupValues: [...new Set(uniqueRecords.map(r => toSingleLineText(r.ProdGrup_Character01)).filter(Boolean))]
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
