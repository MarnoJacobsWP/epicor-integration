import fp from 'fastify-plugin';

const FIELD_MAPPINGS = [
  { epicor: 'QuoteDtl_QuoteNum', hubspot: 'quotedtl_quotenum', transform: Number },
  { epicor: 'ProdGrup_Description', hubspot: 'prodgrup_description' },
  { epicor: 'QuoteDtl_PartNum', hubspot: 'quotedtl_partnum' },
  { epicor: 'QuoteDtl_LineDesc', hubspot: 'quotedtl_linedesc' },
  { epicor: 'QuoteDtl_OrderQty', hubspot: 'quotedtl_orderqty', transform: Number },
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

async function qSeatEtabService(fastify, _) {
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

  async function processLineItemsIndividually(lineItems, dealId, results) {
    fastify.log.info(`Starting individual processing for ${lineItems.length} QSeatEtab line items...`);
    
    for (const lineItem of lineItems) {
      const rowident = lineItem.RowIdent;

      try {
        const props = transformEpicorToHubSpot(lineItem);
        props.name = props.prodgrup_description || 'Unnamed Product';
        props.hs_sku = props.quotedtl_partnum;
        props.description = props.quotedtl_linedesc;
        props.quantity = props.quotedtl_orderqty || 0;

        const cleanProps = {
          name: props.name,
          hs_sku: props.hs_sku,
          description: props.description,
          quantity: props.quantity,
          rowident_: props.rowident_,
          prodgrup_description: props.prodgrup_description
        };

        Object.keys(cleanProps).forEach(key => {
          if (cleanProps[key] === null || cleanProps[key] === undefined) {
            delete cleanProps[key];
          }
        });

        const query = {
          epicorId: lineItem.RowIdent,
          source: 'EpicorQSeatEtab',
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
              fastify.log.warn(`QSeatEtab line item ${rowident} deleted from DB`);
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
              source: 'EpicorQSeatEtab',
              quoteNum: lineItem.QuoteDtl_QuoteNum,
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
            source: 'EpicorQSeatEtab',
            quoteNum: lineItem.QuoteDtl_QuoteNum,
            action: 'create'
          });

          results.created++;
        }

      } catch (error) {
        fastify.log.error(`QSeatEtab line item ${rowident} failed: ${error.message}`);
        results.errors++;
      }
    }
    
    fastify.log.info(`QSeatEtab individual processing complete: ${results.created} created, ${results.updated} updated, ${results.errors} errors`);
  }

  async function syncLineItemsForQuoteWithData(quoteNum, dealId, quoteRecords) {
    if (!quoteRecords.length) {
      return { success: true, message: 'No E-Table/Seating line items for this quote', lineItemCount: 0 };
    }

    const lineItemMap = new Map();
    for (const record of quoteRecords) {
      const rowIdent = record.RowIdent;
      if (!rowIdent) continue;
      
      const existing = lineItemMap.get(rowIdent);
      if (!existing || (record.Calculated_Time && (!existing.Calculated_Time || record.Calculated_Time > existing.Calculated_Time))) {
        lineItemMap.set(rowIdent, record);
      }
    }
    
    const uniqueRecords = Array.from(lineItemMap.values());
    fastify.log.info(`Found ${uniqueRecords.length} unique QSeatEtab line items for quote ${quoteNum}, processing individually...`);

    const results = {
      total: uniqueRecords.length,
      created: 0,
      updated: 0,
      errors: 0,
      skipped: 0,
      errorDetails: []
    };

    await processLineItemsIndividually(uniqueRecords, dealId, results);
    
    fastify.log.info(`QSeatEtab sync for quote ${quoteNum} complete: ${results.created} created, ${results.updated} updated, ${results.errors} errors, ${results.skipped} skipped`);

    return {
      success: true,
      lineItemCount: uniqueRecords.length,
      createdCount: results.created,
      updatedCount: results.updated,
      errorCount: results.errors,
      skippedCount: results.skipped
    };
  }

  async function syncLineItemsForQuote(quoteNum, dealId) {
    fastify.log.info(`Fetching QSeatEtab line items for quote ${quoteNum}...`);
    const { records } = await fastify.epicorAdapter.fetchRelatedRecords(
      fastify.constants.ENDPOINTS.QSEAT_ETAB,
      'QuoteDtl_QuoteNum',
      quoteNum
    );
    
    if (!records?.length) {
      fastify.log.info(`No QSeatEtab line items found for quote ${quoteNum}`);
      return { success: true, message: 'No QSeatEtab line items for this quote', lineItemCount: 0 };
    }

    return await syncLineItemsForQuoteWithData(quoteNum, dealId, records);
  }

  async function task(dateString) {
    try {
      fastify.log.info('Processing Tasks for QSeatEtab Line Items');
      return { success: true, message: 'QSeatEtab line items processed by quote service' };
    } catch (error) {
      fastify.log.error(`Error processing Tasks for QSeatEtab Line Items - ${error.message}`);
      throw error;
    }
  }

  if (!fastify.hasDecorator('qSeatEtabService')) {
    fastify.decorate('qSeatEtabService', {
      syncLineItemsForQuote,
      syncLineItemsForQuoteWithData,
      task,
    });
  }
}

export default fp(qSeatEtabService, {
  name: 'qSeatEtabService',
  dependencies: [
    'lineItemRepository',
    'epicorAdapter',
    'hubspotAdapter',
    'backoff',
    'constants',
  ],
});