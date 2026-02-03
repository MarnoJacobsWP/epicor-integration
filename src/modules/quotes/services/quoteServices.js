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

const VALID_SALESREP_NAMES = [
  'House', 'Mike Kilcoyne and Associates', 'Phillips Contract Group, LLC', 'CYA',
  'Reagan Penny', 'Dan Martin', 'Murphy Associates', 'Bruce Longhino Group',
  'Morgan Associates', 'Mike Fabionar', 'Ginger Grant', 'Lauren East',
  'Elizabeth Gerber', 'Jennifer Gates', 'Unknown Option'
];

const toValidSalesRep = (v) => {
  if (!v) return 'Unknown Option';
  return VALID_SALESREP_NAMES.includes(v) ? v : 'Unknown Option';
};

const FIELD_MAPPINGS = [
  { epicor: 'QuoteHed_QuoteNum', hubspot: 'quotehed_quotenum', transform: String },
  { epicor: 'QuoteHed_CustNum', hubspot: 'quotehed_custnum', transform: padCustNum },
  { epicor: 'Customer_Name', hubspot: 'customer_name' },
  { epicor: 'Task_Conclusion', hubspot: 'task_conclusion' },
  //{ epicor: 'QuoteHed_EntryDate', hubspot: 'quotehed_entrydate', transform: toMidnightUTC },
  //{ epicor: 'QuoteHed_CurrentStage', hubspot: 'quotehed_currentstage' },
  //{ epicor: 'QuoteHed_Character08', hubspot: 'quotehed_character08' },
  //{ epicor: 'QuoteHed_ShortChar09', hubspot: 'quotehed_shortchar09' },
  //{ epicor: 'QuoteHed_Character10', hubspot: 'quotehed_character10' },
  //{ epicor: 'SalesRep_Name', hubspot: 'salesrep_name', transform: toValidSalesRep },
  //{ epicor: 'QuoteHed_ShortChar01', hubspot: 'quotehed_shortchar01' },
  //{ epicor: 'QuoteHed_ShortChar02', hubspot: 'quotehed_shortchar02' },
  //{ epicor: 'QuoteHed_ShortChar03', hubspot: 'quotehed_shortchar03' },
  //{ epicor: 'QuoteHed_ShortChar04', hubspot: 'quotehed_shortchar04' },
  //{ epicor: 'QuoteHed_UserChar3', hubspot: 'quotehed_userchar3' },
  //{ epicor: 'QuoteHed_Character01', hubspot: 'quotehed_character01' },
  //{ epicor: 'QuoteHed_ShortChar05', hubspot: 'quotehed_shortchar05' },
  //{ epicor: 'QuoteHed_ShortChar06', hubspot: 'quotehed_shortchar06' },
  //{ epicor: 'QuoteHed_ShortChar07', hubspot: 'quotehed_shortchar07' },
  //{ epicor: 'QuoteHed_Character04', hubspot: 'quotehed_character04' },
  //{ epicor: 'QuoteHed_Character05', hubspot: 'quotehed_character05' },
  //{ epicor: 'QuoteHed_Character06', hubspot: 'quotehed_character06' },
  //{ epicor: 'QuoteHed_Character02', hubspot: 'quotehed_character02' },
  //{ epicor: 'QuoteHed_Character03', hubspot: 'quotehed_character03' },
  //{ epicor: 'Customer_CustomerType', hubspot: 'customer_customertype' },
  //{ epicor: 'Task_TaskComment', hubspot: 'task_taskcomment' },
  //{ epicor: 'RowIdent', hubspot: 'rowident' },
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

function chunkArray(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

async function quoteService(fastify, _) {
  const { ENDPOINTS, HUBSPOT_PIPELINES, HUBSPOT_DEAL_STAGES, BATCH_SIZES } = fastify.constants;
  const BATCH_SIZE = BATCH_SIZES.QUOTES || 100;
  const UNIQUE_PROPERTY = 'quotehed_quotenum';

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

  async function processQuoteBatch(quotes) {
    const results = {
      total: quotes.length,
      created: 0,
      updated: 0,
      errors: 0,
      errorDetails: [],
      skipped: 0
    };

    const batchData = [];
    
    for (const quote of quotes) {
      try {
        const quoteNum = quote.QuoteHed_QuoteNum;
        if (!quoteNum) {
          results.skipped++;
          continue;
        }

        const quoteNumStr = String(quoteNum).trim();
        if (!quoteNumStr) {
          results.skipped++;
          continue;
        }

        let properties = transformEpicorToHubSpot(quote);
        properties.dealname = generateDealName(quote);
        const isWon = properties.task_conclusion === 'WIN';
        
        properties.pipeline = HUBSPOT_PIPELINES.QUOTES;
        if (isWon) {
          properties.dealstage = HUBSPOT_DEAL_STAGES.CLOSED_WON;
        } else {
          properties.dealstage = HUBSPOT_DEAL_STAGES.QUOTE_CREATED;
        }
        
        if (!properties[UNIQUE_PROPERTY]) {
          properties[UNIQUE_PROPERTY] = quoteNumStr;
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
          id: quoteNumStr,
          properties: cleanProperties
        });
        
      } catch (error) {
        results.errors++;
        fastify.log.error(`Quote batch processing error for quote ${quote.QuoteHed_QuoteNum}:`, {
          error: error.message,
          stack: error.stack,
          quoteNum: quote.QuoteHed_QuoteNum,
          quoteData: {
            QuoteHed_QuoteNum: quote.QuoteHed_QuoteNum,
            QuoteHed_CustNum: quote.QuoteHed_CustNum,
            Customer_Name: quote.Customer_Name,
            QuoteHed_Character08: quote.QuoteHed_Character08
          }
        });
        results.errorDetails.push({
          error: error.message,
          quote: quote.QuoteHed_QuoteNum || 'Unknown'
        });
      }
    }

    if (batchData.length === 0) {
      fastify.log.warn('No valid quote data for batch processing');
      return results;
    }

    fastify.log.info(`Prepared ${batchData.length} quotes for batch upsert`);

    try {
      const upsertResult = await fastify.backoff(() =>
        fastify.hubspotAdapter.batchUpsertDeals(batchData, UNIQUE_PROPERTY)
      );

      if (upsertResult.numErrors > 0) {
        results.errors += upsertResult.numErrors;
        fastify.log.error(`Batch had ${upsertResult.numErrors} errors out of ${batchData.length} quotes`);
        
        if (upsertResult.errors) {
          upsertResult.errors.forEach((error, idx) => {
            fastify.log.error(`Batch error ${idx + 1}:`, {
              message: error.message,
              category: error.category,
              subCategory: error.subCategory,
              context: error.context,
              index: error.index
            });
            
            if (error.index !== undefined && batchData[error.index]) {
              fastify.log.error(`Failed quote data at index ${error.index}:`, {
                quoteNum: batchData[error.index].id,
                properties: batchData[error.index].properties
              });
            }
            
            results.errorDetails.push({
              error: error.message,
              category: error.category
            });
          });
        }
      }

      if (upsertResult.status === 'COMPLETE' && upsertResult.results) {
        for (const result of upsertResult.results) {
          const quoteNum = result.properties?.[UNIQUE_PROPERTY];
          const originalQuote = quotes.find(q => {
            const qNum = q.QuoteHed_QuoteNum;
            return qNum && String(qNum).trim() === quoteNum;
          });
          
          if (originalQuote) {
            const query = {
              epicorId: originalQuote.RowIdent,
              source: 'EpicorQuotes',
            };

            const dbData = {
              hubspotId: result.id,
              epicorId: originalQuote.RowIdent,
              source: 'EpicorQuotes',
              quoteNum: quoteNum,
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

            try {
              const quoteProdMixRecords = await fastify.epicorAdapter.fetchRelatedRecords(
                ENDPOINTS.QUOTE_PROD_MIX,
                'QuoteDtl_QuoteNum',
                quoteNum
              );
              if (quoteProdMixRecords.records?.length) {
                await fastify.quoteProdMixService.syncLineItemsForQuoteWithData(
                  quoteNum,
                  result.id,
                  quoteProdMixRecords.records
                );
              }

              const qSeatEtabRecords = await fastify.epicorAdapter.fetchRelatedRecords(
                ENDPOINTS.QSEAT_ETAB,
                'QuoteDtl_QuoteNum',
                quoteNum
              );
              if (qSeatEtabRecords.records?.length) {
                await fastify.qSeatEtabService.syncLineItemsForQuoteWithData(
                  quoteNum,
                  result.id,
                  qSeatEtabRecords.records
                );
              }
            } catch (lineItemError) {
              fastify.log.warn(`Failed to sync line items for quote ${quoteNum}: ${lineItemError.message}`);
            }

            try {
              const custNum = padCustNum(originalQuote.QuoteHed_CustNum);
              if (custNum) {
                const companySearch = await fastify.backoff(() =>
                  fastify.hubspotAdapter.searchCompaniesByProperty('customer_custnum', [custNum])
                );
                if (companySearch.results?.[0]?.id) {
                  await fastify.hubspotAdapter.createAssociation(
                    'deals',
                    result.id,
                    'companies',
                    companySearch.results[0].id,
                    6
                  );
                  fastify.log.info(`Associated quote ${quoteNum} to company ${companySearch.results[0].id}`);
                }
              }
            } catch (associationError) {
              fastify.log.warn(`Failed to associate quote ${quoteNum} to company: ${associationError.message}`);
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
      fastify.log.error(`Quote batch upsert failed: ${error.message}`, {
        response: error.response?.data,
        status: error.response?.status,
        statusText: error.response?.statusText,
        errors: error.response?.data?.errors,
        batchSize: batchData.length,
        sampleQuote: batchData[0]
      });
      
      results.errors = batchData.length;
      results.errorDetails.push({
        error: error.message,
        response: error.response?.data
      });
      
      fastify.log.info('Falling back to individual processing...');
      await processQuotesIndividually(quotes, results);
    }

    return results;
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
              fastify.hubspotAdapter.searchDealsByProperty('quotehed_quotenum', [quoteNum])
            );
            existRecord = searchData.results?.[0] || null;
          } catch (searchError) {
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
          if (props[key] === null || props[key] === undefined) {
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
            fastify.log.warn(`Failed to sync line items for quote ${quoteNum}: ${lineItemError.message}`);
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
            fastify.log.warn(`Failed to sync line items for quote ${quoteNum}: ${lineItemError.message}`);
          }

          results.created++;
        }

      } catch (error) {
        fastify.log.error(`Individual quote ${quoteNum} failed:`, {
          error: error.message,
          stack: error.stack,
          quoteNum: quoteNum,
          quoteData: {
            QuoteHed_QuoteNum: quote.QuoteHed_QuoteNum,
            QuoteHed_CustNum: quote.QuoteHed_CustNum,
            Customer_Name: quote.Customer_Name,
            dealname: generateDealName(quote)
          },
          properties: props
        });
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