import fp from 'fastify-plugin';
import { padCustNum } from '../../../utils/arrayHelpers.js';

const toMidnightUTC = (v) => {
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
};

const FIELD_MAPPINGS = [
  { epicor: 'QuoteHed_QuoteNum', hubspot: 'orderdtl_quotenum', transform: String },
  { epicor: 'QuoteHed_CustNum', hubspot: 'orderhed_custnum', transform: padCustNum },
  { epicor: 'Customer_Name', hubspot: 'customer_name' },
  { epicor: 'Task_Conclusion', hubspot: 'task_conclusion' },
  { epicor: 'QuoteHed_EntryDate', hubspot: 'quotehed_entrydate', transform: toMidnightUTC },
  { epicor: 'QuoteHed_CurrentStage', hubspot: 'quotehed_currentstage' },
  { epicor: 'QuoteHed_Character08', hubspot: 'orderhed_characternh' },
  { epicor: 'QuoteHed_ShortChar09', hubspot: 'orderhed_shortcharni' },
  { epicor: 'QuoteHed_Character10', hubspot: 'quotehed_character10' },
  { epicor: 'SalesRep_Name', hubspot: 'salesrep_name', transform: (v) => v ? String(v).trim() : null },
  { epicor: 'QuoteHed_ShortChar01', hubspot: 'quotehed_shortchar01' },
  { epicor: 'QuoteHed_ShortChar02', hubspot: 'quotehed_shortchar02' },
  { epicor: 'QuoteHed_ShortChar03', hubspot: 'orderhed_shortchar03' },
  { epicor: 'QuoteHed_ShortChar04', hubspot: 'quotehed_shortchar04' },
  { epicor: 'QuoteHed_UserChar3', hubspot: 'orderhed_userchar3' },
  { epicor: 'QuoteHed_Character01', hubspot: 'orderhed_character01' },
  { epicor: 'QuoteHed_ShortChar05', hubspot: 'orderhed_shortchar05' },
  { epicor: 'QuoteHed_ShortChar06', hubspot: 'orderhed_shortchar06' },
  { epicor: 'QuoteHed_ShortChar07', hubspot: 'orderhed_shortchar07' },
  { epicor: 'QuoteHed_Character04', hubspot: 'quotehed_character04' },
  { epicor: 'QuoteHed_Character05', hubspot: 'quotehed_character05' },
  { epicor: 'QuoteHed_Character06', hubspot: 'quotehed_character06' },
  { epicor: 'QuoteHed_Character02', hubspot: 'quotehed_character02' },
  { epicor: 'QuoteHed_Character03', hubspot: 'quotehed_character03' },
  { epicor: 'Customer_CustomerType', hubspot: 'customer_customertype' },
  { epicor: 'Task_TaskComment', hubspot: 'task_taskcomment' },
  { epicor: 'QuoteHed_SysRowID', hubspot: 'rowident' },
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

function isDuplicateKeyError(error) {
  return error?.code === 11000 || String(error?.message || '').includes('E11000 duplicate key error');
}

async function quoteService(fastify, _) {
  const { ENDPOINTS, HUBSPOT_PIPELINES, HUBSPOT_DEAL_STAGES, HUBSPOT_ASSOCIATIONS } = fastify.constants;
  const UNKNOWN_OPTION = 'Unknown Option';

  async function getSalesRepOptions() {
    try {
      const options = await fastify.backoff(() =>
        fastify.hubspotAdapter.getPropertyOptions('deals', 'salesrep_name')
      );
      const set = new Set(options || []);
      set.add(UNKNOWN_OPTION);
      return set;
    } catch (error) {
      fastify.log.warn(`Failed loading HubSpot options for salesrep_name: ${error.message}`);
      return new Set([UNKNOWN_OPTION]);
    }
  }

  function normalizeSalesRepValue(value, optionsSet) {
    const clean = String(value || '').trim();
    if (!clean) return UNKNOWN_OPTION;
    return optionsSet.has(clean) ? clean : UNKNOWN_OPTION;
  }

  async function updateDataBase(filter, data) {
    return await fastify.quoteRepository.updateDatabase(filter, data);
  }

  async function createDataBase(data) {
    return await fastify.quoteRepository.insertDatabase(data);
  }

  async function createOrUpdateDataBase(data) {
    try {
      return await createDataBase(data);
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;

      await updateDataBase(
        { epicorId: data.epicorId, source: data.source },
        data,
      );
      return { upserted: true };
    }
  }

  async function deleteDataBase(filter) {
    return await fastify.quoteRepository.deleteDatabase(filter);
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

  async function associateQuoteToCompany(quoteNum, custNumRaw, dealId) {
    try {
      const custNum = custNumRaw ? padCustNum(custNumRaw) : null;
      if (!custNum) {
        fastify.log.debug(`Quote ${quoteNum}: No customer number available for company association`);
        return;
      }

      const companySearch = await fastify.backoff(() =>
        fastify.hubspotAdapter.searchCompaniesByProperty('customer_custnum', [custNum])
      );

      if (companySearch.results?.[0]?.id) {
        const assocResult = await ensureDealCompanyAssociation(dealId, companySearch.results[0].id);
        fastify.log.debug(`Quote ${quoteNum}: Deal/company association ${assocResult?.skipped ? 'already exists' : 'created'}`);
      } else {
        fastify.log.debug(`Quote ${quoteNum}: No company found for customer_custnum=${custNum}`);
      }
    } catch (associationError) {
      fastify.log.warn(`Quote ${quoteNum}: Failed to associate deal ${dealId} to company: ${associationError.message}`);
    }
  }

  async function processQuotesIndividually(quotes, results) {
    fastify.log.info(`Starting individual processing for ${quotes.length} quotes...`);
    const salesRepOptions = await getSalesRepOptions();
    
    for (const quote of quotes) {
      const quoteNum = quote.QuoteHed_QuoteNum;
      let props = {};

      try {
        const query = {
          epicorId: quote.QuoteHed_SysRowID,
          source: 'EpicorQuotes',
        };

        let existRecord = null;

        try {
          const searchData = await fastify.backoff(() =>
            fastify.hubspotAdapter.searchDealsByProperty('quotehed_quotenum_', [quoteNum])
          );
          existRecord = searchData.results?.[0] || null;
          fastify.log.info(`Search completed for quote ${quoteNum}: ${existRecord ? 'Found existing deal ' + existRecord.id : 'No existing deal found'}`);
        } catch (searchError) {
          fastify.log.error(`Search failed for quote ${quoteNum}: ${searchError.message} [${searchError.response?.status || 'no-status'}]`);
          existRecord = null;
        }

        if (!existRecord) {
          const dealName = generateDealName(quote);
          try {
            const nameSearch = await fastify.backoff(() =>
              fastify.hubspotAdapter.searchDealsByProperty('dealname', [dealName])
            );
            existRecord = nameSearch.results?.[0] || null;
            if (existRecord) {
              fastify.log.info(`Matched quote ${quoteNum} by deal name to deal ${existRecord.id}`);
            }
          } catch (searchError) {
            fastify.log.warn(`Deal name search failed for quote ${quoteNum}: ${searchError.message}`);
          }
        }

        props = transformEpicorToHubSpot(quote);
        props.salesrep_name = normalizeSalesRepValue(props.salesrep_name, salesRepOptions);
        props.dealname = generateDealName(quote);
        const normalizedConclusion = String(props.task_conclusion || '').trim().toUpperCase();
        const isWon = normalizedConclusion === 'WIN';
        const isLost = normalizedConclusion === 'LOSE';
        
        props.pipeline = HUBSPOT_PIPELINES.QUOTES;
        if (isWon) {
          props.dealstage = HUBSPOT_DEAL_STAGES.CLOSED_WON;
        } else if (isLost) {
          props.dealstage = HUBSPOT_DEAL_STAGES.CLOSED_LOST;
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
          let needsCreate = false;

          try {
            const updateProps = { ...props };
            if (!isWon && !isLost) {
              delete updateProps.pipeline;
              delete updateProps.dealstage;
            }
            await fastify.backoff(() =>
              fastify.hubspotAdapter.updateDeal({ dealId, properties: updateProps })
            );
          } catch (error) {
            const { status, message, combinedMessage } = extractHubspotErrorContext(error);
            const combined = String(combinedMessage || '');
            const notFound = status === 404
              || String(message || '').toLowerCase().includes('resource not found')
              || combined.toLowerCase().includes('resource not found')
              || /\b404\b/.test(combined);
            if (notFound) {
              await deleteDataBase(query);
              fastify.log.warn(`Quote ${quoteNum} deleted from DB because HubSpot deal ${dealId} was not found`);
              needsCreate = true;
            } else {
              throw error;
            }
          }

          if (needsCreate) {
            if (!isWon && !isLost && !props.dealstage) {
              props.dealstage = HUBSPOT_DEAL_STAGES.QUOTE_CREATED;
            }

            const created = await fastify.backoff(() =>
              fastify.hubspotAdapter.createDeal({ properties: props })
            );
            const newDealId = created.id;

            fastify.log.info(`Quote ${quoteNum} recreated in HubSpot ${newDealId}`);

            await createOrUpdateDataBase({
              hubspotId: newDealId,
              epicorId: quote.QuoteHed_SysRowID,
              source: 'EpicorQuotes',
              quoteNum: quoteNum,
              action: 'create',
              timestamp: new Date()
            });

            try {
              await fastify.quoteProdMixService.syncLineItemsForQuote(quoteNum, newDealId);
            } catch (lineItemError) {
              fastify.log.warn(`Failed to sync QuoteProdMix line items for quote ${quoteNum}: ${lineItemError.message}`);
            }

            try {
              await fastify.qSeatEtabService.syncLineItemsForQuote(quoteNum, newDealId);
            } catch (lineItemError) {
              fastify.log.warn(`Failed to sync QSeatEtab line items for quote ${quoteNum}: ${lineItemError.message}`);
            }

            await associateQuoteToCompany(quoteNum, quote.QuoteHed_CustNum, newDealId);

            results.created++;
            continue;
          }

          let action = 'updated';
          if (isWon) {
            action = 'updated_to_closed_won';
          } else if (isLost) {
            action = 'updated_to_closed_lost';
          }
          fastify.log.info(`Quote ${quoteNum} ${action} in HubSpot ${dealId}`);

          if (existRecord?.hubspotId) {
            await updateDataBase(query, { action, timestamp: new Date() });
          } else {
            await createOrUpdateDataBase({
              hubspotId: dealId,
              epicorId: quote.QuoteHed_SysRowID,
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

          await associateQuoteToCompany(quoteNum, quote.QuoteHed_CustNum, dealId);

          results.updated++;
        } else {
          const created = await fastify.backoff(() =>
            fastify.hubspotAdapter.createDeal({ properties: props })
          );
          const dealId = created.id;

          fastify.log.info(`Quote ${quoteNum} created in HubSpot ${dealId}`);

          await createOrUpdateDataBase({
            hubspotId: dealId,
            epicorId: quote.QuoteHed_SysRowID,
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

          await associateQuoteToCompany(quoteNum, quote.QuoteHed_CustNum, dealId);

          results.created++;
        }

      } catch (error) {
        fastify.log.error(`Individual quote ${quoteNum} failed: ${error.message} [${error.response?.status || 'no-status'}]`);
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