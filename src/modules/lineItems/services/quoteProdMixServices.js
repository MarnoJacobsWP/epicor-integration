import fp from 'fastify-plugin';

const VALID_PRODGRUP_OPTIONS = [
  'Discounted Products', 'E-Tables', 'EVO', 'Free Standing', 'Glass',
  'New Casegoods, Training Tables', 'Panel Sales', 'Peds / Laterals',
  'Power Beam', 'Seating', 'PET', 'Xpand', 'Unknown Option'
];

const toValidProdGrup = (v) => {
  if (!v) return 'Unknown Option';
  return VALID_PRODGRUP_OPTIONS.includes(v) ? v : 'Unknown Option';
};

const FIELD_MAPPINGS = [
  { epicor: 'QuoteDtl_QuoteNum', hubspot: 'quotedtl_quotenum', transform: Number },
  { epicor: 'ProdGrup_Character01', hubspot: 'prodgrup_characterna', transform: toValidProdGrup },
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

async function quoteProdMixService(fastify, _) {
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

  async function appendDealProdGrupValue(dealId, prodGrupValue) {
    if (!dealId || !prodGrupValue) return;

    const propertyName = 'prodgrup_characterna';
    try {
      const deal = await fastify.backoff(() =>
        fastify.hubspotAdapter.getDealById({ dealId, properties: [propertyName] })
      );

      const existing = deal?.properties?.[propertyName] || '';
      const values = new Set(String(existing).split(';').filter(Boolean));
      values.add(prodGrupValue);

      const updated = Array.from(values).join(';');
      if (updated && updated !== existing) {
        await fastify.backoff(() =>
          fastify.hubspotAdapter.updateDeal({
            dealId,
            properties: { [propertyName]: updated }
          })
        );
      }
    } catch (error) {
      fastify.log.warn(`Failed to append prod group value to deal ${dealId}: ${error.message}`);
    }
  }

  async function processLineItemsIndividually(lineItems, dealId, results) {
    fastify.log.info(`Starting individual processing for ${lineItems.length} QuoteProdMix line items...`);
    
    for (const lineItem of lineItems) {
      const rowident = lineItem.RowIdent;

      try {
        const props = transformEpicorToHubSpot(lineItem);
        props.name = props.prodgrup_characterna || 'Unnamed Product';

        const cleanProps = {
          name: props.name,
          price: props.price,
          rowident_: props.rowident_,
          prodgrup_characterna: props.prodgrup_characterna
        };

        Object.keys(cleanProps).forEach(key => {
          if (cleanProps[key] === null || cleanProps[key] === undefined) {
            delete cleanProps[key];
          }
        });

        const query = {
          epicorId: lineItem.RowIdent,
          source: 'EpicorQuoteProdMix',
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
              fastify.log.warn(`QuoteProdMix line item ${rowident} deleted from DB`);
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
              source: 'EpicorQuoteProdMix',
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

            await appendDealProdGrupValue(dealId, props.prodgrup_characterna);
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
            source: 'EpicorQuoteProdMix',
            quoteNum: lineItem.QuoteDtl_QuoteNum,
            action: 'create'
          });

          results.created++;

          if (dealId) {
            await appendDealProdGrupValue(dealId, props.prodgrup_characterna);
          }
        }

      } catch (error) {
        fastify.log.error(`QuoteProdMix line item ${rowident} failed: ${error.message}`);
        results.errors++;
      }
    }
    
    fastify.log.info(`QuoteProdMix individual processing complete: ${results.created} created, ${results.updated} updated, ${results.errors} errors`);
  }

  async function syncLineItemsForQuoteWithData(quoteNum, dealId, quoteRecords) {
    if (!quoteRecords.length) {
      return { success: true, message: 'No line items for this quote', lineItemCount: 0 };
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
    fastify.log.info(`Found ${uniqueRecords.length} unique QuoteProdMix line items for quote ${quoteNum}, processing individually...`);

    const results = {
      total: uniqueRecords.length,
      created: 0,
      updated: 0,
      errors: 0,
      skipped: 0,
      errorDetails: []
    };

    await processLineItemsIndividually(uniqueRecords, dealId, results);
    
    fastify.log.info(`QuoteProdMix sync for quote ${quoteNum} complete: ${results.created} created, ${results.updated} updated, ${results.errors} errors, ${results.skipped} skipped`);

    return {
      success: true,
      lineItemCount: uniqueRecords.length,
      createdCount: results.created,
      updatedCount: results.updated,
      errorCount: results.errors,
      skippedCount: results.skipped,
      prodgrupValues: [...new Set(uniqueRecords.map(r => toValidProdGrup(r.ProdGrup_Character01)).filter(Boolean))]
    };
  }

  async function syncLineItemsForQuote(quoteNum, dealId) {
    fastify.log.info(`Fetching QuoteProdMix line items for quote ${quoteNum}...`);
    const { records } = await fastify.epicorAdapter.fetchRelatedRecords(
      fastify.constants.ENDPOINTS.QUOTE_PROD_MIX,
      'QuoteDtl_QuoteNum',
      quoteNum
    );
    
    if (!records?.length) {
      fastify.log.info(`No QuoteProdMix line items found for quote ${quoteNum}`);
      return { success: true, message: 'No QuoteProdMix line items for this quote', lineItemCount: 0 };
    }

    return await syncLineItemsForQuoteWithData(quoteNum, dealId, records);
  }

  async function task(dateString) {
    try {
      fastify.log.info('Processing Tasks for Quote Line Items');
      return { success: true, message: 'Quote line items processed by quote service' };
    } catch (error) {
      fastify.log.error(`Error processing Tasks for Quote Line Items - ${error.message}`);
      throw error;
    }
  }

  if (!fastify.hasDecorator('quoteProdMixService')) {
    fastify.decorate('quoteProdMixService', {
      syncLineItemsForQuote,
      syncLineItemsForQuoteWithData,
      task,
    });
  }
}

export default fp(quoteProdMixService, {
  name: 'quoteProdMixService',
  dependencies: [
    'lineItemRepository',
    'epicorAdapter',
    'hubspotAdapter',
    'backoff',
    'constants',
  ],
});