import fp from 'fastify-plugin';

const toMidnightUTC = (v) => {
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
};

const UNIQUE_PROPERTY = 'orderhed_ordernum';

const FIELD_MAPPINGS = [
  { epicor: 'OrderHed_OrderNum', hubspot: 'orderhed_ordernum', transform: String },
  { epicor: 'OrderHed_CustNum', hubspot: 'orderhed_custnum', transform: String },
  { epicor: 'OrderDtl_QuoteNum', hubspot: 'orderdtl_quotenum', transform: String },
  { epicor: 'OrderHed_OrderDate', hubspot: 'orderhed_orderdate', transform: toMidnightUTC },
  { epicor: 'OrderHed_CheckBox10', hubspot: 'orderhed_checkboxan', transform: Boolean },
  { epicor: 'Customer_Name', hubspot: 'customer_name' },
  { epicor: 'OrderHed_Character08', hubspot: 'orderhed_characternh' },
  { epicor: 'OrderHed_ShortChar09', hubspot: 'orderhed_shortcharni' },
  { epicor: 'SalesRep_Name', hubspot: 'salesrep_name' },
  { epicor: 'OrderHed_ShortChar01', hubspot: 'orderhed_shortchar01' },
  { epicor: 'OrderHed_ShortChar02', hubspot: 'orderhed_shortchar02' },
  { epicor: 'OrderHed_ShortChar03', hubspot: 'orderhed_shortchar03' },
  { epicor: 'OrderHed_ShortChar04', hubspot: 'orderhed_shortchar04' },
  { epicor: 'OrderHed_UserChar3', hubspot: 'orderhed_userchar3' },
  { epicor: 'OrderHed_Character01', hubspot: 'orderhed_character01' },
  { epicor: 'OrderHed_ShortChar05', hubspot: 'orderhed_shortchar05' },
  { epicor: 'OrderHed_ShortChar06', hubspot: 'orderhed_shortchar06' },
  { epicor: 'OrderHed_ShortChar07', hubspot: 'orderhed_shortchar07' },
  { epicor: 'OrderHed_Character04', hubspot: 'orderhed_character04' },
  { epicor: 'OrderHed_Character05', hubspot: 'orderhed_character05' },
  { epicor: 'OrderHed_Character06', hubspot: 'orderhed_character06' },
  { epicor: 'OrderHed_Character02', hubspot: 'orderhed_character02' },
  { epicor: 'OrderHed_Character03', hubspot: 'orderhed_character03' },
  { epicor: 'Customer_CustomerType', hubspot: 'customer_customertype' },
  { epicor: 'RowIdent', hubspot: 'rowident' },
];

function transformEpicorToHubSpot(epicorOrder) {
  const result = {};
  for (const { epicor, hubspot, transform } of FIELD_MAPPINGS) {
    const value = epicorOrder[epicor];
    if (value != null) {
      const transformed = transform ? transform(value) : value;
      if (transformed != null) result[hubspot] = transformed;
    }
  }
  return result;
}

function generateDealName(epicorOrder) {
  const jobName = epicorOrder.OrderHed_Character08 || 'Unnamed Job';
  const customerName = epicorOrder.Customer_Name || 'Unknown Customer';
  return `${jobName} - ${customerName}`;
}

function chunkArray(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

async function orderService(fastify, _) {
  const { ENDPOINTS, HUBSPOT_PIPELINES, HUBSPOT_DEAL_STAGES, BATCH_SIZES } = fastify.constants;
  const BATCH_SIZE = BATCH_SIZES.ORDERS || 100;
  const UNIQUE_PROPERTY = 'orderhed_ordernum';

  async function infoRecord(data) {
    return await fastify.orderRepository.findByIdProperty(data);
  }

  async function updateDataBase(filter, data) {
    return await fastify.orderRepository.updateDatabase(filter, data);
  }

  async function createDataBase(data) {
    return await fastify.orderRepository.insertDatabase(data);
  }

  async function deleteDataBase(filter) {
    return await fastify.orderRepository.deleteDatabase(filter);
  }

  async function processOrderBatch(orders) {
    const results = {
      total: orders.length,
      created: 0,
      updated: 0,
      errors: 0,
      errorDetails: [],
      skipped: 0
    };

    const batchData = [];
    
    for (const order of orders) {
      try {
        const orderNum = order.OrderHed_OrderNum;
        if (!orderNum) {
          results.skipped++;
          continue;
        }

        const orderNumStr = String(orderNum).trim();
        if (!orderNumStr) {
          results.skipped++;
          continue;
        }

        let properties = transformEpicorToHubSpot(order);
        properties.dealname = generateDealName(order);
        properties.pipeline = HUBSPOT_PIPELINES.QUOTES;
        properties.dealstage = HUBSPOT_DEAL_STAGES.CLOSED_WON;
        
        if (!properties[UNIQUE_PROPERTY]) {
          properties[UNIQUE_PROPERTY] = orderNumStr;
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
          id: orderNumStr,
          properties: cleanProperties
        });
        
      } catch (error) {
        results.errors++;
        results.errorDetails.push({
          error: error.message,
          order: order.OrderHed_OrderNum || 'Unknown'
        });
      }
    }

    if (batchData.length === 0) {
      fastify.log.warn('No valid order data for batch processing');
      return results;
    }

    fastify.log.info(`Prepared ${batchData.length} orders for batch upsert`);

    try {
      const upsertResult = await fastify.backoff(() =>
        fastify.hubspotAdapter.batchUpsertDeals(batchData, UNIQUE_PROPERTY)
      );

      if (upsertResult.status === 'COMPLETE' && upsertResult.results) {
        for (const result of upsertResult.results) {
          const orderNum = result.properties?.[UNIQUE_PROPERTY];
          const originalOrder = orders.find(o => {
            const oNum = o.OrderHed_OrderNum;
            return oNum && String(oNum).trim() === orderNum;
          });
          
          if (originalOrder) {
            const query = {
              epicorId: originalOrder.RowIdent,
              source: 'EpicorOrders',
            };

            const dbData = {
              hubspotId: result.id,
              epicorId: originalOrder.RowIdent,
              source: 'EpicorOrders',
              orderNum: orderNum,
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

      if (upsertResult.numErrors > 0) {
        results.errors += upsertResult.numErrors;
        if (upsertResult.errors) {
          upsertResult.errors.forEach(error => {
            results.errorDetails.push({
              error: error.message,
              category: error.category
            });
          });
        }
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
      await processOrdersIndividually(orders, results);
    }

    return results;
  }

  async function processOrdersIndividually(orders, results) {
    fastify.log.info(`Starting individual processing for ${orders.length} orders...`);
    
    for (const order of orders) {
      const orderNum = order.OrderHed_OrderNum;

      try {
        const query = {
          epicorId: order.RowIdent,
          source: 'EpicorOrders',
        };

        let existRecord = await infoRecord(query);

        if (!existRecord) {
          try {
            const searchData = await fastify.backoff(() =>
              fastify.hubspotAdapter.searchDealsByProperty('orderhed_ordernum', [orderNum])
            );
            existRecord = searchData.results?.[0] || null;
          } catch (searchError) {
            existRecord = null;
          }
        }

        const props = transformEpicorToHubSpot(order);
        props.dealname = generateDealName(order);
        props.pipeline = HUBSPOT_PIPELINES.QUOTES;
        props.dealstage = HUBSPOT_DEAL_STAGES.CLOSED_WON;

        Object.keys(props).forEach(key => {
          if (props[key] === null || props[key] === undefined) {
            delete props[key];
          }
        });

        if (existRecord?.id || existRecord?.hubspotId) {
          const dealId = existRecord?.hubspotId || existRecord?.id;

          try {
            await fastify.backoff(() =>
              fastify.hubspotAdapter.updateDeal({ dealId, properties: props })
            );
          } catch (error) {
            if (error?.response?.data?.message?.toLowerCase() === 'resource not found') {
              await deleteDataBase(query);
              fastify.log.warn(`Order ${orderNum} deleted from DB`);
            } else {
              throw error;
            }
          }

          const action = 'updated';
          fastify.log.info(`Order ${orderNum} ${action} in HubSpot ${dealId}`);

          if (existRecord?.hubspotId) {
            await updateDataBase(query, { action });
          } else {
            await createDataBase({
              hubspotId: dealId,
              epicorId: order.RowIdent,
              source: 'EpicorOrders',
              orderNum: orderNum,
              action: 'create'
            });
          }

          results.updated++;
        } else {
          const created = await fastify.backoff(() =>
            fastify.hubspotAdapter.createDeal({ properties: props })
          );
          const dealId = created.id;

          fastify.log.info(`Order ${orderNum} created in HubSpot ${dealId}`);

          await createDataBase({
            hubspotId: dealId,
            epicorId: order.RowIdent,
            source: 'EpicorOrders',
            orderNum: orderNum,
            action: 'create'
          });

          results.created++;
        }

      } catch (error) {
        fastify.log.error(`Order ${orderNum} failed: ${error.message}`);
        results.errors++;
      }
    }
    
    fastify.log.info(`Individual processing complete: ${results.created} created, ${results.updated} updated, ${results.errors} errors`);
  }

  async function taskOrders(dateString) {
    try {
      fastify.log.info('Fetching orders from Epicor...');
      const { records, metadata } = await fastify.epicorAdapter.fetchFilteredRecords(ENDPOINTS.ORDERS);
      
      if (!records?.length) {
        return { success: false, message: 'No orders found', metadata };
      }

      const orderMap = new Map();
      for (const order of records) {
        const orderNum = order.OrderHed_OrderNum;
        const existing = orderMap.get(orderNum);
        if (!existing || order.Calculated_Time > existing.Calculated_Time) {
          orderMap.set(orderNum, order);
        }
      }

      const uniqueRecords = Array.from(orderMap.values());
      fastify.log.info(`Fetched ${records.length} orders, deduplicated to ${uniqueRecords.length}, starting batch sync...`);

      const batches = chunkArray(uniqueRecords, BATCH_SIZE);
      const batchResults = [];
      
      for (let i = 0; i < batches.length; i++) {
        fastify.log.info(`Processing batch ${i + 1}/${batches.length} (${batches[i].length} orders)...`);
        const result = await processOrderBatch(batches[i]);
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
      
      fastify.log.info(`Order sync complete: ${totalResults.created} created, ${totalResults.updated} updated, ${totalResults.errors} errors, ${totalResults.skipped} skipped`);

      return {
        success: true,
        syncedCount: uniqueRecords.length,
        createdCount: totalResults.created,
        updatedCount: totalResults.updated,
        errorCount: totalResults.errors,
        skippedCount: totalResults.skipped,
        totalEpicorOrders: records.length,
        batchCount: batches.length,
        metadata
      };
    } catch (error) {
      fastify.log.error(`Error processing Task Orders: ${error.message}`);
      throw error;
    }
  }

  async function task(dateString) {
    try {
      fastify.log.info('Processing Tasks for Orders');
      return await taskOrders(dateString);
    } catch (error) {
      fastify.log.error(`Error processing Tasks for Orders: ${error.message}`);
      throw error;
    }
  }

  if (!fastify.hasDecorator('orderTask')) {
    fastify.decorate('orderTask', { task });
  }
}

export default fp(orderService, {
  name: 'orderServices',
  dependencies: [
    'orderRepository',
    'epicorAdapter',
    'hubspotAdapter',
    'backoff',
    'constants',
  ],
});