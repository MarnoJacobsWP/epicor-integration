import fp from 'fastify-plugin';

const padCustNum = (value) => {
  if (!value) return null;
  const str = String(value).trim();
  return str.padStart(4, '0');
};

const VALID_SALESREP_OPTIONS = [
  'CYA', 'House', 'Murphy Associates', 'Mike Kilcoyne and Associates', 
  'Reagan Penny', 'Phillips Contract Group, LLC', 'Dan Martin', 'Ginger Grant',
  'Bruce Longhino Group', 'Mike Fabionar', 'Morgan Associates', 
  'Heather Huddleston Interiors', 'Lauren East', 'Kevin Klieforth',
  'Jennifer Gates', 'Bobbie Zimmer', 'Elizabeth Gerber', 
  'Stephenson Toelkes Associates', 'John Parrish', 'Madison Mcsherry', 'Barry Holley', 'Unknown Option'
];

const toValidSalesRep = (salesRepName) => {
  if (!salesRepName || !salesRepName.trim()) return 'Unknown Option';
  const cleanName = salesRepName.trim();
  return VALID_SALESREP_OPTIONS.includes(cleanName) ? cleanName : 'Unknown Option';
};

const FIELD_MAPPINGS = [
  { epicor: 'Customer_CustNum', hubspot: 'customer_custnum', transform: padCustNum },
  { epicor: 'Customer_CustID', hubspot: 'customer_custid_', transform: (v) => v ? String(v).trim() : null },
  { epicor: 'Customer_Name', hubspot: 'name', transform: (v) => v ? String(v).trim().substring(0, 200) : null },
  { epicor: 'Customer_Address1', hubspot: 'address', transform: (v) => v ? String(v).trim().substring(0, 255) : null },
  { epicor: 'Customer_Address2', hubspot: 'address2', transform: (v) => v ? String(v).trim().substring(0, 255) : null },
  { epicor: 'Customer_Address3', hubspot: 'customer_addressc', transform: (v) => v ? String(v).trim().substring(0, 255) : null },
  { epicor: 'Customer_City', hubspot: 'city', transform: (v) => v ? String(v).trim().substring(0, 100) : null },
  { epicor: 'Customer_State', hubspot: 'hs_state_code', transform: (v) => v ? String(v).trim().substring(0, 50) : null },
  { epicor: 'Customer_Zip', hubspot: 'zip', transform: (v) => v ? String(v).trim().substring(0, 20) : null },
  { epicor: 'SalesRep_Name', hubspot: 'salesrep_name', transform: toValidSalesRep },
  { epicor: 'SalesRep1_Name', hubspot: 'salesrepa_name', transform: toValidSalesRep },
  { epicor: 'CustGrup_GroupDesc', hubspot: 'custgrup_groupdesc', transform: (v) => v ? String(v).trim().substring(0, 100) : null },
  { epicor: 'RowIdent', hubspot: 'rowident', transform: (v) => v ? String(v).trim() : null },
];

function transformEpicorToHubSpot(epicorCustomer) {
  const result = {};
  for (const { epicor, hubspot, transform } of FIELD_MAPPINGS) {
    const value = epicorCustomer[epicor];
    if (value != null && value !== '') {
      const transformed = transform ? transform(value) : value;
      if (transformed != null && transformed !== '') {
        result[hubspot] = transformed;
      }
    }
  }
  return result;
}

function validateAndCleanCustomer(customer) {
  const cleaned = { ...customer };
  
  if (cleaned.Customer_CustID) {
    cleaned.Customer_CustID = String(cleaned.Customer_CustID)
      .trim()
      .replace(/[^a-zA-Z0-9-_]/g, '_')
      .substring(0, 100);
  }
  
  if (cleaned.Customer_Name) {
    cleaned.Customer_Name = String(cleaned.Customer_Name)
      .trim()
      .replace(/[^\w\s-]/g, ' ')
      .substring(0, 200);
  }
  
  return cleaned;
}

function chunkArray(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

async function customerService(fastify, _) {
  const { ENDPOINTS, BATCH_SIZES } = fastify.constants;
  const BATCH_SIZE = BATCH_SIZES.CUSTOMERS || 100;
  const UNIQUE_PROPERTY = 'customer_custid_';

  async function infoRecord(data) {
    return await fastify.customerRepository.findByIdProperty(data);
  }

  async function updateDataBase(filter, data) {
    return await fastify.customerRepository.updateDatabase(filter, data);
  }

  async function createDataBase(data) {
    return await fastify.customerRepository.insertDatabase(data);
  }

  async function deleteDataBase(filter) {
    return await fastify.customerRepository.deleteDatabase(filter);
  }

  async function processCustomerBatch(customers) {
    const results = {
      total: customers.length,
      created: 0,
      updated: 0,
      errors: 0,
      errorDetails: [],
      skipped: 0
    };

    const batchData = [];
    const failedCustomers = [];
    
    for (const customer of customers) {
      try {
        const cleanedCustomer = validateAndCleanCustomer(customer);
        const custId = cleanedCustomer.Customer_CustID || cleanedCustomer.Customer_CustNum;
        
        if (!custId) {
          results.skipped++;
          failedCustomers.push({
            customer: customer.Customer_Name || 'Unknown',
            reason: 'Missing Customer ID'
          });
          continue;
        }

        const custIdStr = String(custId).trim();
        if (!custIdStr) {
          results.skipped++;
          failedCustomers.push({
            customer: customer.Customer_Name || 'Unknown',
            reason: 'Empty Customer ID'
          });
          continue;
        }

        let properties = transformEpicorToHubSpot(cleanedCustomer);
        
        if (!properties.name || properties.name.trim() === '') {
          fastify.log.warn(`Customer ${custIdStr} has empty name, using ID as name`);
          properties.name = `Customer ${custIdStr}`;
        }
        
        if (!properties[UNIQUE_PROPERTY]) {
          properties[UNIQUE_PROPERTY] = custIdStr;
        }
        
        const cleanProperties = {};
        for (const [key, value] of Object.entries(properties)) {
          if (value !== null && value !== undefined && value !== '') {
            cleanProperties[key] = String(value).substring(0, 500);
          }
        }
        
        if (!cleanProperties[UNIQUE_PROPERTY] || !cleanProperties.name) {
          results.skipped++;
          failedCustomers.push({
            customer: customer.Customer_Name || custIdStr,
            reason: `Missing required properties: UNIQUE=${!!cleanProperties[UNIQUE_PROPERTY]}, NAME=${!!cleanProperties.name}`
          });
          continue;
        }
        
        batchData.push({
          id: custIdStr,
          properties: cleanProperties
        });
        
      } catch (error) {
        results.errors++;
        results.errorDetails.push({
          error: error.message,
          customer: customer.Customer_Name || 'Unknown',
          customerId: customer.Customer_CustID || customer.Customer_CustNum
        });
        failedCustomers.push({
          customer: customer.Customer_Name || 'Unknown',
          customerId: customer.Customer_CustID || customer.Customer_CustNum,
          reason: error.message
        });
      }
    }

    if (batchData.length === 0) {
      fastify.log.warn('No valid customer data for batch processing', {
        failedCustomers: failedCustomers.slice(0, 5)
      });
      return results;
    }

    fastify.log.info(`Prepared ${batchData.length} companies for batch upsert, ${failedCustomers.length} failed validation`);

    try {
      const upsertResult = await fastify.backoff(() =>
        fastify.hubspotAdapter.batchUpsertCompanies(batchData, UNIQUE_PROPERTY)
      );

      if (upsertResult.status === 'COMPLETE' && upsertResult.results) {
        for (const result of upsertResult.results) {
          if (result.new) {
            results.created++;
          } else {
            results.updated++;
          }
          
          const customerCustId = result.properties?.[UNIQUE_PROPERTY];
          if (customerCustId) {
            const originalCustomer = customers.find(c => {
              const custId = c.Customer_CustID || c.Customer_CustNum;
              return custId && String(custId).trim() === customerCustId;
            });
            
            if (originalCustomer) {
              const query = {
                epicorId: originalCustomer.RowIdent,
                source: 'EpicorCustomers',
              };

              const dbData = {
                hubspotId: result.id,
                epicorId: originalCustomer.RowIdent,
                source: 'EpicorCustomers',
                customerId: customerCustId,
                action: result.new ? 'create' : 'update',
                timestamp: new Date()
              };

              let existRecord = await infoRecord(query);
              
              if (existRecord?.hubspotId) {
                await updateDataBase(query, dbData);
              } else {
                await createDataBase(dbData);
              }
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
      await processCustomersIndividually(customers, results);
    }

    return results;
  }

  async function processCustomersIndividually(customers, results) {
    fastify.log.info(`Starting individual processing for ${customers.length} customers...`);
    
    for (const customer of customers) {
      const custId = customer.Customer_CustID || customer.Customer_CustNum;
      const custName = customer.Customer_Name || 'unnamed';

      try {
        const query = {
          epicorId: customer.RowIdent,
          source: 'EpicorCustomers',
        };

        let existRecord = await infoRecord(query);

        if (!existRecord) {
          try {
            const searchData = await fastify.backoff(() =>
              fastify.hubspotAdapter.searchCompanies({
                body: {
                  filterGroups: [{ 
                    filters: [{ 
                      propertyName: UNIQUE_PROPERTY,
                      operator: 'EQ', 
                      value: String(custId) 
                    }] 
                  }],
                  limit: 1,
                  properties: [UNIQUE_PROPERTY, 'name'],
                },
              })
            );
            existRecord = searchData.results?.[0] || null;
          } catch (searchError) {
            existRecord = null;
          }
        }

        const props = transformEpicorToHubSpot(customer);
        
        const cleanProps = {};
        for (const [key, value] of Object.entries(props)) {
          if (value !== null && value !== undefined && value !== '') {
            cleanProps[key] = String(value);
          }
        }

        if (existRecord?.id || existRecord?.hubspotId) {
          const companyId = existRecord?.hubspotId || existRecord?.id;

          try {
            await fastify.backoff(() =>
              fastify.hubspotAdapter.updateCompany({ 
                companyId, 
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
            await updateDataBase(query, { action: 'update' });
          } else {
            await createDataBase({
              hubspotId: companyId,
              epicorId: customer.RowIdent,
              source: 'EpicorCustomers',
              customerId: custId,
              action: 'create'
            });
          }

          results.updated++;
        } else {
          const created = await fastify.backoff(() =>
            fastify.hubspotAdapter.createCompany({ properties: cleanProps })
          );
          const companyId = created.id;

          await createDataBase({
            hubspotId: companyId,
            epicorId: customer.RowIdent,
            source: 'EpicorCustomers',
            customerId: custId,
            action: 'create'
          });

          results.created++;
        }

      } catch (error) {
        fastify.log.error(`Customer ${custId} (${custName}) failed: ${error.message}`);
        results.errors++;
      }
    }
    
    fastify.log.info(`Individual processing complete: ${results.created} created, ${results.updated} updated, ${results.errors} errors`);
  }

  async function taskCustomers(dateString) {
    try {
      fastify.log.info('Fetching customers from Epicor...');
      const { records, metadata } = await fastify.epicorAdapter.fetchFilteredRecords(ENDPOINTS.CUSTOMERS);
      
      if (!records?.length) {
        fastify.log.warn('No customers found');
        return { 
          success: false, 
          message: 'No customers found', 
          metadata 
        };
      }

      const customerMap = new Map();
      for (const customer of records) {
        const custId = customer.Customer_CustID || customer.Customer_CustNum;
        if (!custId) continue;
        
        const custIdStr = String(custId).trim();
        const existing = customerMap.get(custIdStr);
        if (!existing || customer.Calculated_Time > existing.Calculated_Time) {
          customerMap.set(custIdStr, customer);
        }
      }

      const uniqueRecords = Array.from(customerMap.values());
      fastify.log.info(`Fetched ${records.length} customers, deduplicated to ${uniqueRecords.length}`);

      const batches = chunkArray(uniqueRecords, BATCH_SIZE);
      const batchResults = [];
      
      for (let i = 0; i < batches.length; i++) {
        fastify.log.info(`Processing batch ${i + 1}/${batches.length} (${batches[i].length} customers)...`);
        const result = await processCustomerBatch(batches[i]);
        batchResults.push(result);
        
        if (i < batches.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
      
      const totalResults = batchResults.reduce((acc, batch) => ({
        total: acc.total + batch.total,
        created: acc.created + batch.created,
        updated: acc.updated + batch.updated,
        errors: acc.errors + batch.errors,
        skipped: acc.skipped + batch.skipped
      }), { total: 0, created: 0, updated: 0, errors: 0, skipped: 0 });

      fastify.log.info(`Customer sync complete: ${totalResults.created} created, ${totalResults.updated} updated, ${totalResults.errors} errors`);
      return {
        success: true,
        syncedCount: uniqueRecords.length,
        createdCount: totalResults.created,
        updatedCount: totalResults.updated,
        errorCount: totalResults.errors,
        skippedCount: totalResults.skipped,
        totalEpicorCustomers: records.length,
        batchCount: batches.length,
        metadata
      };
    } catch (error) {
      fastify.log.error(`Error processing Task Customers: ${error.message}`);
      throw error;
    }
  }

  async function task(dateString) {
    try {
      fastify.log.info('Processing Tasks for Customers');
      return await taskCustomers(dateString);
    } catch (error) {
      fastify.log.error(`Error processing Tasks for Customers: ${error.message}`);
      throw error;
    }
  }

  if (!fastify.hasDecorator('customerTask')) {
    fastify.decorate('customerTask', { 
      task,
      processCustomerBatch
    });
  }
}

export default fp(customerService, {
  name: 'customerServices',
  dependencies: [
    'customerRepository',
    'epicorAdapter',
    'hubspotAdapter',
    'backoff',
    'constants',
  ],
});