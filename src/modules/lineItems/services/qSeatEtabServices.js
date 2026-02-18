import fp from 'fastify-plugin';

const FIELD_MAPPINGS = [
  { epicor: 'QuoteDtl_QuoteNum', hubspot: 'quotedtl_quotenum', transform: Number },
  { epicor: 'ProdGrup_Description', hubspot: 'prodgrup_description' },
  { epicor: 'QuoteDtl_PartNum', hubspot: 'quotedtl_partnum' },
  { epicor: 'QuoteDtl_LineDesc', hubspot: 'quotedtl_linedesc' },
  { epicor: 'QuoteDtl_OrderQty', hubspot: 'quantity', transform: Number },
  { epicor: 'RowIdent', hubspot: 'rowident' },
];

/**
 * Properties used to determine if a line item already exists on a deal.
 * If ALL of these HubSpot properties match an existing line item, it is skipped.
 * Order/quote numbers are intentionally ignored to dedupe across order/quote syncs.
 */
const DEDUP_PROPERTIES = ['name', 'hs_sku'];
const ALLOWED_PROD_GROUPS = new Set(['E-Tables', 'New Seating']);

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
      const epicorId = lineItem.RowIdent
        || lineItem.SysRowID
        || lineItem.QuoteDtl_SysRowID
        || `${quoteNum}|${lineItem.QuoteDtl_PartNum || ''}|${lineItem.QuoteDtl_LineDesc || ''}|${lineItem.QuoteDtl_OrderQty || ''}`
        || null;

      try {
        const props = transformEpicorToHubSpot(lineItem);

        if (props.prodgrup_description && !ALLOWED_PROD_GROUPS.has(props.prodgrup_description)) {
          fastify.log.warn(`Invalid prodgrup_description "${props.prodgrup_description}" for quote ${quoteNum}; omitting value`);
          delete props.prodgrup_description;
        }

        props.name = props.prodgrup_description || 'Unnamed Product';
        props.hs_sku = props.quotedtl_partnum;
        props.description = props.quotedtl_linedesc;

        const cleanProps = {};
        for (const [key, value] of Object.entries(props)) {
          if (value != null) cleanProps[key] = value;
        }

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
            await fastify.lineItemRepository.updateDatabase(
              { epicorId: String(epicorId) },
              {
                hubspotId: lineItemId,
                source: 'EpicorQSeatEtab',
                quoteNum,
                action: 'update',
              }
            );
          }

          fastify.log.info(`QSeatEtab line item for quote ${quoteNum} updated on existing HubSpot line item ${lineItemId}`);
          results.updated++;
          continue;
        }

        const existingRecord = epicorId
          ? await fastify.lineItemRepository.findByQuery({ epicorId: String(epicorId) })
          : null;

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
              fastify.log.warn(`QSeatEtab line item ${lineItemId} not found; recreating for quote ${quoteNum}`);
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
                source: 'EpicorQSeatEtab',
                quoteNum,
                action: 'update',
              }
            );

            existingLineItems.push({ id: lineItemId, properties: { ...cleanProps } });
            results.updated++;
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

        const resolvedEpicorId = epicorId || lineItemId;

        await createDataBase({
          epicorId: String(resolvedEpicorId),
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
