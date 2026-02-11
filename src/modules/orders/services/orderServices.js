import fp from 'fastify-plugin';
import { padCustNum } from '../../../utils/arrayHelpers.js';

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
  { epicor: 'OrderHed_SysRowID', hubspot: 'rowident' },
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
  const { ENDPOINTS, HUBSPOT_PIPELINES, HUBSPOT_DEAL_STAGES, HUBSPOT_ASSOCIATIONS } = fastify.constants;

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

  async function ensureDealCompanyAssociation(dealId, companyId) {
    if (!dealId || !companyId) return { skipped: true };
    if (HUBSPOT_ASSOCIATIONS.DEAL_TO_COMPANY == null) {
      fastify.log.warn('Missing HUBSPOT_ASSOCIATION_DEAL_TO_COMPANY for deal/company associations');
      return { skipped: true };
    }
    return await fastify.hubspotAdapter.ensureAssociation(
      'deals',
      dealId,
      'companies',
      companyId,
      HUBSPOT_ASSOCIATIONS.DEAL_TO_COMPANY
    );
  }

  async function updateMatchingQuote(quoteNum, orderNum, quoteDealId) {
    try {
      const properties = {};
      if (HUBSPOT_PIPELINES.QUOTES) properties.pipeline = HUBSPOT_PIPELINES.QUOTES;
      if (HUBSPOT_DEAL_STAGES.CLOSED_WON) properties.dealstage = HUBSPOT_DEAL_STAGES.CLOSED_WON;

      if (Object.keys(properties).length === 0) {
        fastify.log.warn(`Skipping quote update for ${quoteNum}: missing HUBSPOT_PIPELINE_QUOTES or HUBSPOT_DEAL_STAGE_CLOSED_WON`);
      } else {
        await fastify.backoff(() =>
          fastify.hubspotAdapter.updateDeal({
            dealId: quoteDealId,
            properties
          })
        );
        fastify.log.info(`Updated matching quote ${quoteNum} to Closed Won (deal ${quoteDealId})`);
      }
      
      try {
        await fastify.orderProdMixService.syncLineItemsForOrder(orderNum, quoteDealId);
        fastify.log.info(`Updated line items for quote ${quoteNum} with order ${orderNum} data`);
      } catch (quoteLineItemError) {
        fastify.log.warn(`Failed to sync line items for quote ${quoteNum}: ${quoteLineItemError.message}`);
      }
    } catch (quoteUpdateError) {
      fastify.log.warn(`Failed to update matching quote ${quoteNum} for order ${orderNum}: ${quoteUpdateError.message}: ${quoteUpdateError.response}: ${quoteUpdateError.response?.data}: ${quoteUpdateError.response?.data?.message}`);
    }
  }

  async function processOrdersIndividually(orders, results) {
    fastify.log.info(`Starting individual processing for ${orders.length} orders...`);
    
    for (const order of orders) {
      const orderNum = order.OrderHed_OrderNum;
      const quoteNum = order.OrderDtl_QuoteNum;
      let props = {};
      let usedQuoteDeal = false;

      try {
        const query = {
          epicorId: order.OrderHed_SysRowID,
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

        if (!existRecord && quoteNum) {
          try {
            const quoteSearch = await fastify.backoff(() =>
              fastify.hubspotAdapter.searchDealsByProperty('quotehed_quotenum_', [quoteNum])
            );
            if (quoteSearch.results?.[0]) {
              existRecord = quoteSearch.results[0];
              usedQuoteDeal = true;
              fastify.log.info(`Order ${orderNum} matched existing quote deal ${existRecord.id} for quote ${quoteNum}`);
            }
          } catch (searchError) {
            fastify.log.warn(`Order ${orderNum} quote match search failed: ${searchError.message}`);
          }
        }

        if (!existRecord) {
          const dealName = generateDealName(order);
          try {
            const nameSearch = await fastify.backoff(() =>
              fastify.hubspotAdapter.searchDealsByProperty('dealname', [dealName])
            );
            existRecord = nameSearch.results?.[0] || null;
            if (existRecord) {
              fastify.log.info(`Order ${orderNum} matched deal by name ${existRecord.id}`);
            }
          } catch (searchError) {
            fastify.log.warn(`Order ${orderNum} deal name search failed: ${searchError.message}`);
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
          let needsCreate = false;

          try {
            await fastify.backoff(() =>
              fastify.hubspotAdapter.updateDeal({ dealId, properties: props })
            );
          } catch (error) {
            const status = error?.cause?.response?.status || error?.response?.status;
            const message = error?.cause?.response?.data?.message || error?.response?.data?.message;
            if (status === 404 || String(message || '').toLowerCase() === 'resource not found') {
              await deleteDataBase(query);
              fastify.log.warn(`Order ${orderNum} deleted from DB because HubSpot deal ${dealId} was not found`);
              needsCreate = true;
            } else {
              throw error;
            }
          }

          if (needsCreate) {
            const created = await fastify.backoff(() =>
              fastify.hubspotAdapter.createDeal({ properties: props })
            );
            const newDealId = created.id;

            fastify.log.info(`Order ${orderNum} recreated in HubSpot ${newDealId}`);

            await createDataBase({
              hubspotId: newDealId,
              epicorId: order.OrderHed_SysRowID,
              source: 'EpicorOrders',
              orderNum: orderNum,
              action: 'create',
              timestamp: new Date()
            });

            try {
              await fastify.orderProdMixService.syncLineItemsForOrder(orderNum, newDealId);
            } catch (lineItemError) {
              fastify.log.warn(`Failed to sync line items for order ${orderNum}: ${lineItemError.message}`);
            }

            try {
              const custNum = order.OrderHed_CustNum ? padCustNum(order.OrderHed_CustNum) : null;
              fastify.log.info(`Order ${orderNum} CREATE - Raw CustNum: ${order.OrderHed_CustNum}, Padded: ${custNum}`);
              if (custNum) {
                const companySearch = await fastify.backoff(() =>
                  fastify.hubspotAdapter.searchCompaniesByProperty('customer_custnum', [custNum])
                );
                fastify.log.info(`Order ${orderNum} CREATE - Company search results: ${companySearch.results?.length || 0}`);
                if (companySearch.results?.[0]?.id) {
                  fastify.log.info(`Order ${orderNum} CREATE - Attempting to associate deal ${newDealId} with company ${companySearch.results[0].id} using type 5`);
                  const assocResult = await ensureDealCompanyAssociation(newDealId, companySearch.results[0].id);
                  fastify.log.info(`Order ${orderNum} CREATE - Deal/company association ${assocResult?.skipped ? 'skipped' : 'created'}`);
                } else {
                  fastify.log.warn(`Order ${orderNum} CREATE - No company found with customer_custnum=${custNum}`);
                }
              } else {
                fastify.log.warn(`Order ${orderNum} CREATE - No custNum (OrderHed_CustNum was empty)`);
              }
            } catch (associationError) {
              fastify.log.error(`Order ${orderNum} CREATE - Failed to associate: ${associationError.message} [${associationError.response?.status || 'no-status'}]`);
            }

            // Check if this order has a matching quote and update it to Closed Won
            if (quoteNum && !usedQuoteDeal) {
              const quoteSearchData = await fastify.backoff(() =>
                fastify.hubspotAdapter.searchDealsByProperty('quotehed_quotenum_', [quoteNum])
              );
              if (quoteSearchData.results?.[0]?.id) {
                await updateMatchingQuote(quoteNum, orderNum, quoteSearchData.results[0].id);
              }
            }

            results.created++;
            continue;
          }

          const action = 'updated';
          fastify.log.info(`Order ${orderNum} ${action} in HubSpot ${dealId}`);

          if (existRecord?.hubspotId) {
            await updateDataBase(query, { action, timestamp: new Date() });
          } else {
            await createDataBase({
              hubspotId: dealId,
              epicorId: order.OrderHed_SysRowID,
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
            fastify.log.info(`Order ${orderNum} UPDATE - Raw CustNum: ${order.OrderHed_CustNum}, Padded: ${custNum}`);
            if (custNum) {
              const companySearch = await fastify.backoff(() =>
                fastify.hubspotAdapter.searchCompaniesByProperty('customer_custnum', [custNum])
              );
              fastify.log.info(`Order ${orderNum} UPDATE - Company search results: ${companySearch.results?.length || 0}`);
              if (companySearch.results?.[0]?.id) {
                fastify.log.info(`Order ${orderNum} UPDATE - Attempting to associate deal ${dealId} with company ${companySearch.results[0].id} using type 5`);
                const assocResult = await ensureDealCompanyAssociation(dealId, companySearch.results[0].id);
                fastify.log.info(`Order ${orderNum} UPDATE - Deal/company association ${assocResult?.skipped ? 'skipped' : 'created'}`);
              } else {
                fastify.log.warn(`Order ${orderNum} UPDATE - No company found with customer_custnum=${custNum}`);
              }
            } else {
              fastify.log.warn(`Order ${orderNum} UPDATE - No custNum (OrderHed_CustNum was empty)`);
            }
          } catch (associationError) {
            fastify.log.error(`Order ${orderNum} UPDATE - Failed to associate: ${associationError.message} [${associationError.response?.status || 'no-status'}]`);
          }

          // Check if this order has a matching quote and update it to Closed Won
          if (quoteNum && !usedQuoteDeal) {
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
            epicorId: order.OrderHed_SysRowID,
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
            fastify.log.info(`Order ${orderNum} CREATE - Raw CustNum: ${order.OrderHed_CustNum}, Padded: ${custNum}`);
            if (custNum) {
              const companySearch = await fastify.backoff(() =>
                fastify.hubspotAdapter.searchCompaniesByProperty('customer_custnum', [custNum])
              );
              fastify.log.info(`Order ${orderNum} CREATE - Company search results: ${companySearch.results?.length || 0}`);
              if (companySearch.results?.[0]?.id) {
                fastify.log.info(`Order ${orderNum} CREATE - Attempting to associate deal ${dealId} with company ${companySearch.results[0].id} using type 5`);
                const assocResult = await ensureDealCompanyAssociation(dealId, companySearch.results[0].id);
                fastify.log.info(`Order ${orderNum} CREATE - Deal/company association ${assocResult?.skipped ? 'skipped' : 'created'}`);
              } else {
                fastify.log.warn(`Order ${orderNum} CREATE - No company found with customer_custnum=${custNum}`);
              }
            } else {
              fastify.log.warn(`Order ${orderNum} CREATE - No custNum (OrderHed_CustNum was empty)`);
            }
          } catch (associationError) {
            fastify.log.error(`Order ${orderNum} CREATE - Failed to associate: ${associationError.message} [${associationError.response?.status || 'no-status'}]`);
          }
          // Check if this order has a matching quote and update it to Closed Won
          if (quoteNum && !usedQuoteDeal) {
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
        fastify.log.error(`Individual order ${orderNum} failed: ${error.message} [${error.response?.status || 'no-status'}]`);
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