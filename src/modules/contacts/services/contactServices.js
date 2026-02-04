import fp from 'fastify-plugin';

const padCustNum = (value) => {
  if (!value) return null;
  const str = String(value).trim();
  return str.padStart(4, '0');
};

const FIELD_MAPPINGS = [
  { epicor: 'CustCnt_CustNum', hubspot: 'custcnt_custnum', transform: padCustNum },
  { epicor: 'CustCnt_Name', hubspot: 'custcnt_name' },
  { epicor: 'CustCnt_PhoneNum', hubspot: 'phone' },
  { epicor: 'CustCnt_EMailAddress', hubspot: 'email' },
  { epicor: 'CustCnt_ContactTitle', hubspot: 'jobtitle' },
  { epicor: 'RowIdent', hubspot: 'rowident' },
  { epicor: 'CustCnt_SFUser', hubspot: 'custcnt_sfuser', transform: Boolean },
];

function transformEpicorToHubSpot(epicorContact) {
  const result = {};
  for (const { epicor, hubspot, transform } of FIELD_MAPPINGS) {
    const value = epicorContact[epicor];
    if (value != null) {
      const transformed = transform ? transform(value) : value;
      if (transformed != null) result[hubspot] = transformed;
    }
  }
  return result;
}

function chunkArray(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

async function contactService(fastify, _) {
  const { ENDPOINTS, BATCH_SIZES } = fastify.constants;
  const BATCH_SIZE = BATCH_SIZES.CONTACTS || 100;
  const UNIQUE_PROPERTY = 'email';

  async function infoRecord(data) {
    return await fastify.contactRepository.findByIdProperty(data);
  }

  async function updateDataBase(filter, data) {
    return await fastify.contactRepository.updateDatabase(filter, data);
  }

  async function createDataBase(data) {
    return await fastify.contactRepository.insertDatabase(data);
  }

  async function deleteDataBase(filter) {
    return await fastify.contactRepository.deleteDatabase(filter);
  }

  async function processContactBatch(contacts) {
    const results = {
      total: contacts.length,
      created: 0,
      updated: 0,
      errors: 0,
      errorDetails: [],
      skipped: 0
    };

    const batchData = [];
    
    for (const contact of contacts) {
      try {
        const email = contact.CustCnt_EMailAddress;
        if (!email) {
          results.skipped++;
          continue;
        }

        const emailStr = String(email).trim().toLowerCase();
        if (!emailStr) {
          results.skipped++;
          continue;
        }

        let properties = transformEpicorToHubSpot(contact);
        
        if (!properties[UNIQUE_PROPERTY]) {
          properties[UNIQUE_PROPERTY] = emailStr;
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
          id: emailStr,
          properties: cleanProperties
        });
        
      } catch (error) {
        results.errors++;
        results.errorDetails.push({
          error: error.message,
          contact: contact.CustCnt_Name || 'Unknown'
        });
      }
    }

    if (batchData.length === 0) {
      fastify.log.warn('No valid contact data for batch processing');
      return results;
    }

    fastify.log.info(`Prepared ${batchData.length} contacts for batch upsert`);

    try {
      const upsertResult = await fastify.backoff(() =>
        fastify.hubspotAdapter.batchUpsertContacts(batchData, UNIQUE_PROPERTY)
      );

      if (upsertResult.status === 'COMPLETE' && upsertResult.results) {
        for (const result of upsertResult.results) {
          const email = result.properties?.email;
          const originalContact = contacts.find(c => {
            const contactEmail = c.CustCnt_EMailAddress;
            return contactEmail && String(contactEmail).trim().toLowerCase() === email;
          });
          
          if (originalContact) {
            const query = {
              epicorId: originalContact.RowIdent,
              source: 'EpicorContacts',
            };

            const dbData = {
              hubspotId: result.id,
              epicorId: originalContact.RowIdent,
              source: 'EpicorContacts',
              email: email,
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
              const custNum = originalContact.CustCnt_CustNum ? padCustNum(originalContact.CustCnt_CustNum) : null;
              if (custNum) {
                const companySearch = await fastify.backoff(() =>
                  fastify.hubspotAdapter.searchCompaniesByProperty('customer_custnum', [custNum])
                );
                if (companySearch.results?.[0]?.id) {
                  await fastify.hubspotAdapter.createAssociation(
                    'companies',
                    companySearch.results[0].id,
                    'contacts',
                    result.id,
                    2
                  );
                  fastify.log.info(`Associated contact ${email} to company ${companySearch.results[0].id}`);
                }
              }
            } catch (associationError) {
              fastify.log.warn(`Failed to associate contact ${email}: ${associationError.message}`);
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
      await processContactsIndividually(contacts, results);
    }

    return results;
  }

  async function processContactsIndividually(contacts, results) {
    fastify.log.info(`Starting individual processing for ${contacts.length} contacts...`);
    
    for (const contact of contacts) {
      const email = contact.CustCnt_EMailAddress;
      const contactName = contact.CustCnt_Name || 'unnamed';

      try {
        if (!email) {
          results.skipped++;
          continue;
        }

        const query = {
          epicorId: contact.RowIdent,
          source: 'EpicorContacts',
        };

        let existRecord = await infoRecord(query);

        if (!existRecord) {
          try {
            const searchData = await fastify.backoff(() =>
              fastify.hubspotAdapter.searchContactsByProperty('email', [email])
            );
            existRecord = searchData.results?.[0] || null;
          } catch (searchError) {
            existRecord = null;
          }
        }

        const props = transformEpicorToHubSpot(contact);
        
        const cleanProps = {};
        for (const [key, value] of Object.entries(props)) {
          if (value !== null && value !== undefined && value !== '') {
            cleanProps[key] = String(value);
          }
        }

        if (existRecord?.id || existRecord?.hubspotId) {
          const contactId = existRecord?.hubspotId || existRecord?.id;

          try {
            await fastify.backoff(() =>
              fastify.hubspotAdapter.updateContact({ 
                contactId, 
                properties: cleanProps 
              })
            );
          } catch (updateError) {
            if (updateError?.response?.data?.message?.toLowerCase() === 'resource not found') {
              await deleteDataBase(query);
            } else {
              throw updateError;
            }
          }

          if (existRecord?.hubspotId) {
            await updateDataBase(query, { action: 'update', timestamp: new Date() });
          } else {
            await createDataBase({
              hubspotId: contactId,
              epicorId: contact.RowIdent,
              source: 'EpicorContacts',
              email: email,
              action: 'create',
              timestamp: new Date()
            });
          }

          try {
            const custNum = contact.CustCnt_CustNum ? padCustNum(contact.CustCnt_CustNum) : null;
            if (custNum) {
              const companySearch = await fastify.backoff(() =>
                fastify.hubspotAdapter.searchCompaniesByProperty('customer_custnum', [custNum])
              );
              if (companySearch.results?.[0]?.id) {
                await fastify.hubspotAdapter.createAssociation(
                  'companies',
                  companySearch.results[0].id,
                  'contacts',
                  contactId,
                  2
                );
                fastify.log.info(`Associated contact ${email} to company ${companySearch.results[0].id}`);
              }
            }
          } catch (associationError) {
            fastify.log.warn(`Failed to associate contact ${email}: ${associationError.message}`);
          }

          results.updated++;
        } else {
          const created = await fastify.backoff(() =>
            fastify.hubspotAdapter.createContact({ properties: cleanProps })
          );
          const contactId = created.id;

          await createDataBase({
            hubspotId: contactId,
            epicorId: contact.RowIdent,
            source: 'EpicorContacts',
            email: email,
            action: 'create',
            timestamp: new Date()
          });

          try {
            const custNum = contact.CustCnt_CustNum ? padCustNum(contact.CustCnt_CustNum) : null;
            if (custNum) {
              const companySearch = await fastify.backoff(() =>
                fastify.hubspotAdapter.searchCompaniesByProperty('customer_custnum', [custNum])
              );
              if (companySearch.results?.[0]?.id) {
                await fastify.hubspotAdapter.createAssociation(
                  'companies',
                  companySearch.results[0].id,
                  'contacts',
                  contactId,
                  2
                );
                fastify.log.info(`Associated contact ${email} to company ${companySearch.results[0].id}`);
              }
            }
          } catch (associationError) {
            fastify.log.warn(`Failed to associate contact ${email}: ${associationError.message}`);
          }

          results.created++;
        }

      } catch (error) {
        fastify.log.error(`Contact ${email} (${contactName}) failed: ${error.message}`);
        results.errors++;
      }
    }
    
    fastify.log.info(`Individual processing complete: ${results.created} created, ${results.updated} updated, ${results.errors} errors`);
  }

  async function syncFilteredContacts(dateString) {
    fastify.log.info('Fetching contacts from Epicor...');
    const { records, metadata } = await fastify.epicorAdapter.fetchFilteredRecords(ENDPOINTS.CONTACTS);
    
    if (!records?.length) {
      fastify.log.warn('No contacts found');
      return { success: false, message: 'No contacts found', metadata };
    }
    
    const contactMap = new Map();
    for (const contact of records) {
      const email = contact.CustCnt_EMailAddress;
      if (!email) continue;
      
      const emailKey = String(email).trim().toLowerCase();
      const existing = contactMap.get(emailKey);
      if (!existing || contact.Calculated_Time > existing.Calculated_Time) {
        contactMap.set(emailKey, contact);
      }
    }
    
    const uniqueRecords = Array.from(contactMap.values());
    fastify.log.info(`Fetched ${records.length} contacts, deduplicated to ${uniqueRecords.length}, starting batch sync...`);

    const batches = chunkArray(uniqueRecords, BATCH_SIZE);
    const batchResults = [];
    
    for (let i = 0; i < batches.length; i++) {
      fastify.log.info(`Processing batch ${i + 1}/${batches.length} (${batches[i].length} contacts)...`);
      const result = await processContactBatch(batches[i]);
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
    
    fastify.log.info(`Contact batch sync complete: ${totalResults.created} created, ${totalResults.updated} updated, ${totalResults.errors} errors, ${totalResults.skipped} skipped`);
    
    return {
      success: true,
      syncedCount: uniqueRecords.length,
      createdCount: totalResults.created,
      updatedCount: totalResults.updated,
      errorCount: totalResults.errors,
      skippedCount: totalResults.skipped,
      totalEpicorContacts: records.length,
      batchCount: batches.length,
      metadata
    };
  }

  async function task(dateString) {
    try {
      fastify.log.info('Processing Tasks for Contacts');
      return await syncFilteredContacts(dateString);
    } catch (error) {
      fastify.log.error(`Error processing Tasks for Contacts - ${error.message}`);
      throw error;
    }
  }

  if (!fastify.hasDecorator('contactTask')) {
    fastify.decorate('contactTask', { 
      task,
      processContactBatch
    });
  }
}

export default fp(contactService, {
  name: 'contactServices',
  dependencies: [
    'contactRepository',
    'epicorAdapter',
    'hubspotAdapter',
    'backoff',
    'constants',
  ],
});