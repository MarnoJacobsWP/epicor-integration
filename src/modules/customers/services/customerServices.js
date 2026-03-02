import fp from 'fastify-plugin';
import { chunkArray, padCustNum } from '../../../utils/arrayHelpers.js';

const FIELD_MAPPINGS = [
  { epicor: 'Customer_CustNum', hubspot: 'customer_custnum', transform: padCustNum }, //Customer Cust Num - customer_custnum
  { epicor: 'Customer_CustID', hubspot: 'customer_id', transform: padCustNum }, //Customer ID - customer_id - customer_custid_
  { epicor: 'Customer_Name', hubspot: 'name', transform: (v) => v ? String(v).trim().substring(0, 200) : null }, //Company Name - name
  { epicor: 'Customer_Address1', hubspot: 'address', transform: (v) => v ? String(v).trim().substring(0, 255) : null }, //Street Address - address
  { epicor: 'Customer_Address2', hubspot: 'address2', transform: (v) => v ? String(v).trim().substring(0, 255) : null }, //Street Address 2 - address2
  { epicor: 'Customer_Address3', hubspot: 'customer_addressc', transform: (v) => v ? String(v).trim().substring(0, 255) : null }, //Customer Address3 - customer_addressc
  { epicor: 'Customer_City', hubspot: 'city', transform: (v) => v ? String(v).trim().substring(0, 100) : null }, //City - city
  { epicor: 'Customer_State', hubspot: 'hs_state_code', transform: (v) => v ? String(v).trim().substring(0, 50) : null }, //State/Region Code - hs_state_code
  { epicor: 'Customer_Zip', hubspot: 'zip', transform: (v) => v ? String(v).trim().substring(0, 20) : null }, //Postal Code - zip
  { epicor: 'SalesRep_Name', hubspot: 'salesrep', transform: (v) => v ? String(v).trim() : null }, //Sales Rep - salesrep
  { epicor: 'SalesRep1_Name', hubspot: 'salesrepa_name', transform: (v) => v ? String(v).trim() : null }, //CSR Name - salesrepa_name
  { epicor: 'CustGrup_GroupDesc', hubspot: 'custgrup_groupdesc', transform: (v) => v ? String(v).trim().substring(0, 100) : null }, //Tier - custgrup_groupdesc
  { epicor: 'RowIdent', hubspot: 'rowident', transform: (v) => v ? String(v).trim() : null }, //Row Ident - rowident
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

async function customerService(fastify, _) {
  const { ENDPOINTS, BATCH_SIZES, HUBSPOT_ASSOCIATIONS } = fastify.constants;
  const BATCH_SIZE = BATCH_SIZES.CUSTOMERS || 100;
  const UNIQUE_PROPERTY = 'customer_id';
  const UNKNOWN_OPTION = 'Unknown Option';

  async function getValidOptions(propertyName) {
    try {
      const options = await fastify.backoff(() =>
        fastify.hubspotAdapter.getPropertyOptions('companies', propertyName)
      );
      return new Set(options || []);
    } catch (error) {
      fastify.log.warn(`Failed loading HubSpot options for ${propertyName}: ${error.message}`);
      return new Set();
    }
  }

  async function getSalesRepOptionSets() {
    const [salesrep, salesrepa] = await Promise.all([
      getValidOptions('salesrep'),
      getValidOptions('salesrepa_name'),
    ]);

    salesrep.add(UNKNOWN_OPTION);
    salesrepa.add(UNKNOWN_OPTION);
    return { salesrep, salesrepa };
  }

  function normalizeSalesRepValue(value, optionsSet) {
    const clean = String(value || '').trim();
    if (!clean) return UNKNOWN_OPTION;
    return optionsSet.has(clean) ? clean : UNKNOWN_OPTION;
  }

  async function associateContactsToCompany(companyId, custNum) {
    try {
      if (!custNum) return;
      const contactSearch = await fastify.backoff(() =>
        fastify.hubspotAdapter.searchContactsByProperty('custcnt_custnum', [custNum])
      );
      if (contactSearch.results?.length > 0) {
        for (const contact of contactSearch.results) {
          await fastify.hubspotAdapter.ensureAssociation(
            'companies',
            companyId,
            'contacts',
            contact.id,
            HUBSPOT_ASSOCIATIONS.COMPANY_TO_CONTACT
          );
        }
        fastify.log.info(`Associated company ${companyId} with ${contactSearch.results.length} contact(s)`);
      }
    } catch (associationError) {
      fastify.log.warn(`Failed to associate contacts for company ${companyId}: ${associationError.message}`);
    }
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
    
    const salesRepOptions = await getSalesRepOptionSets();

    for (const customer of customers) {
      try {
        const custIdRaw = customer.Customer_CustID || customer.Customer_CustNum;
        const custId = padCustNum(custIdRaw);
        
        if (!custId) {
          results.skipped++;
          failedCustomers.push({
            customer: customer.Customer_Name || 'Unknown',
            reason: 'Missing Customer ID'
          });
          continue;
        }

        const custIdStr = custId ? String(custId).trim() : '';
        if (!custIdStr) {
          results.skipped++;
          failedCustomers.push({
            customer: customer.Customer_Name || 'Unknown',
            reason: 'Empty Customer ID'
          });
          continue;
        }

        let properties = transformEpicorToHubSpot(customer);
        properties.salesrep = normalizeSalesRepValue(properties.salesrep, salesRepOptions.salesrep);
        properties.salesrepa_name = normalizeSalesRepValue(properties.salesrepa_name, salesRepOptions.salesrepa);
        
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
          properties: cleanProperties,
          _original: customer
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
      fastify.log.warn(`No valid customer data for batch processing - ${failedCustomers.length} failed validation`);
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
            const batchItem = batchData.find(b => String(b.id).trim() === customerCustId);
            const originalCustomer = batchItem?._original;
            
            if (originalCustomer) {
              const custNum = originalCustomer.Customer_CustNum ? padCustNum(originalCustomer.Customer_CustNum) : null;
              await associateContactsToCompany(result.id, custNum);
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
      fastify.log.error(`Batch upsert failed: ${error.message} [${error.response?.status || 'no-status'}]`);
      
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
    const salesRepOptions = await getSalesRepOptionSets();
    
    for (const customer of customers) {
      const custIdRaw = customer.Customer_CustID || customer.Customer_CustNum;
      const custId = padCustNum(custIdRaw);
      const custName = customer.Customer_Name || 'unnamed';

      try {
        if (!custId) {
          results.skipped++;
          continue;
        }

        // Search HubSpot directly by unique property to find existing company
        let existingCompany = null;

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
          existingCompany = searchData.results?.[0] || null;
        } catch (searchError) {
          fastify.log.warn(`Customer ${custId} company search failed: ${searchError.message}`);
          existingCompany = null;
        }

        const props = transformEpicorToHubSpot(customer);
        props.salesrep = normalizeSalesRepValue(props.salesrep, salesRepOptions.salesrep);
        props.salesrepa_name = normalizeSalesRepValue(props.salesrepa_name, salesRepOptions.salesrepa);

        if (!props[UNIQUE_PROPERTY]) {
          props[UNIQUE_PROPERTY] = String(custId);
        }

        const cleanProps = {};
        for (const [key, value] of Object.entries(props)) {
          if (value !== null && value !== undefined && value !== '') {
            cleanProps[key] = String(value);
          }
        }

        const custNum = customer.Customer_CustNum ? padCustNum(customer.Customer_CustNum) : null;

        if (existingCompany?.id) {
          const companyId = existingCompany.id;

          await fastify.backoff(() =>
            fastify.hubspotAdapter.updateCompany({ 
              companyId, 
              properties: cleanProps 
            })
          );

          await associateContactsToCompany(companyId, custNum);
          results.updated++;
        } else {
          const created = await fastify.backoff(() =>
            fastify.hubspotAdapter.createCompany({ properties: cleanProps })
          );
          const companyId = created.id;

          await associateContactsToCompany(companyId, custNum);
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
        const custIdRaw = customer.Customer_CustID || customer.Customer_CustNum;
        const custId = padCustNum(custIdRaw);
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
    'epicorAdapter',
    'hubspotAdapter',
    'backoff',
    'constants',
  ],
});