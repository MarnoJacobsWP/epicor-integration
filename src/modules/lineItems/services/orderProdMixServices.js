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
  { epicor: 'OrderDtl_OrderNum', hubspot: 'orderdtl_ordernum', transform: Number },
  { epicor: 'ProdGrup_Character01', hubspot: 'prodgrup_characterna', transform: toValidProdGrup },
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

async function orderProdMixService(fastify, _) {
  const { ENDPOINTS, HUBSPOT_ASSOCIATIONS } = fastify.constants;
  let dealProdGrupPropertyCache = null;

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

  function getEpicorId(lineItem, orderNum, fallbackId) {
    return lineItem.SysRowID
      || lineItem.OrderDtl_SysRowID
      || `${orderNum}|${lineItem.ProdGrup_Character01 || ''}|${lineItem.Calculated_Total || ''}`
      || fallbackId;
  }

  async function appendDealProdGrupValue(dealId, prodGrupValue) {
    if (!dealId || !prodGrupValue) return;

    const propertyName = 'prodgrup_characterna';
    try {
      if (dealProdGrupPropertyCache === false) return;
      if (dealProdGrupPropertyCache === null) {
        dealProdGrupPropertyCache = await fastify.hubspotAdapter.getObjectProperty('deals', propertyName);
      }

      if (!dealProdGrupPropertyCache) {
        dealProdGrupPropertyCache = false;
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
    fastify.log.info(`Processing ${lineItems.length} OrderProdMix line items for deal ${dealId}`);

    const existingLineItems = dealId ? await fetchExistingLineItems(dealId) : [];
    fastify.log.info(`Found ${existingLineItems.length} existing line items on deal ${dealId}`);

    for (const lineItem of lineItems) {
      const orderNum = lineItem.OrderDtl_OrderNum;

      try {
        const props = transformEpicorToHubSpot(lineItem);
        props.name = props.prodgrup_characterna || 'Unnamed Product';

        const cleanProps = {};
        for (const [key, value] of Object.entries(props)) {
          if (value != null) cleanProps[key] = value;
        }

        const epicorId = getEpicorId(lineItem, orderNum);
        const existingRecord = epicorId
          ? await fastify.lineItemRepository.findByQuery({ epicorId: String(epicorId) })
          : null;

        // Property-based dedup: skip if all properties match an existing line item
        const match = findMatchingLineItem(existingLineItems, cleanProps);
        if (match) {
          fastify.log.info(`OrderProdMix line item for order ${orderNum} skipped (matches HubSpot line item ${match.id})`);
          results.skipped++;
          continue;
        }

        if (existingRecord?.hubspotId) {
          const lineItemId = existingRecord.hubspotId;
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

          await fastify.lineItemRepository.updateDatabase(
            { epicorId: String(epicorId) },
            {
              hubspotId: lineItemId,
              source: 'EpicorOrderProdMix',
              orderNum,
              action: 'update',
            }
          );

          existingLineItems.push({ id: lineItemId, properties: { ...cleanProps } });
          results.updated++;

          if (dealId) {
            await appendDealProdGrupValue(dealId, props.prodgrup_characterna);
          }
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

        const resolvedEpicorId = epicorId || getEpicorId(lineItem, orderNum, lineItemId);

        await upsertLineItemRecord({
          epicorId: String(resolvedEpicorId),
          hubspotId: lineItemId,
          source: 'EpicorOrderProdMix',
          orderNum,
          action: 'create'
        });

        // Track the newly created item so subsequent items in this batch can dedup against it
        existingLineItems.push({ id: lineItemId, properties: { ...cleanProps } });

        results.created++;

        if (dealId) {
          await appendDealProdGrupValue(dealId, props.prodgrup_characterna);
        }

      } catch (error) {
        fastify.log.error(`OrderProdMix line item for order ${orderNum} failed: ${error.message}`);
        results.errors++;
      }
    }

    fastify.log.info(`OrderProdMix processing complete: ${results.created} created, ${results.skipped} skipped, ${results.errors} errors`);
  }

  async function syncLineItemsForOrder(orderNum, dealId) {
    fastify.log.info(`Fetching OrderProdMix line items for order ${orderNum}`);
    const { records, metadata } = await fastify.epicorAdapter.fetchRelatedRecords(
      ENDPOINTS.ORDER_PROD_MIX,
      'OrderDtl_OrderNum',
      orderNum
    );

    if (!records?.length) {
      fastify.log.info(`No OrderProdMix line items found for order ${orderNum}`);
      return { success: true, message: 'No line items for this order', lineItemCount: 0 };
    }

    // Dedup Epicor records by composite key (ProdGrup + Total + OrderNum)
    const seen = new Set();
    const uniqueRecords = [];
    for (const record of records) {
      const key = `${record.ProdGrup_Character01 || ''}|${record.Calculated_Total || ''}|${record.OrderDtl_OrderNum || ''}`;
      if (!seen.has(key)) {
        seen.add(key);
        uniqueRecords.push(record);
      }
    }

    fastify.log.info(`Found ${records.length} OrderProdMix records, deduplicated to ${uniqueRecords.length} for order ${orderNum}`);

    const results = {
      total: uniqueRecords.length,
      created: 0,
      updated: 0,
      errors: 0,
      skipped: 0,
    };

    await processLineItemsIndividually(uniqueRecords, dealId, results);

    fastify.log.info(`Order ${orderNum} line items sync complete: ${results.created} created, ${results.skipped} skipped, ${results.errors} errors`);

    return {
      success: true,
      lineItemCount: uniqueRecords.length,
      createdCount: results.created,
      updatedCount: results.updated,
      errorCount: results.errors,
      skippedCount: results.skipped,
      metadata
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
