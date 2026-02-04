import fp from 'fastify-plugin';

const padCustNum = (value) => {
  if (!value) return null;
  const str = String(value).trim();
  return str.padStart(4, '0');
};

const toMidnightUTC = (v) => {
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
};

const FIELD_MAPPINGS = [
  { epicor: 'OrderHed_OrderNum', hubspot: 'orderhed_ordernum', transform: String },
  { epicor: 'OrderHed_CustNum', hubspot: 'orderhed_custnum', transform: padCustNum },
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

async function orderService(fastify, _) {
  const { ENDPOINTS, HUBSPOT_PIPELINES, HUBSPOT_DEAL_STAGES } = fastify.constants;

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

  async function updateMatchingQuote(quoteNum, orderNum, quoteDealId) {
    try {
      await fastify.backoff(() =>
        fastify.hubspotAdapter.updateDeal({
          dealId: quoteDealId,
          properties: {
            pipeline: HUBSPOT_PIPELINES.QUOTES,
            dealstage: HUBSPOT_DEAL_STAGES.CLOSED_WON
          }
        })
      );
      fastify.log.info(`Updated matching quote ${quoteNum} to Closed Won (deal ${quoteDealId})`);
      
      try {
        await fastify.orderProdMixService.syncLineItemsForOrder(orderNum, quoteDealId);
        fastify.log.info(`Updated line items for quote ${quoteNum} with order ${orderNum} data`);
      } catch (quoteLineItemError) {
        fastify.log.warn(`Failed to sync line items for quote ${quoteNum}: ${quoteLineItemError.message}`);
      }
    } catch (quoteUpdateError) {
      fastify.log.warn(`Failed to update matching quote ${quoteNum} for order ${orderNum}: ${quoteUpdateError.message}`);
    }
  }

  async function processOrdersIndividually(orders, results) {
    fastify.log.info(`Starting individual processing for ${orders.length} orders...`);
    
    for (const order of orders) {
      const orderNum = order.OrderHed_OrderNum;
      let props = {};

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

        props = transformEpicorToHubSpot(order);
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
            await updateDataBase(query, { action, timestamp: new Date() });
          } else {
            await createDataBase({
              hubspotId: dealId,
              epicorId: order.RowIdent,
              source: 'EpicorOrders',
              orderNum: orderNum,
              action: 'create',
              timestamp: new Date()
            });
          }

          try {
            await fastify.orderProdMixService.syncLineItemsForOrder(orderNum, dealId);
          } catch (lineItemError) {
            fastify.log.warn(`Failed to sync line items for order ${orderNum}: ${lineItemError.message}`);
          }

          try {
            const custNum = order.OrderHed_CustNum ? padCustNum(order.OrderHed_CustNum) : null;
            if (custNum) {
              const companySearch = await fastify.backoff(() =>
                fastify.hubspotAdapter.searchCompaniesByProperty('customer_custnum', [custNum])
              );
              if (companySearch.results?.[0]?.id) {
                await fastify.hubspotAdapter.createAssociation(
                  'companies',
                  companySearch.results[0].id,
                  'deals',
                  dealId,
                  341
                );
                fastify.log.info(`Associated order deal ${dealId} with company ${companySearch.results[0].id}`);
              }
            }
          } catch (associationError) {
            fastify.log.warn(`Failed to associate company for order ${orderNum}: ${associationError.message}`);
          }

          // Check if this order has a matching quote and update it to Closed Won
          const quoteNum = order.OrderDtl_QuoteNum;
          if (quoteNum) {
            const quoteSearchData = await fastify.backoff(() =>
              fastify.hubspotAdapter.searchDealsByProperty('quotehed_quotenum_', [quoteNum])
            );
            if (quoteSearchData.results?.[0]?.id) {
              await updateMatchingQuote(quoteNum, orderNum, quoteSearchData.results[0].id);
            }
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
            action: 'create',
            timestamp: new Date()
          });

          try {
            await fastify.orderProdMixService.syncLineItemsForOrder(orderNum, dealId);
          } catch (lineItemError) {
            fastify.log.warn(`Failed to sync line items for order ${orderNum}: ${lineItemError.message}`);
          }

          try {
            const custNum = order.OrderHed_CustNum ? padCustNum(order.OrderHed_CustNum) : null;
            if (custNum) {
              const companySearch = await fastify.backoff(() =>
                fastify.hubspotAdapter.searchCompaniesByProperty('customer_custnum', [custNum])
              );
              if (companySearch.results?.[0]?.id) {
                await fastify.hubspotAdapter.createAssociation(
                  'companies',
                  companySearch.results[0].id,
                  'deals',
                  dealId,
                  341
                );
                fastify.log.info(`Associated order deal ${dealId} with company ${companySearch.results[0].id}`);
              }
            }
          } catch (associationError) {
            fastify.log.warn(`Failed to associate company for order ${orderNum}: ${associationError.message}`);
          }

          // Check if this order has a matching quote and update it to Closed Won
          const quoteNum = order.OrderDtl_QuoteNum;
          if (quoteNum) {
            const quoteSearchData = await fastify.backoff(() =>
              fastify.hubspotAdapter.searchDealsByProperty('quotehed_quotenum_', [quoteNum])
            );
            if (quoteSearchData.results?.[0]?.id) {
              await updateMatchingQuote(quoteNum, orderNum, quoteSearchData.results[0].id);
            }
          }

          results.created++;
        }

      } catch (error) {
        fastify.log.error(`Individual order ${orderNum} failed:`, {
          error: error.message,
          stack: error.stack,
          orderNum: orderNum,
          orderData: {
            OrderHed_OrderNum: order.OrderHed_OrderNum,
            OrderHed_CustNum: order.OrderHed_CustNum,
            Customer_Name: order.Customer_Name,
            dealname: generateDealName(order)
          },
          properties: props
        });
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
      fastify.log.info(`Fetched ${records.length} orders, deduplicated to ${uniqueRecords.length}, starting individual sync...`);

      const results = {
        total: uniqueRecords.length,
        created: 0,
        updated: 0,
        errors: 0,
        skipped: 0
      };

      await processOrdersIndividually(uniqueRecords, results);
      
      const totalResults = results;
      
      fastify.log.info(`Order sync complete: ${totalResults.created} created, ${totalResults.updated} updated, ${totalResults.errors} errors, ${totalResults.skipped} skipped`);

      return {
        success: true,
        syncedCount: uniqueRecords.length,
        createdCount: totalResults.created,
        updatedCount: totalResults.updated,
        errorCount: totalResults.errors,
        skippedCount: totalResults.skipped,
        totalEpicorOrders: records.length,
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
    'orderProdMixService',
    'epicorAdapter',
    'hubspotAdapter',
    'backoff',
    'constants',
  ],
});