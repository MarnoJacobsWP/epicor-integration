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
  { epicor: 'OrderHed_OrderNum', hubspot: 'orderhed_ordernum', transform: String },  //Sales Order Num - orderhed_ordernum
  { epicor: 'OrderHed_CustNum', hubspot: 'orderhed_custnum', transform: padCustNum }, //Customer Number - orderhed_custnum - customer_custnum
  { epicor: 'OrderDtl_QuoteNum', hubspot: 'orderdtl_quotenum', transform: String }, //Quote Num - orderdtl_quotenum - quotehed_quotenum_
  { epicor: 'OrderHed_OrderDate', hubspot: 'orderhed_orderdate', transform: toMidnightUTC }, //Order Date - orderhed_orderdate
  { epicor: 'OrderHed_CheckBox10', hubspot: 'orderhed_checkboxan', transform: Boolean }, //CSR/Order CSR - orderhed_checkboxan
  { epicor: 'Customer_Name', hubspot: 'customer_name' }, //Customer Name/Quote To - customer_name
  { epicor: 'OrderHed_Character08', hubspot: 'orderhed_characternh' }, //Job Name/Order Job Name - orderhed_characternh
  { epicor: 'OrderHed_ShortChar09', hubspot: 'orderhed_shortcharni' }, //Lead Time/Order Lead Time - orderhed_shortcharni
  { epicor: 'SalesRep_Name', hubspot: 'salesrep_name' }, //TM - salesrep_name
  { epicor: 'OrderHed_ShortChar01', hubspot: 'quotehed_shortchar01' }, //Class/Order Class - quotehed_shortchar01 - orderhed_shortchar01
  { epicor: 'OrderHed_ShortChar02', hubspot: 'quotehed_shortchar02' }, //Paint/Order Paint - quotehed_shortchar02 - orderhed_shortchar02
  { epicor: 'OrderHed_ShortChar03', hubspot: 'orderhed_shortchar03' }, //Base Color - orderhed_shortchar03
  { epicor: 'OrderHed_ShortChar04', hubspot: 'quotehed_shortchar04' }, //Shelf Paint/Order Shelf Paint - quotehed_shortchar04 - orderhed_shortchar04
  { epicor: 'OrderHed_UserChar3', hubspot: 'orderhed_userchar3' }, //Base Style - orderhed_userchar3
  { epicor: 'OrderHed_Character01', hubspot: 'orderhed_character01' }, //TCap Style - orderhed_character01
  { epicor: 'OrderHed_ShortChar05', hubspot: 'orderhed_shortchar05' }, //Shelf Style - orderhed_shortchar05
  { epicor: 'OrderHed_ShortChar06', hubspot: 'orderhed_shortchar06' }, //Elec Style - orderhed_shortchar06
  { epicor: 'OrderHed_ShortChar07', hubspot: 'orderhed_shortchar07' }, //Rails Style - orderhed_shortchar07
  { epicor: 'OrderHed_Character04', hubspot: 'quotehed_character04' }, //Panel Fab/Order Panel Fab - quotehed_character04 - orderhed_character04
  { epicor: 'OrderHed_Character05', hubspot: 'quotehed_character05' }, //Flipper Fab/Order Flipper Fab - quotehed_character05 - orderhed_character05
  { epicor: 'OrderHed_Character06', hubspot: 'quotehed_character06' }, //Tack Fab/Order Tack Fab - quotehed_character06 - orderhed_character06
  { epicor: 'OrderHed_Character02', hubspot: 'quotehed_character02' }, //WS Finish/Order WS Finish - quotehed_character02 - orderhed_character02
  { epicor: 'OrderHed_Character03', hubspot: 'quotehed_character03' }, //WS Trim/Order WS Trim - quotehed_character03 - orderhed_character03
  { epicor: 'Customer_CustomerType', hubspot: 'customer_customertype' }, //Type - customer_customertype
  { epicor: 'OrderHed_SysRowID', hubspot: 'rowident' }, //Row Ident - rowident
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

function getHubspotFileName(fileDetails) {
  const path = String(fileDetails?.path || '').trim();
  if (path) {
    const segments = path.split('/').filter(Boolean);
    return segments.at(-1) || '';
  }

  const name = String(fileDetails?.name || '').trim();
  const extension = String(fileDetails?.extension || '').trim();
  if (!name) return '';
  return extension ? `${name}.${extension}` : name;
}

async function orderService(fastify, _) {
  const { ENDPOINTS, HUBSPOT_PIPELINES, HUBSPOT_DEAL_STAGES, HUBSPOT_ASSOCIATIONS } = fastify.constants;
  const HUBSPOT_SALES_ORDER_FILES_FOLDER_PATH = '/Sales Orders';

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
      if (orderNum != null && String(orderNum).trim() !== '') {
        properties.orderhed_ordernum = String(orderNum);
      }
      if (HUBSPOT_PIPELINES.QUOTES) properties.pipeline = HUBSPOT_PIPELINES.QUOTES;
      if (HUBSPOT_DEAL_STAGES.CLOSED_WON) properties.dealstage = HUBSPOT_DEAL_STAGES.CLOSED_WON;

      if (Object.keys(properties).length === 0) {
        fastify.log.warn(`Skipping quote update for ${quoteNum}: missing pipeline or deal stage configuration`);
      } else {
        await fastify.backoff(() =>
          fastify.hubspotAdapter.updateDeal({
            dealId: quoteDealId,
            properties
          })
        );
        fastify.log.info(`Updated matching quote ${quoteNum} to Closed Won with orderhed_ordernum=${properties.orderhed_ordernum || 'n/a'} (deal ${quoteDealId})`);
      }
      
      // Sync all order line items (purge QuoteProdMix, sync OrderProdMix + QSeatEtab)
      await syncOrderLineItems(orderNum, quoteNum, quoteDealId);
    } catch (quoteUpdateError) {
      fastify.log.warn(`Failed to update matching quote ${quoteNum} for order ${orderNum}: ${quoteUpdateError.message}`);
    }
  }

  async function associateOrderToCompany(orderNum, custNumRaw, dealId) {
    try {
      const custNum = custNumRaw ? padCustNum(custNumRaw) : null;
      if (!custNum) {
        fastify.log.debug(`Order ${orderNum}: No customer number available for company association`);
        return;
      }

      const companySearch = await fastify.backoff(() =>
        fastify.hubspotAdapter.searchCompaniesByProperty('customer_custnum', [custNum])
      );

      if (companySearch.results?.[0]?.id) {
        const assocResult = await ensureDealCompanyAssociation(dealId, companySearch.results[0].id);
        fastify.log.debug(`Order ${orderNum}: Deal/company association ${assocResult?.skipped ? 'already exists' : 'created'}`);
      } else {
        fastify.log.debug(`Order ${orderNum}: No company found for customer_custnum=${custNum}`);
      }
    } catch (associationError) {
      fastify.log.warn(`Order ${orderNum}: Failed to associate deal ${dealId} to company: ${associationError.message}`);
    }
  }

  async function checkAndUpdateMatchingQuote(quoteNum, orderNum, usedQuoteDeal, currentDealId) {
    if (!quoteNum || usedQuoteDeal) return;

    try {
      const quoteSearchData = await fastify.backoff(() =>
        fastify.hubspotAdapter.searchDealsByProperty('orderdtl_quotenum', [quoteNum])
      );
      const quoteDealId = quoteSearchData.results?.[0]?.id;
      if (!quoteDealId) return;

      if (currentDealId && String(currentDealId) === String(quoteDealId)) {
        fastify.log.debug(`Order ${orderNum}: Quote ${quoteNum} already resolved to current deal ${currentDealId}, skipping duplicate quote update`);
        return;
      }

      await updateMatchingQuote(quoteNum, orderNum, quoteDealId);
    } catch (error) {
      fastify.log.warn(`Order ${orderNum}: Failed to check matching quote ${quoteNum}: ${error.message}`);
    }
  }

  async function ensureSalesOrderPdfOnDeal(orderNum, dealId, dealstage) {
    if (dealstage !== HUBSPOT_DEAL_STAGES.CLOSED_WON) {
      fastify.log.info(`Order ${orderNum}: Deal ${dealId} stage=${dealstage} — not CLOSED_WON, skipping sales order PDF check`);
      return;
    }

    let existing;
    try {
      const deal = await fastify.backoff(() =>
        fastify.hubspotAdapter.getDealById({ dealId, properties: ['sales_order_pdf'] })
      );
      existing = deal?.properties?.sales_order_pdf;
    } catch (error) {
      fastify.log.warn(`Order ${orderNum}: Could not read sales_order_pdf on deal ${dealId}: ${error.message}. Will attempt PDF generation anyway.`);
    }

    if (existing && String(existing).trim() !== '') {
      fastify.log.info(`Order ${orderNum}: Deal ${dealId} already has sales_order_pdf=${existing} — refreshing PDF upload`);
    } else {
      fastify.log.info(`Order ${orderNum}: Deal ${dealId} is CLOSED_WON with no sales_order_pdf — triggering PDF generation`);
    }

    await generateAndUploadSalesOrderPdf(orderNum, dealId, existing);
  }

  async function generateAndUploadSalesOrderPdf(orderNum, dealId, previousFileId) {
    const ctx = `Order ${orderNum} (deal ${dealId}) PDF`;
    if (orderNum === undefined || orderNum === null || orderNum === '' || !dealId) {
      fastify.log.warn(`${ctx}: Skipped — missing orderNum or dealId (orderNum=${orderNum}, dealId=${dealId})`);
      return;
    }
    if (!fastify.config?.EPICOR_SALES_ORDER_PDF_URL) {
      fastify.log.warn(`${ctx}: Skipped — EPICOR_SALES_ORDER_PDF_URL is not configured in .env`);
      return;
    }

    const startedAt = Date.now();
    let base64;
    try {
      fastify.log.info(`${ctx}: Step 1/3 — Calling Epicor GenerateSalesOrderPDF endpoint...`);
      base64 = await fastify.backoff(() => fastify.epicorAdapter.generateSalesOrderPDF(orderNum));
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

    const fileName = `Sales Order-${orderNum}.pdf`;
    let uploaded;
    try {
      fastify.log.info(`${ctx}: Step 2/3 — Uploading "${fileName}" to HubSpot Files (folder=${HUBSPOT_SALES_ORDER_FILES_FOLDER_PATH}, access=${fastify.config.HUBSPOT_FILES_ACCESS || 'PRIVATE'})...`);
      uploaded = await fastify.backoff(() => fastify.hubspotAdapter.uploadFile({
        buffer,
        fileName,
        contentType: 'application/pdf',
        folderPath: HUBSPOT_SALES_ORDER_FILES_FOLDER_PATH,
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
      fastify.log.error({ uploadResponse: uploaded }, `${ctx}: Step 2/3 returned no file ID — cannot set sales_order_pdf`);
      return;
    }
    fastify.log.info(`${ctx}: Step 2/3 OK — uploaded file ID=${fileId}, url=${uploaded?.url || 'n/a'}`);

    try {
      fastify.log.info(`${ctx}: Step 3/3 — Setting sales_order_pdf=${fileId} on deal ${dealId}...`);
      await fastify.backoff(() => fastify.hubspotAdapter.updateDeal({
        dealId,
        properties: { sales_order_pdf: String(fileId) },
      }));
    } catch (error) {
      const status = error?.cause?.response?.status || error?.response?.status;
      const body = error?.cause?.response?.data || error?.response?.data;
      fastify.log.error(
        { err: error, status, responseBody: body, fileId },
        `${ctx}: Step 3/3 FAILED — could not set sales_order_pdf on deal: ${error.message}`,
      );
      return;
    }

    await deletePreviousSalesOrderPdf({ ctx, previousFileId, fileId });

    const uploadedFileName = getHubspotFileName(uploaded);
    if (uploadedFileName && uploadedFileName !== fileName) {
      try {
        fastify.log.info(`${ctx}: Normalizing HubSpot file name from "${uploadedFileName}" to "${fileName}"...`);
        await fastify.backoff(() => fastify.hubspotAdapter.renameFile(fileId, fileName));
      } catch (error) {
        const status = error?.cause?.response?.status || error?.response?.status;
        const body = error?.cause?.response?.data || error?.response?.data;
        fastify.log.warn(
          { err: error, status, responseBody: body, fileId, uploadedFileName, desiredFileName: fileName },
          `${ctx}: Could not normalize uploaded file name: ${error.message}`,
        );
      }
    }

    fastify.log.info(`${ctx}: SUCCESS — PDF attached in ${Date.now() - startedAt}ms (fileId=${fileId})`);
  }

  async function deletePreviousSalesOrderPdf({ ctx, previousFileId, fileId }) {
    const previousId = previousFileId == null ? '' : String(previousFileId).trim();
    if (!previousId || previousId === String(fileId)) {
      return;
    }

    try {
      fastify.log.info(`${ctx}: Step 4/4 — Deleting previous HubSpot file ${previousId}...`);
      await fastify.backoff(() => fastify.hubspotAdapter.deleteFile(previousId));
    } catch (error) {
      const status = error?.cause?.response?.status || error?.response?.status;
      const body = error?.cause?.response?.data || error?.response?.data;
      fastify.log.warn(
        { err: error, status, responseBody: body, previousFileId: previousId, fileId },
        `${ctx}: Step 4/4 FAILED — could not delete previous HubSpot file: ${error.message}`,
      );
    }
  }

  /** Properties needed for cross-source deduplication scanning. */
  const DEDUP_FETCH_PROPERTIES = ['name', 'price', 'amount', 'quotedtl_partnum'];

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
   * Syncs all line items for an Order deal.
   *
   * Enforces source-of-truth rules:
   * 1. Purge any QuoteProdMix items (Order data supersedes Quote data)
   * 2. Reconcile OrderProdMix items against Epicor
   * 3. Reconcile QSeatEtab items using the associated QuoteNum
   * 4. Cross-source dedup as a final safety net
   *
   * @param {string|number} orderNum - Epicor SalesOrderNum
   * @param {string|number} quoteNum - Associated QuoteNum (may be falsy)
   * @param {string} dealId - HubSpot deal ID
   */
  async function syncOrderLineItems(orderNum, quoteNum, dealId) {
    // Step 1: Purge QuoteProdMix — Order is the sole source of truth
    try {
      await fastify.quoteProdMixService.purgeQuoteProdMixItems(dealId);
    } catch (error) {
      fastify.log.warn(`Order ${orderNum}: Failed to purge QuoteProdMix on deal ${dealId}: ${error.message}`);
    }

    // Step 2: Reconcile OrderProdMix line items
    try {
      await fastify.orderProdMixService.syncLineItemsForOrder(orderNum, dealId);
    } catch (error) {
      fastify.log.warn(`Order ${orderNum}: Failed to sync OrderProdMix items: ${error.message}`);
    }

    // Step 3: Sync QSeatEtab using the associated QuoteNum
    if (quoteNum) {
      try {
        await fastify.qSeatEtabService.syncLineItemsForQuote(quoteNum, dealId);
      } catch (error) {
        fastify.log.warn(`Order ${orderNum}: Failed to sync QSeatEtab items (quote ${quoteNum}): ${error.message}`);
      }
    } else {
      fastify.log.debug(`Order ${orderNum}: No QuoteNum — skipping QSeatEtab sync`);
    }

    // Step 4: Final cross-source dedup safety net
    await deduplicateDealLineItems(dealId);
  }

  async function processOrdersIndividually(orders, results) {
    fastify.log.info(`Starting individual processing for ${orders.length} orders...`);
    
    for (const order of orders) {
      const orderNum = order.OrderHed_OrderNum;
      const quoteNum = order.OrderDtl_QuoteNum;
      let props = {};
      let usedQuoteDeal = false;

      try {
        let existRecord = null;

        // Search HubSpot directly by order number
        try {
          const searchData = await fastify.backoff(() =>
            fastify.hubspotAdapter.searchDealsByProperty('orderhed_ordernum', [orderNum])
          );
          existRecord = searchData.results?.[0] || null;
        } catch (searchError) {
          fastify.log.warn(`Order ${orderNum} deal search by order number failed: ${searchError.message}`);
          existRecord = null;
        }

        // Also search by quote number if available
        if (quoteNum) {
          try {
            const quoteSearch = await fastify.backoff(() =>
              fastify.hubspotAdapter.searchDealsByProperty('orderdtl_quotenum', [quoteNum])
            );
            if (quoteSearch.results?.[0]) {
              const quoteDeal = quoteSearch.results[0];
              const existingDealId = existRecord?.id;
              if (!existingDealId || String(existingDealId) !== String(quoteDeal.id)) {
                existRecord = quoteDeal;
                usedQuoteDeal = true;
                fastify.log.info(`Order ${orderNum} matched existing quote deal ${existRecord.id} for quote ${quoteNum}`);
              }
            }
          } catch (searchError) {
            fastify.log.warn(`Order ${orderNum} quote match search failed: ${searchError.message}`);
          }
        }

        // Fallback: search by deal name
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
        if (quoteNum) {
          props.orderdtl_quotenum = String(quoteNum);
        }
        props.pipeline = HUBSPOT_PIPELINES.QUOTES;
        props.dealstage = HUBSPOT_DEAL_STAGES.CLOSED_WON;

        Object.keys(props).forEach(key => {
          if (props[key] === null || props[key] === undefined) {
            delete props[key];
          }
        });

        if (existRecord?.id) {
          const dealId = existRecord.id;
          let needsCreate = false;

          try {
            await fastify.backoff(() =>
              fastify.hubspotAdapter.updateDeal({ dealId, properties: props })
            );
          } catch (error) {
            const { status, message, combinedMessage } = extractHubspotErrorContext(error);
            const combined = String(combinedMessage || '');
            const notFound = status === 404
              || String(message || '').toLowerCase().includes('resource not found')
              || combined.toLowerCase().includes('resource not found')
              || /\b404\b/.test(combined);
            if (notFound) {
              fastify.log.warn(`Order ${orderNum}: HubSpot deal ${dealId} was not found, will create new`);
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

            await syncOrderLineItems(orderNum, quoteNum, newDealId);
            await associateOrderToCompany(orderNum, order.OrderHed_CustNum, newDealId);
            await checkAndUpdateMatchingQuote(quoteNum, orderNum, usedQuoteDeal, newDealId);
            await ensureSalesOrderPdfOnDeal(orderNum, newDealId, props.dealstage);

            results.created++;
            continue;
          }

          fastify.log.info(`Order ${orderNum} updated in HubSpot ${dealId}`);

          await syncOrderLineItems(orderNum, quoteNum, dealId);
          await associateOrderToCompany(orderNum, order.OrderHed_CustNum, dealId);
          await checkAndUpdateMatchingQuote(quoteNum, orderNum, usedQuoteDeal, dealId);
          await ensureSalesOrderPdfOnDeal(orderNum, dealId, props.dealstage);

          results.updated++;
        } else {
          const created = await fastify.backoff(() =>
            fastify.hubspotAdapter.createDeal({ properties: props })
          );
          const dealId = created.id;

          fastify.log.info(`Order ${orderNum} created in HubSpot ${dealId}`);

          await syncOrderLineItems(orderNum, quoteNum, dealId);
          await associateOrderToCompany(orderNum, order.OrderHed_CustNum, dealId);
          await checkAndUpdateMatchingQuote(quoteNum, orderNum, usedQuoteDeal, dealId);
          await ensureSalesOrderPdfOnDeal(orderNum, dealId, props.dealstage);

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
      const filterTimestamp = toUnixSeconds(dateString);
      fastify.log.info(`Fetching orders from Epicor (filter timestamp: ${filterTimestamp})...`);
      const { records, metadata } = await fastify.epicorAdapter.fetchFilteredRecords(ENDPOINTS.ORDERS, filterTimestamp);
      
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
    fastify.decorate('orderTask', { task, processOrdersIndividually });
  }
}

export default fp(orderService, {
  name: 'orderServices',
  dependencies: [
    'orderProdMixService',
    'quoteProdMixService',
    'qSeatEtabService',
    'epicorAdapter',
    'hubspotAdapter',
    'backoff',
    'constants',
  ],
});