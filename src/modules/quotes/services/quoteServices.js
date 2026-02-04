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

const toValidSalesRep = (v) => {
  if (!v) return 'Unknown Option';
  const validOptions = [
    'House', 'Mike Kilcoyne and Associates', 'Phillips Contract Group, LLC', 'CYA',
    'Reagan Penny', 'Dan Martin', 'Murphy Associates', 'Bruce Longhino Group',
    'Morgan Associates', 'Mike Fabionar', 'Ginger Grant', 'Lauren East',
    'Elizabeth Gerber', 'Jennifer Gates', 'John Parrish', 'Unknown Option'
  ];
  return validOptions.includes(v) ? v : 'Unknown Option';
};

const FIELD_MAPPINGS = [
  { epicor: 'QuoteHed_QuoteNum', hubspot: 'quotehed_quotenum_', transform: String },
  { epicor: 'QuoteHed_CustNum', hubspot: 'quotehed_custnum', transform: padCustNum },
  { epicor: 'Customer_Name', hubspot: 'customer_name' },
  { epicor: 'Task_Conclusion', hubspot: 'task_conclusion' },
  { epicor: 'QuoteHed_EntryDate', hubspot: 'quotehed_entrydate', transform: toMidnightUTC },
  { epicor: 'QuoteHed_CurrentStage', hubspot: 'quotehed_currentstage' },
  { epicor: 'QuoteHed_Character08', hubspot: 'quotehed_character08' },
  { epicor: 'QuoteHed_ShortChar09', hubspot: 'quotehed_shortchar09' },
  { epicor: 'QuoteHed_Character10', hubspot: 'quotehed_character10' },
  { epicor: 'SalesRep_Name', hubspot: 'salesrep_name', transform: toValidSalesRep },
  { epicor: 'QuoteHed_ShortChar01', hubspot: 'quotehed_shortchar01' },
  { epicor: 'QuoteHed_ShortChar02', hubspot: 'quotehed_shortchar02' },
  { epicor: 'QuoteHed_ShortChar03', hubspot: 'quotehed_shortchar03' },
  { epicor: 'QuoteHed_ShortChar04', hubspot: 'quotehed_shortchar04' },
  { epicor: 'QuoteHed_UserChar3', hubspot: 'quotehed_userchar3' },
  { epicor: 'QuoteHed_Character01', hubspot: 'quotehed_character01' },
  { epicor: 'QuoteHed_ShortChar05', hubspot: 'quotehed_shortchar05' },
  { epicor: 'QuoteHed_ShortChar06', hubspot: 'quotehed_shortchar06' },
  { epicor: 'QuoteHed_ShortChar07', hubspot: 'quotehed_shortchar07' },
  { epicor: 'QuoteHed_Character04', hubspot: 'quotehed_character04' },
  { epicor: 'QuoteHed_Character05', hubspot: 'quotehed_character05' },
  { epicor: 'QuoteHed_Character06', hubspot: 'quotehed_character06' },
  { epicor: 'QuoteHed_Character02', hubspot: 'quotehed_character02' },
  { epicor: 'QuoteHed_Character03', hubspot: 'quotehed_character03' },
  { epicor: 'Customer_CustomerType', hubspot: 'customer_customertype' },
  { epicor: 'Task_TaskComment', hubspot: 'task_taskcomment' },
  { epicor: 'RowIdent', hubspot: 'rowident' },
];

function transformEpicorToHubSpot(epicorQuote) {
  const result = {};
  for (const { epicor, hubspot, transform } of FIELD_MAPPINGS) {
    const value = epicorQuote[epicor];
    if (value != null) {
      const transformed = transform ? transform(value) : value;
      if (transformed != null) result[hubspot] = transformed;
    }
  }
  return result;
}

function generateDealName(epicorQuote) {
  const jobName = epicorQuote.QuoteHed_Character08 || 'Unnamed Job';
  const customerName = epicorQuote.Customer_Name || 'Unknown Customer';
  return `${jobName} - ${customerName}`;
}

async function quoteService(fastify, _) {
  const { ENDPOINTS, HUBSPOT_PIPELINES, HUBSPOT_DEAL_STAGES } = fastify.constants;

  async function infoRecord(data) {
    return await fastify.quoteRepository.findByIdProperty(data);
  }

  async function updateDataBase(filter, data) {
    return await fastify.quoteRepository.updateDatabase(filter, data);
  }

  async function createDataBase(data) {
    return await fastify.quoteRepository.insertDatabase(data);
  }

  async function deleteDataBase(filter) {
    return await fastify.quoteRepository.deleteDatabase(filter);
  }

  async function processQuotesIndividually(quotes, results) {
    fastify.log.info(`Starting individual processing for ${quotes.length} quotes...`);
    
    for (const quote of quotes) {
      const quoteNum = quote.QuoteHed_QuoteNum;
      let props = {};

      try {
        const query = {
          epicorId: quote.RowIdent,
          source: 'EpicorQuotes',
        };

        let existRecord = await infoRecord(query);

        if (!existRecord) {
          try {
            const searchData = await fastify.backoff(() =>
              fastify.hubspotAdapter.searchDealsByProperty('quotehed_quotenum_', [quoteNum])
            );
            existRecord = searchData.results?.[0] || null;
            fastify.log.info(`Search completed for quote ${quoteNum}: ${existRecord ? 'Found existing deal ' + existRecord.id : 'No existing deal found'}`);
          } catch (searchError) {
            fastify.log.error({
              quoteNum,
              searchErrorMessage: searchError.message,
              status: searchError.response?.status,
              statusText: searchError.response?.statusText,
              hubspotError: JSON.stringify(searchError.response?.data),
              validationResults: JSON.stringify(searchError.response?.data?.validationResults)
            }, `Search failed for quote ${quoteNum}`);
            existRecord = null;
          }
        }

        props = transformEpicorToHubSpot(quote);
        props.dealname = generateDealName(quote);
        const isWon = props.task_conclusion === 'WIN';
        
        props.pipeline = HUBSPOT_PIPELINES.QUOTES;
        if (isWon) {
          props.dealstage = HUBSPOT_DEAL_STAGES.CLOSED_WON;
        } else if (!existRecord) {
          props.dealstage = HUBSPOT_DEAL_STAGES.QUOTE_CREATED;
        }

        Object.keys(props).forEach(key => {
          if (props[key] === null || props[key] === undefined || props[key] === '') {
            delete props[key];
          }
        });

        if (existRecord?.id || existRecord?.hubspotId) {
          const dealId = existRecord?.hubspotId || existRecord?.id;

          try {
            const updateProps = { ...props };
            if (!isWon) {
              delete updateProps.pipeline;
              delete updateProps.dealstage;
            }
            await fastify.backoff(() =>
              fastify.hubspotAdapter.updateDeal({ dealId, properties: updateProps })
            );
          } catch (error) {
            if (error?.response?.data?.message?.toLowerCase() === 'resource not found') {
              await deleteDataBase(query);
              fastify.log.warn(`Quote ${quoteNum} deleted from DB`);
            } else {
              throw error;
            }
          }

          const action = isWon ? 'updated_to_closed_won' : 'updated';
          fastify.log.info(`Quote ${quoteNum} ${action} in HubSpot ${dealId}`);

          if (existRecord?.hubspotId) {
            await updateDataBase(query, { action, timestamp: new Date() });
          } else {
            await createDataBase({
              hubspotId: dealId,
              epicorId: quote.RowIdent,
              source: 'EpicorQuotes',
              quoteNum: quoteNum,
              action: 'create',
              timestamp: new Date()
            });
          }

          try {
            await fastify.quoteProdMixService.syncLineItemsForQuote(quoteNum, dealId);
          } catch (lineItemError) {
            fastify.log.warn(`Failed to sync QuoteProdMix line items for quote ${quoteNum}: ${lineItemError.message}`);
          }

          try {
            await fastify.qSeatEtabService.syncLineItemsForQuote(quoteNum, dealId);
          } catch (lineItemError) {
            fastify.log.warn(`Failed to sync QSeatEtab line items for quote ${quoteNum}: ${lineItemError.message}`);
          }

          try {
            const custNum = quote.QuoteHed_CustNum ? padCustNum(quote.QuoteHed_CustNum) : null;
            fastify.log.info(`Quote ${quoteNum} UPDATE - Raw CustNum: ${quote.QuoteHed_CustNum}, Padded: ${custNum}`);
            if (custNum) {
              const companySearch = await fastify.backoff(() =>
                fastify.hubspotAdapter.searchCompaniesByProperty('customer_custnum', [custNum])
              );
              fastify.log.info(`Quote ${quoteNum} UPDATE - Company search results: ${companySearch.results?.length || 0}`);
              if (companySearch.results?.[0]?.id) {
                fastify.log.info(`Quote ${quoteNum} UPDATE - Attempting to associate company ${companySearch.results[0].id} with deal ${dealId} using type 5`);
                const associationResult = await fastify.hubspotAdapter.createAssociation(
                  'companies',
                  companySearch.results[0].id,
                  'deals',
                  dealId,
                  5
                );
                fastify.log.info(`Quote ${quoteNum} UPDATE - Association result: ${JSON.stringify(associationResult?.data || associationResult)}`);
              } else {
                fastify.log.warn(`Quote ${quoteNum} UPDATE - No company found with customer_custnum=${custNum}`);
              }
            } else {
              fastify.log.warn(`Quote ${quoteNum} UPDATE - No custNum (QuoteHed_CustNum was empty)`);
            }
          } catch (associationError) {
            fastify.log.error(`Quote ${quoteNum} UPDATE - Failed to associate: ${associationError.message}`, associationError.response?.data || associationError);
          }

          results.updated++;
        } else {
          const created = await fastify.backoff(() =>
            fastify.hubspotAdapter.createDeal({ properties: props })
          );
          const dealId = created.id;

          fastify.log.info(`Quote ${quoteNum} created in HubSpot ${dealId}`);

          await createDataBase({
            hubspotId: dealId,
            epicorId: quote.RowIdent,
            source: 'EpicorQuotes',
            quoteNum: quoteNum,
            action: 'create',
            timestamp: new Date()
          });

          try {
            await fastify.quoteProdMixService.syncLineItemsForQuote(quoteNum, dealId);
          } catch (lineItemError) {
            fastify.log.warn(`Failed to sync QuoteProdMix line items for quote ${quoteNum}: ${lineItemError.message}`);
          }

          try {
            await fastify.qSeatEtabService.syncLineItemsForQuote(quoteNum, dealId);
          } catch (lineItemError) {
            fastify.log.warn(`Failed to sync QSeatEtab line items for quote ${quoteNum}: ${lineItemError.message}`);
          }

          try {
            const custNum = quote.QuoteHed_CustNum ? padCustNum(quote.QuoteHed_CustNum) : null;
            fastify.log.info(`Quote ${quoteNum} CREATE - Raw CustNum: ${quote.QuoteHed_CustNum}, Padded: ${custNum}`);
            if (custNum) {
              const companySearch = await fastify.backoff(() =>
                fastify.hubspotAdapter.searchCompaniesByProperty('customer_custnum', [custNum])
              );
              fastify.log.info(`Quote ${quoteNum} CREATE - Company search results: ${companySearch.results?.length || 0}`);
              if (companySearch.results?.[0]?.id) {
                fastify.log.info(`Quote ${quoteNum} CREATE - Attempting to associate company ${companySearch.results[0].id} with deal ${dealId} using type 5`);
                const associationResult = await fastify.hubspotAdapter.createAssociation(
                  'companies',
                  companySearch.results[0].id,
                  'deals',
                  dealId,
                  5
                );
                fastify.log.info(`Quote ${quoteNum} CREATE - Association result: ${JSON.stringify(associationResult?.data || associationResult)}`);
              } else {
                fastify.log.warn(`Quote ${quoteNum} CREATE - No company found with customer_custnum=${custNum}`);
              }
            } else {
              fastify.log.warn(`Quote ${quoteNum} CREATE - No custNum (QuoteHed_CustNum was empty)`);
            }
          } catch (associationError) {
            fastify.log.error(`Quote ${quoteNum} CREATE - Failed to associate: ${associationError.message}`, associationError.response?.data || associationError);
          }

          results.created++;
        }

      } catch (error) {
        fastify.log.error({
          quoteNum,
          status: error.response?.status,
          statusText: error.response?.statusText,
          hubspotError: JSON.stringify(error.response?.data),
          hubspotMessage: error.response?.data?.message,
          category: error.response?.data?.category,
          validationResults: JSON.stringify(error.response?.data?.validationResults),
          errors: JSON.stringify(error.response?.data?.errors),
          stack: error.stack
        }, `Individual quote ${quoteNum} failed: ${error.message}`);
        results.errors++;
      }
    }
    
    fastify.log.info(`Individual processing complete: ${results.created} created, ${results.updated} updated, ${results.errors} errors`);
  }

  async function taskQuotes(dateString) {
    try {
      fastify.log.info('Fetching quotes from Epicor...');
      const { records, metadata } = await fastify.epicorAdapter.fetchFilteredRecords(ENDPOINTS.QUOTES);
      
      if (!records?.length) {
        return { success: false, message: 'No quotes found', metadata };
      }

      const quoteMap = new Map();
      for (const quote of records) {
        const quoteNum = quote.QuoteHed_QuoteNum;
        const existing = quoteMap.get(quoteNum);
        if (!existing || quote.Calculated_Time > existing.Calculated_Time) {
          quoteMap.set(quoteNum, quote);
        }
      }

      const uniqueRecords = Array.from(quoteMap.values());
      fastify.log.info(`Fetched ${records.length} quotes, deduplicated to ${uniqueRecords.length}, starting individual sync...`);
      
      const results = {
        total: uniqueRecords.length,
        created: 0,
        updated: 0,
        errors: 0,
        skipped: 0
      };

      await processQuotesIndividually(uniqueRecords, results);
      
      const totalResults = results;
      
      fastify.log.info(`Quote sync complete: ${totalResults.created} created, ${totalResults.updated} updated, ${totalResults.errors} errors, ${totalResults.skipped} skipped`);

      return {
        success: true,
        syncedCount: uniqueRecords.length,
        createdCount: totalResults.created,
        updatedCount: totalResults.updated,
        errorCount: totalResults.errors,
        skippedCount: totalResults.skipped,
        totalEpicorQuotes: records.length,
        metadata
      };
    } catch (error) {
      fastify.log.error(`Error processing Task Quotes: ${error.message}`);
      throw error;
    }
  }

  async function task(dateString) {
    try {
      fastify.log.info('Processing Tasks for Quotes');
      return await taskQuotes(dateString);
    } catch (error) {
      fastify.log.error(`Error processing Tasks for Quotes: ${error.message}`);
      throw error;
    }
  }

  if (!fastify.hasDecorator('quoteTask')) {
    fastify.decorate('quoteTask', { task });
  }
}

export default fp(quoteService, {
  name: 'quoteServices',
  dependencies: [
    'quoteRepository',
    'quoteProdMixService',
    'qSeatEtabService',
    'epicorAdapter',
    'hubspotAdapter',
    'backoff',
    'constants',
  ],
});