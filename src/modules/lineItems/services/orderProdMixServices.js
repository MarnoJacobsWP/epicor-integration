import fp from 'fastify-plugin';

const FIELD_MAPPINGS = [
  { epicor: 'OrderDtl_OrderNum', hubspot: 'orderdtl_ordernum', transform: Number },
  { epicor: 'ProdGrup_Character01', hubspot: 'prodgrup_character01' },
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

function chunkArray(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

async function orderProdMixService(fastify, _) {
  const { ENDPOINTS, BATCH_SIZES } = fastify.constants;
  const BATCH_SIZE = BATCH_SIZES.LINE_ITEMS || 100;
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

  async function processLineItemBatch(lineItems, dealId) {
    const results = {
      total: lineItems.length,
      created: 0,
      updated: 0,
      errors: 0,
      errorDetails: [],
      skipped: 0
    };

    const batchData = [];
    
    for (const lineItem of lineItems) {
      try {
        const rowident = lineItem.RowIdent;
        if (!rowident) {
          results.skipped++;
          continue;
        }

        const rowidentStr = String(rowident).trim();
        if (!rowidentStr) {
          results.skipped++;
          continue;
        }

        let properties = transformEpicorToHubSpot(lineItem);
        properties.name = properties.prodgrup_character01 || 'Unnamed Product';
        
        if (!properties[UNIQUE_PROPERTY]) {
          properties[UNIQUE_PROPERTY] = rowidentStr;
        }
        
        const cleanProperties = {};
        for (const [key, value] of Object.entries(properties)) {
          if (value !== null && value !== undefined && value !== '') {
            cleanProperties[key] = String(value).substring(0, 500);
          }
        }
        
        if (!cleanProperties[UNIQUE_PROPERTY]) {
          results.skipped++;
          continue;
        }
        
        batchData.push({
          id: rowidentStr,
          properties: cleanProperties
        });
        
      } catch (error) {
        results.errors++;
        results.errorDetails.push({
          error: error.message,
          lineItem: lineItem.RowIdent || 'Unknown'
        });
      }
    }

    if (batchData.length === 0) {
      fastify.log.warn('No valid line item data for batch processing');
      return results;
    }

    fastify.log.info(`Prepared ${batchData.length} line items for batch upsert`);

    try {
      const upsertResult = await fastify.backoff(() =>
        fastify.hubspotAdapter.batchUpsertLineItems(batchData, UNIQUE_PROPERTY)
      );

      if (upsertResult.status === 'COMPLETE' && upsertResult.results) {
        for (const result of upsertResult.results) {
          const rowident = result.properties?.[UNIQUE_PROPERTY];
          const originalLineItem = lineItems.find(li => {
            const liRowident = li.RowIdent;
            return liRowident && String(liRowident).trim() === rowident;
          });
          
          if (originalLineItem) {
            const query = {
              epicorId: originalLineItem.RowIdent,
              source: 'EpicorOrderProdMix',
            };

            const dbData = {
              hubspotId: result.id,
              epicorId: originalLineItem.RowIdent,
              source: 'EpicorOrderProdMix',
              orderNum: originalLineItem.OrderDtl_OrderNum,
              action: result.new ? 'create' : 'update',
              timestamp: new Date()
            };

            if (result.new) {
              results.created++;
            } else {
              results.updated++;
            }

            let existRecord = await infoRecord(query);
            
            if (existRecord?.hubspotId) {
              await updateDataBase(query, dbData);
            } else {
              await createDataBase(dbData);
            }
          }
        }
      }

      if (upsertResult.numErrors > 0 && upsertResult.errors) {
        results.errors += upsertResult.numErrors;
        upsertResult.errors.forEach(error => {
          results.errorDetails.push({
            error: error.message,
            category: error.category,
            status: error.status
          });
        });
      }

      fastify.log.info(`Batch processed: ${results.created} created, ${results.updated} updated, ${results.errors} errors`);

    } catch (error) {
      fastify.log.error(`Batch upsert failed: ${error.message}`, {
        response: error.response?.data
      });
      
      results.errors = batchData.length;
      results.errorDetails.push({
        error: error.message,
        response: error.response?.data
      });
      
      fastify.log.info('Falling back to individual processing...');
      await processLineItemsIndividually(lineItems, dealId, results);
    }

    return results;
  }

  async function processLineItemsIndividually(lineItems, dealId, results) {
    fastify.log.info(`Starting individual processing for ${lineItems.length} line items...`);
    
    for (const lineItem of lineItems) {
      const rowident = lineItem.RowIdent;

      try {
        const props = transformEpicorToHubSpot(lineItem);
        props.name = props.prodgrup_character01 || 'Unnamed Product';

        const cleanProps = {
          name: props.name,
          price: props.price,
          rowident: props.rowident,
          prodgrup_character01: props.prodgrup_character01
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
                  filterGroups: [{ filters: [{ propertyName: 'rowident', operator: 'EQ', value: String(rowident) }] }],
                  limit: 1,
                  properties: ['rowident', 'name', 'price'],
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
              fastify.hubspotAdapter.updateLineItem(lineItemId, cleanProps)
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

          results.updated++;
        } else {
          const associations = dealId ? [{
            to: { id: dealId },
            types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 20 }]
          }] : [];

          const created = await fastify.backoff(() =>
            fastify.hubspotAdapter.createLineItem(cleanProps, associations)
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
    fastify.log.info(`Found ${uniqueRecords.length} unique line items for order ${orderNum}`);

    const batches = chunkArray(uniqueRecords, BATCH_SIZE);
    const batchResults = [];
    
    for (let i = 0; i < batches.length; i++) {
      fastify.log.info(`Processing batch ${i + 1}/${batches.length} (${batches[i].length} line items)...`);
      const result = await processLineItemBatch(batches[i], dealId);
      batchResults.push(result);
      
      if (i < batches.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    
    const totalResults = batchResults.reduce((acc, batch) => ({
      total: acc.total + batch.total,
      created: acc.created + batch.created,
      updated: acc.updated + batch.updated,
      errors: acc.errors + batch.errors,
      skipped: acc.skipped + batch.skipped
    }), { total: 0, created: 0, updated: 0, errors: 0, skipped: 0 });
    
    fastify.log.info(`Order ${orderNum} line items sync complete: ${totalResults.created} created, ${totalResults.updated} updated, ${totalResults.errors} errors, ${totalResults.skipped} skipped`);

    return {
      success: true,
      lineItemCount: uniqueRecords.length,
      createdCount: totalResults.created,
      updatedCount: totalResults.updated,
      errorCount: totalResults.errors,
      skippedCount: totalResults.skipped,
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