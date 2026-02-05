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
  { epicor: 'RowIdent', hubspot: 'rowident_' },
];

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

async function orderProdMixService(fastify, _) {
  const { ENDPOINTS } = fastify.constants;
  const UNIQUE_PROPERTY = 'rowident_';

  async function infoRecord(data) {
    return await fastify.lineItemRepository.findByIdProperty(data);
  }

  async function updateDataBase(filter, data) {
    return await fastify.lineItemRepository.updateDatabase(filter, data);
  }

  async function createDataBase(data) {
    return await fastify.lineItemRepository.insertDatabase(data);
  }

  async function deleteDataBase(filter) {
    return await fastify.lineItemRepository.deleteDatabase(filter);
  }

  async function appendDealProdGrupValue(dealId, prodGrupValue) {
    if (!dealId || !prodGrupValue) return;

    const propertyName = 'prodgrup_characterna';
    try {
      const deal = await fastify.backoff(() =>
        fastify.hubspotAdapter.getDealById({ dealId, properties: [propertyName] })
      );

      const existing = deal?.properties?.[propertyName] || '';
      const values = new Set(String(existing).split(';').filter(Boolean));
      values.add(prodGrupValue);

      const updated = Array.from(values).join(';');
      if (updated && updated !== existing) {
        await fastify.backoff(() =>
          fastify.hubspotAdapter.updateDeal({
            dealId,
            properties: { [propertyName]: updated }
          })
        );
      }
    } catch (error) {
      fastify.log.warn(`Failed to append prod group value to deal ${dealId}: ${error.message}`);
    }
  }

  async function processLineItemsIndividually(lineItems, dealId, results) {
    fastify.log.info(`Starting individual processing for ${lineItems.length} line items...`);
    
    for (const lineItem of lineItems) {
      const rowident = lineItem.RowIdent;

      try {
        const props = transformEpicorToHubSpot(lineItem);
        props.name = props.prodgrup_characterna || 'Unnamed Product';

        const cleanProps = {
          name: props.name,
          price: props.price,
          rowident_: props.rowident_,
          prodgrup_characterna: props.prodgrup_characterna
        };

        Object.keys(cleanProps).forEach(key => {
          if (cleanProps[key] === null || cleanProps[key] === undefined) {
            delete cleanProps[key];
          }
        });

        const query = {
          epicorId: lineItem.RowIdent,
          source: 'EpicorOrderProdMix',
        };

        let existRecord = await infoRecord(query);

        if (!existRecord) {
          try {
            const searchData = await fastify.backoff(() =>
              fastify.hubspotAdapter.searchLineItems({
                body: {
                  filterGroups: [{ filters: [{ propertyName: 'rowident_', operator: 'EQ', value: String(rowident) }] }],
                  limit: 1,
                  properties: ['rowident_', 'name', 'price'],
                },
              })
            );
            existRecord = searchData.results?.[0] || null;
          } catch (searchError) {
            existRecord = null;
          }
        }

        if (existRecord?.id || existRecord?.hubspotId) {
          const lineItemId = existRecord?.hubspotId || existRecord?.id;

          try {
            await fastify.backoff(() =>
              fastify.hubspotAdapter.updateLineItem({ lineItemId, properties: cleanProps })
            );
          } catch (error) {
            if (error?.response?.data?.message?.toLowerCase() === 'resource not found') {
              await deleteDataBase(query);
              fastify.log.warn(`Line item ${rowident} deleted from DB`);
              continue;
            } else {
              throw error;
            }
          }

          if (existRecord?.hubspotId) {
            await updateDataBase(query, { action: 'update' });
          } else {
            await createDataBase({
              hubspotId: lineItemId,
              epicorId: lineItem.RowIdent,
              source: 'EpicorOrderProdMix',
              orderNum: lineItem.OrderDtl_OrderNum,
              action: 'create'
            });
          }

          if (dealId) {
            try {
              await fastify.hubspotAdapter.createAssociation(
                'line_items',
                lineItemId,
                'deals',
                dealId,
                20
              );
            } catch (assocError) {
              fastify.log.warn(`Failed to associate line item ${lineItemId} with deal ${dealId}: ${assocError.message}`);
            }

            await appendDealProdGrupValue(dealId, props.prodgrup_characterna);
          }

          results.updated++;
        } else {
          const associations = dealId ? [{
            to: { id: dealId },
            types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 20 }]
          }] : [];

          const created = await fastify.backoff(() =>
            fastify.hubspotAdapter.createLineItem({ properties: cleanProps, associations })
          );
          const lineItemId = created.id;

          await createDataBase({
            hubspotId: lineItemId,
            epicorId: lineItem.RowIdent,
            source: 'EpicorOrderProdMix',
            orderNum: lineItem.OrderDtl_OrderNum,
            action: 'create'
          });

          results.created++;

          if (dealId) {
            await appendDealProdGrupValue(dealId, props.prodgrup_characterna);
          }
        }

      } catch (error) {
        fastify.log.error(`Line item ${rowident} failed: ${error.message}`);
        results.errors++;
      }
    }
    
    fastify.log.info(`Individual processing complete: ${results.created} created, ${results.updated} updated, ${results.errors} errors`);
  }

  async function syncLineItemsForOrder(orderNum, dealId) {
    fastify.log.info(`Fetching line items for order ${orderNum}...`);
    const { records, metadata } = await fastify.epicorAdapter.fetchRelatedRecords(
      ENDPOINTS.ORDER_PROD_MIX,
      'OrderDtl_OrderNum',
      orderNum
    );
    
    if (!records?.length) {
      fastify.log.info(`No line items found for order ${orderNum}`);
      return { success: true, message: 'No line items for this order', lineItemCount: 0 };
    }

    const lineItemMap = new Map();
    for (const record of records) {
      const rowIdent = record.RowIdent;
      if (!rowIdent) continue;
      
      const existing = lineItemMap.get(rowIdent);
      if (!existing || (record.Calculated_Time && (!existing.Calculated_Time || record.Calculated_Time > existing.Calculated_Time))) {
        lineItemMap.set(rowIdent, record);
      }
    }
    
    const uniqueRecords = Array.from(lineItemMap.values());
    fastify.log.info(`Found ${uniqueRecords.length} unique line items for order ${orderNum}, processing individually...`);

    const results = {
      total: uniqueRecords.length,
      created: 0,
      updated: 0,
      errors: 0,
      skipped: 0,
      errorDetails: []
    };

    await processLineItemsIndividually(uniqueRecords, dealId, results);
    
    fastify.log.info(`Order ${orderNum} line items sync complete: ${results.created} created, ${results.updated} updated, ${results.errors} errors, ${results.skipped} skipped`);

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
      fastify.log.error(`Error processing Tasks for Order Line Items - ${error.message}`);
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