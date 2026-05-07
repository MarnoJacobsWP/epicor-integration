import fp from 'fastify-plugin';
import { padCustNum } from '../../../utils/arrayHelpers.js';
import { toUnixSeconds } from '../../../utils/dateHelper.js';
import { findDuplicatesOnDeal } from '../../shared/lineItemReconciliation.js';

const toMidnightUTC = (v) => {
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
};

const FIELD_MAPPINGS = [
  { epicor: 'QuoteHed_QuoteNum', hubspot: 'orderdtl_quotenum', transform: String },//Quote Num - orderdtl_quotenum - quotehed_quotenum_
  { epicor: 'QuoteHed_CustNum', hubspot: 'orderhed_custnum', transform: padCustNum },//Customer Number - orderhed_custnum - customer_custnum
  { epicor: 'Customer_Name', hubspot: 'customer_name' },//Customer Name/Quote To - customer_name
  { epicor: 'Task_Conclusion', hubspot: 'task_conclusion' },//Conclusion - task_conclusion
  { epicor: 'QuoteHed_EntryDate', hubspot: 'quotehed_entrydate', transform: toMidnightUTC },//Entrey Date - quotehed_entrydate
  { epicor: 'QuoteHed_CurrentStage', hubspot: 'quotehed_currentstage' },//Current Stage - quotehed_currentstage
  { epicor: 'QuoteHed_Character08', hubspot: 'orderhed_characternh' },//Job Name/Order Job Name - orderhed_characternh
  { epicor: 'QuoteHed_ShortChar09', hubspot: 'orderhed_shortcharni' },//Lead Time/Order Lead Time - orderhed_shortcharni
  { epicor: 'QuoteHed_Character10', hubspot: 'quotehed_character10' },//Quote CSR/CSR - quotehed_character10
  { epicor: 'SalesRep_Name', hubspot: 'salesrep_name', transform: (v) => v ? String(v).trim() : null },//TM - salesrep_name
  { epicor: 'QuoteHed_ShortChar01', hubspot: 'quotehed_shortchar01' },//Class - quotehed_shortchar01
  { epicor: 'QuoteHed_ShortChar02', hubspot: 'quotehed_shortchar02' },//Paint - quotehed_shortchar02
  { epicor: 'QuoteHed_ShortChar03', hubspot: 'orderhed_shortchar03' },//Base Color - orderhed_shortchar03
  { epicor: 'QuoteHed_ShortChar04', hubspot: 'quotehed_shortchar04' },//Shelf Paint - quotehed_shortchar04
  { epicor: 'QuoteHed_UserChar3', hubspot: 'orderhed_userchar3' },//Base Style - orderhed_userchar3
  { epicor: 'QuoteHed_Character01', hubspot: 'orderhed_character01' },//TCap Style - orderhed_character01
  { epicor: 'QuoteHed_ShortChar05', hubspot: 'orderhed_shortchar05' },//Shelf Style - orderhed_shortchar05
  { epicor: 'QuoteHed_ShortChar06', hubspot: 'orderhed_shortchar06' },//Elec Style - orderhed_shortchar06
  { epicor: 'QuoteHed_ShortChar07', hubspot: 'orderhed_shortchar07' },//Rails Style - orderhed_shortchar07
  { epicor: 'QuoteHed_Character04', hubspot: 'quotehed_character04' },//Panel Fab - quotehed_character04
  { epicor: 'QuoteHed_Character05', hubspot: 'quotehed_character05' },//Flipper Fab - quotehed_character05
  { epicor: 'QuoteHed_Character06', hubspot: 'quotehed_character06' },//Tack Fab - quotehed_character06
  { epicor: 'QuoteHed_Character02', hubspot: 'quotehed_character02' },//WS Finish - quotehed_character02
  { epicor: 'QuoteHed_Character03', hubspot: 'quotehed_character03' },//WS Trim - quotehed_character03
  { epicor: 'Customer_CustomerType', hubspot: 'customer_customertype' },//Type - customer_customertype
  { epicor: 'Task_TaskComment', hubspot: 'task_taskcomment' },//Task Comment - task_taskcomment
  { epicor: 'QuoteHed_SysRowID', hubspot: 'rowident' },//Row Ident - rowident
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

function normalizeOptionKey(value) {
  return String(value || '').trim().toLowerCase();
}

function buildOptionResolverFromDetailed(detailedOptions) {
  const lookup = new Map();
  for (const option of detailedOptions || []) {
    const value = String(option?.value || '').trim();
    const label = String(option?.label || '').trim();
    if (!value) continue;
    lookup.set(normalizeOptionKey(value), value);
    if (label) lookup.set(normalizeOptionKey(label), value);
  }
  return lookup;
}

async function quoteService(fastify, _) {
  const { ENDPOINTS, HUBSPOT_PIPELINES, HUBSPOT_DEAL_STAGES, HUBSPOT_ASSOCIATIONS } = fastify.constants;
  const UNKNOWN_OPTION = 'Unknown Option';

  async function getSalesRepOptions() {
    try {
      if (typeof fastify.hubspotAdapter.getPropertyOptionsDetailed === 'function') {
        const options = await fastify.backoff(() =>
          fastify.hubspotAdapter.getPropertyOptionsDetailed('deals', 'salesrep_name')
        );
        const resolver = buildOptionResolverFromDetailed(options);
        resolver.set(normalizeOptionKey(UNKNOWN_OPTION), UNKNOWN_OPTION);
        return resolver;
      }

      const options = await fastify.backoff(() =>
        fastify.hubspotAdapter.getPropertyOptions('deals', 'salesrep_name')
      );
      const resolver = new Map();
      for (const option of options || []) {
        const value = String(option || '').trim();
        if (value) resolver.set(normalizeOptionKey(value), value);
      }
      resolver.set(normalizeOptionKey(UNKNOWN_OPTION), UNKNOWN_OPTION);
      return resolver;
    } catch (error) {
      fastify.log.warn(`Failed loading HubSpot options for salesrep_name: ${error.message}`);
      return new Map([[normalizeOptionKey(UNKNOWN_OPTION), UNKNOWN_OPTION]]);
    }
  }

  function normalizeSalesRepValue(value, optionResolver) {
    const clean = String(value || '').trim();
    if (!clean) {
      return optionResolver.get(normalizeOptionKey(UNKNOWN_OPTION)) || UNKNOWN_OPTION;
    }

    // If option metadata cannot be loaded, preserve Epicor value instead of forcing Unknown Option.
    if (!optionResolver || optionResolver.size === 0) {
      return clean;
    }

    return optionResolver.get(normalizeOptionKey(clean))
      || optionResolver.get(normalizeOptionKey(UNKNOWN_OPTION))
      || UNKNOWN_OPTION;
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

  async function ensureQuotePdfOnDeal(quoteNum, dealId, dealstage) {
    if (dealstage !== HUBSPOT_DEAL_STAGES.QUOTE_CREATED) {
      fastify.log.info(`Quote ${quoteNum}: Deal ${dealId} stage=${dealstage} — not QUOTE_CREATED, skipping PDF check`);
      return;
    }

    let existing;
    try {
      const deal = await fastify.backoff(() =>
        fastify.hubspotAdapter.getDealById({ dealId, properties: ['quote_pdf'] })
      );
      existing = deal?.properties?.quote_pdf;
    } catch (error) {
      fastify.log.warn(`Quote ${quoteNum}: Could not read quote_pdf on deal ${dealId}: ${error.message}. Will attempt PDF generation anyway.`);
    }

    if (existing && String(existing).trim() !== '') {
      fastify.log.info(`Quote ${quoteNum}: Deal ${dealId} already has quote_pdf=${existing} — skipping PDF generation`);
      return;
    }

    fastify.log.info(`Quote ${quoteNum}: Deal ${dealId} is in QUOTE_CREATED stage with no quote_pdf — triggering PDF generation`);
    await generateAndUploadQuotePdf(quoteNum, dealId);
  }

  async function generateAndUploadQuotePdf(quoteNum, dealId) {
    const ctx = `Quote ${quoteNum} (deal ${dealId}) PDF`;
    if (quoteNum === undefined || quoteNum === null || quoteNum === '' || !dealId) {
      fastify.log.warn(`${ctx}: Skipped — missing quoteNum or dealId (quoteNum=${quoteNum}, dealId=${dealId})`);
      return;
    }
    if (!fastify.config?.EPICOR_QUOTE_PDF_URL) {
      fastify.log.warn(`${ctx}: Skipped — EPICOR_QUOTE_PDF_URL is not configured in .env`);
      return;
    }

    const startedAt = Date.now();
    let base64;
    try {
      fastify.log.info(`${ctx}: Step 1/3 — Calling Epicor GenerateQuotePDF endpoint...`);
      base64 = await fastify.backoff(() => fastify.epicorAdapter.generateQuotePDF(quoteNum));
    } catch (error) {
      const status = error?.cause?.response?.status || error?.response?.status;
      const body = error?.cause?.response?.data || error?.response?.data;
      fastify.log.error(
        { err: error, status, responseBody: typeof body === 'string' ? body.slice(0, 500) : body },
        `${ctx}: Step 1/3 FAILED — Epicor PDF generation: ${error.message}`,
      );
      return;
    }

    if (!base64) {
      fastify.log.warn(`${ctx}: Step 1/3 returned empty PDFBase64, aborting upload`);
      return;
    }

    let buffer;
    try {
      buffer = Buffer.from(base64, 'base64');
    } catch (error) {
      fastify.log.error(`${ctx}: Failed to decode base64 PDF: ${error.message}`);
      return;
    }
    if (!buffer.length) {
      fastify.log.warn(`${ctx}: Decoded PDF buffer is empty, aborting upload`);
      return;
    }
    fastify.log.info(`${ctx}: Step 1/3 OK — base64 length=${base64.length}, decoded bytes=${buffer.length}`);

    const fileName = `Quote-${quoteNum}-${Date.now()}.pdf`;
    let uploaded;
    try {
      fastify.log.info(`${ctx}: Step 2/3 — Uploading "${fileName}" to HubSpot Files (folder=${fastify.config.HUBSPOT_FILES_FOLDER_PATH || '/quote-pdfs'}, access=${fastify.config.HUBSPOT_FILES_ACCESS || 'PRIVATE'})...`);
      uploaded = await fastify.backoff(() => fastify.hubspotAdapter.uploadFile({
        buffer,
        fileName,
        contentType: 'application/pdf',
      }));
    } catch (error) {
      const status = error?.cause?.response?.status || error?.response?.status;
      const body = error?.cause?.response?.data || error?.response?.data;
      fastify.log.error(
        { err: error, status, responseBody: body },
        `${ctx}: Step 2/3 FAILED — HubSpot file upload: ${error.message}`,
      );
      return;
    }

    const fileId = uploaded?.id;
    if (!fileId) {
      fastify.log.error({ uploadResponse: uploaded }, `${ctx}: Step 2/3 returned no file ID — cannot set quote_pdf`);
      return;
    }
    fastify.log.info(`${ctx}: Step 2/3 OK — uploaded file ID=${fileId}, url=${uploaded?.url || 'n/a'}`);

    try {
      fastify.log.info(`${ctx}: Step 3/3 — Setting quote_pdf=${fileId} on deal ${dealId}...`);
      await fastify.backoff(() => fastify.hubspotAdapter.updateDeal({
        dealId,
        properties: { quote_pdf: String(fileId) },
      }));
    } catch (error) {
      const status = error?.cause?.response?.status || error?.response?.status;
      const body = error?.cause?.response?.data || error?.response?.data;
      fastify.log.error(
        { err: error, status, responseBody: body, fileId },
        `${ctx}: Step 3/3 FAILED — could not set quote_pdf on deal: ${error.message}`,
      );
      return;
    }

    fastify.log.info(`${ctx}: SUCCESS — PDF attached in ${Date.now() - startedAt}ms (fileId=${fileId})`);
  }

  /** Properties needed for cross-source deduplication scanning. */
  const DEDUP_FETCH_PROPERTIES = ['name', 'price', 'amount', 'quotedtl_partnum'];

  /**
   * Checks whether a deal has a SalesOrderNum, indicating it has
   * transitioned from a Quote to an Order.
   */
  async function dealHasOrderNumber(dealId) {
    try {
      const deal = await fastify.backoff(() =>
        fastify.hubspotAdapter.getDealById({ dealId, properties: ['orderhed_ordernum'] })
      );
      const orderNum = deal?.properties?.orderhed_ordernum;
      return orderNum != null && String(orderNum).trim() !== '' && String(orderNum).trim() !== '0';
    } catch (error) {
      fastify.log.warn(`Failed to check order number for deal ${dealId}: ${error.message}`);
      return false;
    }
  }

  /**
   * Scans all line items on a deal and removes cross-source duplicates.
   * Acts as a final safety net after per-source reconciliation.
   */
  async function deduplicateDealLineItems(dealId) {
    try {
      const allItems = await fastify.backoff(() =>
        fastify.hubspotAdapter.getLineItemsForDeal(dealId, DEDUP_FETCH_PROPERTIES)
      );
      const duplicates = findDuplicatesOnDeal(allItems);
      if (duplicates.length === 0) return;

      fastify.log.info(`Deal ${dealId}: Removing ${duplicates.length} cross-source duplicate line items`);
      for (const dup of duplicates) {
        try {
          await fastify.backoff(() => fastify.hubspotAdapter.deleteLineItem(dup.id));
        } catch (error) {
          fastify.log.error(`Failed to delete duplicate line item ${dup.id}: ${error.message}`);
        }
      }
    } catch (error) {
      fastify.log.warn(`Deal ${dealId}: Cross-source dedup failed: ${error.message}`);
    }
  }

  /**
   * Syncs all line items for a Quote deal based on its deal type.
   *
   * Case A (Quote-only): Sync QuoteProdMix + QSeatEtab, run dedup.
   * Case C (has SalesOrderNum): Purge QuoteProdMix — Order phase handles everything.
   *
   * @param {string|number} quoteNum - Epicor QuoteNum
   * @param {string} dealId - HubSpot deal ID
   * @param {object} [options]
   * @param {boolean} [options.skipOrderCheck=false] - Skip SalesOrderNum check (for newly created deals)
   */
  async function syncQuoteLineItems(quoteNum, dealId, { skipOrderCheck = false } = {}) {
    // For existing deals, check if an Order has taken over (Case C)
    if (!skipOrderCheck) {
      const hasOrder = await dealHasOrderNumber(dealId);
      if (hasOrder) {
        fastify.log.info(`Quote ${quoteNum}: Deal ${dealId} has a SalesOrderNum — purging QuoteProdMix, deferring to order phase`);
        try {
          await fastify.quoteProdMixService.purgeQuoteProdMixItems(dealId);
        } catch (error) {
          fastify.log.warn(`Quote ${quoteNum}: Failed to purge QuoteProdMix on deal ${dealId}: ${error.message}`);
        }
        return;
      }
    }

    // Case A: Deal has only QuoteNum — sync QuoteProdMix + QSeatEtab
    try {
      await fastify.quoteProdMixService.syncLineItemsForQuote(quoteNum, dealId);
    } catch (error) {
      fastify.log.warn(`Quote ${quoteNum}: Failed to sync QuoteProdMix items: ${error.message}`);
    }

    try {
      await fastify.qSeatEtabService.syncLineItemsForQuote(quoteNum, dealId);
    } catch (error) {
      fastify.log.warn(`Quote ${quoteNum}: Failed to sync QSeatEtab items: ${error.message}`);
    }

    // Final cross-source dedup safety net
    await deduplicateDealLineItems(dealId);
  }

  async function processQuotesIndividually(quotes, results) {
    fastify.log.info(`Starting individual processing for ${quotes.length} quotes...`);
    const salesRepOptions = await getSalesRepOptions();
    
    for (const quote of quotes) {
      const quoteNum = quote.QuoteHed_QuoteNum;
      let props = {};

      try {
        // Search HubSpot directly by quote number
        let existRecord = null;

        try {
          const searchData = await fastify.backoff(() =>
            fastify.hubspotAdapter.searchDealsByProperty('orderdtl_quotenum', [quoteNum])
          );
          existRecord = searchData.results?.[0] || null;
          fastify.log.info(`Search completed for quote ${quoteNum}: ${existRecord ? 'Found existing deal ' + existRecord.id : 'No existing deal found'}`);
        } catch (searchError) {
          fastify.log.error(`Search failed for quote ${quoteNum}: ${searchError.message} [${searchError.response?.status || 'no-status'}]`);
          existRecord = null;
        }

        // Fallback: search by deal name
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
        } else {
          props.dealstage = HUBSPOT_DEAL_STAGES.QUOTE_CREATED;
        }

        Object.keys(props).forEach(key => {
          if (props[key] === null || props[key] === undefined || props[key] === '') {
            delete props[key];
          }
        });

        // Clear closedate unless stage is Closed Won
        if (props.dealstage !== HUBSPOT_DEAL_STAGES.CLOSED_WON) {
          props.closedate = '';
        }

        if (existRecord?.id) {
          const dealId = existRecord.id;
          let needsCreate = false;

          try {
            const updateProps = { ...props };
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
              fastify.log.warn(`Quote ${quoteNum}: HubSpot deal ${dealId} was not found, will create new`);
              needsCreate = true;
            } else {
              throw error;
            }
          }

          if (needsCreate) {
            if (!isWon && !isLost && !props.dealstage) {
              props.dealstage = HUBSPOT_DEAL_STAGES.QUOTE_CREATED;
            }
            if (props.dealstage !== HUBSPOT_DEAL_STAGES.CLOSED_WON) {
              props.closedate = '';
            }

            const created = await fastify.backoff(() =>
              fastify.hubspotAdapter.createDeal({ properties: props })
            );
            const newDealId = created.id;

            fastify.log.info(`Quote ${quoteNum} recreated in HubSpot ${newDealId}`);

            await syncQuoteLineItems(quoteNum, newDealId, { skipOrderCheck: true });
            await associateQuoteToCompany(quoteNum, quote.QuoteHed_CustNum, newDealId);
            await ensureQuotePdfOnDeal(quoteNum, newDealId, props.dealstage);

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

          await syncQuoteLineItems(quoteNum, dealId);
          await associateQuoteToCompany(quoteNum, quote.QuoteHed_CustNum, dealId);
          await ensureQuotePdfOnDeal(quoteNum, dealId, props.dealstage);

          results.updated++;
        } else {
          const created = await fastify.backoff(() =>
            fastify.hubspotAdapter.createDeal({ properties: props })
          );
          const dealId = created.id;

          fastify.log.info(`Quote ${quoteNum} created in HubSpot ${dealId}`);

          await syncQuoteLineItems(quoteNum, dealId, { skipOrderCheck: true });
          await associateQuoteToCompany(quoteNum, quote.QuoteHed_CustNum, dealId);
          await ensureQuotePdfOnDeal(quoteNum, dealId, props.dealstage);

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
      const filterTimestamp = toUnixSeconds(dateString);
      fastify.log.info(`Fetching quotes from Epicor (filter timestamp: ${filterTimestamp})...`);
      const { records, metadata } = await fastify.epicorAdapter.fetchFilteredRecords(ENDPOINTS.QUOTES, filterTimestamp);
      
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
    fastify.decorate('quoteTask', { task, processQuotesIndividually });
  }
}

export default fp(quoteService, {
  name: 'quoteServices',
  dependencies: [
    'quoteProdMixService',
    'qSeatEtabService',
    'epicorAdapter',
    'hubspotAdapter',
    'backoff',
    'constants',
  ],
});