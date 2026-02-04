import fp from 'fastify-plugin';

class HubspotAdapter {
  constructor(httpClient, config, logger) {
    this.client = httpClient;
    this.baseURL = 'https://api.hubapi.com';
    this.token = config.HUBSPOT_ACCESS_TOKEN;
    this.logger = logger;
    
    if (!this.token) {
      this.logger.warn('HubSpot access token is empty');
    }
  }

  async _makeRequest(method, url, data = null, options = {}) {
    const config = {
      method,
      url: `${this.baseURL}${url}`,
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
      ...options
    };
    
    if (data) {
      config.data = data;
    }
    
    try {
      const response = await this.client(config);
      return response;
    } catch (error) {
      this.logger.error(`HubSpot API request failed: ${error.message}`, {
        url: config.url,
        method: config.method,
        status: error.response?.status,
        statusText: error.response?.statusText,
        data: error.response?.data,
        requestData: data ? (Array.isArray(data.inputs) ? 
          { inputs: data.inputs.slice(0, 2), total: data.inputs.length } : 
          data) : null
      });
      throw error;
    }
  }

  async batchUpsertCompanies(batchData, idProperty = 'customer_custid_') {
    try {
      this.logger.info(`Batch upsert: ${batchData.length} companies, idProperty: ${idProperty}`);
      
      if (batchData.length > 0) {
        this.logger.debug('First batch item:', JSON.stringify(batchData[0], null, 2));
      }
      
      const inputs = batchData.map((item, index) => {
        if (!item.id) {
          throw new Error(`Item ${index}: Missing id field`);
        }
        
        if (!item.properties || typeof item.properties !== 'object') {
          throw new Error(`Item ${index}: Invalid properties`);
        }
        
        const uniquePropertyValue = item.properties[idProperty] || String(item.id);
        if (!item.properties[idProperty]) {
          item.properties[idProperty] = uniquePropertyValue;
        }
        
        const cleanedProperties = {};
        for (const [key, value] of Object.entries(item.properties)) {
          if (value !== null && value !== undefined && value !== '') {
            let cleanedValue = String(value);
            cleanedValue = cleanedValue.replace(/\u0000/g, '');
            cleanedValue = cleanedValue.replace(/[^\x20-\x7E\u00A0-\u00FF]/g, '?');
            cleanedProperties[key] = cleanedValue.substring(0, 1000);
          }
        }
        
        return {
          id: String(item.id),
          properties: cleanedProperties,
          idProperty: idProperty
        };
      });
      
      this.logger.debug('Batch upsert request payload sample:', { 
        total: inputs.length,
        firstInput: inputs[0],
        lastInput: inputs[inputs.length - 1]
      });
      
      try {
        const response = await this._makeRequest(
          'POST',
          '/crm/v3/objects/companies/batch/upsert',
          { inputs }
        );
        
        const result = response.data;
        
        if (result.status === 'COMPLETE') {
          const created = result.results?.filter(r => r.new)?.length || 0;
          const updated = result.results?.filter(r => !r.new)?.length || 0;
          this.logger.info(`Batch completed: Created ${created}, Updated ${updated}, Errors: ${result.numErrors || 0}`);
        } else {
          this.logger.warn(`Batch status: ${result.status}`);
        }
        
        return result;
        
      } catch (requestError) {
        if (requestError.response?.status === 400) {
          const errorData = requestError.response.data;
          this.logger.error('HubSpot Batch Upsert Error Details:', {
            message: errorData.message,
            correlationId: errorData.correlationId,
            errors: errorData.errors,
            status: errorData.status,
            category: errorData.category
          });
          
          if (errorData.errors && errorData.errors.length > 0) {
            errorData.errors.forEach((err, idx) => {
              this.logger.error(`Error ${idx + 1}:`, {
                message: err.message,
                context: err.context,
                subCategory: err.subCategory
              });
            });
          }
        }
        throw requestError;
      }
      
    } catch (error) {
      if (error.response?.status === 400) {
        this.logger.error({ errorResponse: error.response.data }, 'HubSpot Companies Batch Upsert - Full Error Response');
        this.logger.error({ sampleInputs: batchData.slice(0, 2) }, 'HubSpot Companies Batch Upsert - Sample Inputs');
      } else {
        this.logger.error('HubSpot batchUpsertCompanies failed:', {
          message: error.message,
          stack: error.stack
        });
      }
      throw error;
    }
  }

  async batchUpsertContacts(batchData, idProperty = 'email') {
    try {
      this.logger.info(`Batch upsert: ${batchData.length} contacts, idProperty: ${idProperty}`);
      
      const inputs = batchData.map((item, index) => {
        if (!item.id) {
          throw new Error(`Item ${index}: Missing id field`);
        }
        
        if (!item.properties || typeof item.properties !== 'object') {
          throw new Error(`Item ${index}: Invalid properties`);
        }
        
        const uniquePropertyValue = item.properties[idProperty] || String(item.id);
        if (!item.properties[idProperty]) {
          item.properties[idProperty] = uniquePropertyValue;
        }
        
        const cleanedProperties = {};
        for (const [key, value] of Object.entries(item.properties)) {
          if (value !== null && value !== undefined && value !== '') {
            cleanedProperties[key] = String(value).substring(0, 1000);
          }
        }
        
        return {
          id: String(item.id),
          properties: cleanedProperties,
          idProperty: idProperty
        };
      });
      
      this.logger.debug('Contacts batch upsert request payload:', { inputs: inputs.slice(0, 1) });
      
      const response = await this._makeRequest(
        'POST',
        '/crm/v3/objects/contacts/batch/upsert',
        { inputs }
      );
      
      const result = response.data;
      
      if (result.status === 'COMPLETE') {
        const created = result.results?.filter(r => r.new)?.length || 0;
        const updated = result.results?.filter(r => !r.new)?.length || 0;
        this.logger.info(`Contacts batch completed: Created ${created}, Updated ${updated}, Errors: ${result.numErrors || 0}`);
      } else {
        this.logger.warn(`Contacts batch status: ${result.status}`);
      }
      
      return result;
      
    } catch (error) {
      if (error.response?.status === 400) {
        this.logger.error({ errorResponse: error.response.data }, 'HubSpot Contacts Batch Upsert - Full Error Response');
        this.logger.error({ sampleInputs: batchData.slice(0, 2) }, 'HubSpot Contacts Batch Upsert - Sample Inputs');
      }
      throw error;
    }
  }

  async batchUpsertDeals(batchData, idProperty = 'orderhed_ordernum') {
    let inputs;
    try {
      this.logger.info(`Batch upsert: ${batchData.length} deals, idProperty: ${idProperty}`);
      
      inputs = batchData.map((item, index) => {
        if (!item.id) {
          throw new Error(`Item ${index}: Missing id field`);
        }
        
        if (!item.properties || typeof item.properties !== 'object') {
          throw new Error(`Item ${index}: Invalid properties`);
        }
        
        const uniquePropertyValue = item.properties[idProperty] || String(item.id);
        if (!item.properties[idProperty]) {
          item.properties[idProperty] = uniquePropertyValue;
        }
        
        const cleanedProperties = {};
        for (const [key, value] of Object.entries(item.properties)) {
          if (value !== null && value !== undefined && value !== '') {
            cleanedProperties[key] = String(value).substring(0, 1000);
          }
        }
        
        return {
          id: String(item.id),
          properties: cleanedProperties,
          idProperty: idProperty
        };
      });
      
      this.logger.debug('Deals batch upsert request payload:', { inputs: inputs.slice(0, 1) });
      
      const response = await this._makeRequest(
        'POST',
        '/crm/v3/objects/deals/batch/upsert',
        { inputs }
      );
      
      const result = response.data;
      
      if (result.status === 'COMPLETE') {
        const created = result.results?.filter(r => r.new)?.length || 0;
        const updated = result.results?.filter(r => !r.new)?.length || 0;
        this.logger.info(`Deals batch completed: Created ${created}, Updated ${updated}, Errors: ${result.numErrors || 0}`);
      } else {
        this.logger.warn(`Deals batch status: ${result.status}`);
      }
      
      return result;
      
    } catch (error) {
      if (error.response?.status === 400) {
        this.logger.error({ errorResponse: error.response.data }, 'HubSpot Deals Batch Upsert - Full Error Response');
        this.logger.error({ sampleInputs: inputs?.slice(0, 2) }, 'HubSpot Deals Batch Upsert - Sample Inputs');
      }
      throw error;
    }
  }

  async batchUpsertLineItems(batchData, idProperty = 'rowident_') {
    try {
      this.logger.info(`Batch upsert: ${batchData.length} line items, idProperty: ${idProperty}`);
      
      const inputs = batchData.map((item, index) => {
        if (!item.id) {
          throw new Error(`Item ${index}: Missing id field`);
        }
        
        if (!item.properties || typeof item.properties !== 'object') {
          throw new Error(`Item ${index}: Invalid properties`);
        }
        
        const uniquePropertyValue = item.properties[idProperty] || String(item.id);
        if (!item.properties[idProperty]) {
          item.properties[idProperty] = uniquePropertyValue;
        }
        
        const cleanedProperties = {};
        for (const [key, value] of Object.entries(item.properties)) {
          if (value !== null && value !== undefined && value !== '') {
            cleanedProperties[key] = String(value).substring(0, 1000);
          }
        }
        
        return {
          id: String(item.id),
          properties: cleanedProperties,
          idProperty: idProperty
        };
      });
      
      this.logger.debug('Line items batch upsert request payload:', { inputs: inputs.slice(0, 1) });
      
      const response = await this._makeRequest(
        'POST',
        '/crm/v3/objects/line_items/batch/upsert',
        { inputs }
      );
      
      const result = response.data;
      
      if (result.status === 'COMPLETE') {
        const created = result.results?.filter(r => r.new)?.length || 0;
        const updated = result.results?.filter(r => !r.new)?.length || 0;
        this.logger.info(`Line items batch completed: Created ${created}, Updated ${updated}, Errors: ${result.numErrors || 0}`);
      } else {
        this.logger.warn(`Line items batch status: ${result.status}`);
      }
      
      return result;
      
    } catch (error) {
      if (error.response?.status === 400) {
        this.logger.error({ errorResponse: error.response.data }, 'HubSpot Line Items Batch Upsert - Full Error Response');
        this.logger.error({ sampleInputs: batchData.slice(0, 2) }, 'HubSpot Line Items Batch Upsert - Sample Inputs');
      }
      throw error;
    }
  }

  async searchCompaniesByProperty(propertyName, values) {
    if (!values.length) {
      return { results: [] };
    }
    
    try {
      this.logger.debug(`Searching companies by ${propertyName}:`, values);
      
      const CHUNK_SIZE = 10;
      const valueChunks = [];
      
      for (let i = 0; i < values.length; i += CHUNK_SIZE) {
        valueChunks.push(values.slice(i, i + CHUNK_SIZE));
      }
      
      const allResults = [];
      
      for (const chunk of valueChunks) {
        const filterGroups = chunk.map(value => ({
          filters: [{ 
            propertyName: propertyName, 
            operator: 'EQ', 
            value: String(value) 
          }]
        }));
        
        this.logger.debug(`Search request for ${propertyName}:`, { filterGroups });
        
        const response = await this._makeRequest(
          'POST',
          '/crm/v3/objects/companies/search',
          {
            filterGroups,
            properties: [propertyName, 'name', 'id'],
            limit: chunk.length
          }
        );
        
        this.logger.debug(`Search response: found ${response.data.results?.length || 0} companies for ${chunk}`);
        if (response.data.results?.length > 0) {
          this.logger.debug('Sample result:', response.data.results[0]);
        }
        
        if (response.data.results) {
          allResults.push(...response.data.results);
        }
        
        if (valueChunks.length > 1) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
      
      this.logger.debug(`Total companies found: ${allResults.length} for values:`, values);
      
      return { results: allResults };
      
    } catch (error) {
      this.logger.error(`Batch search companies failed: ${error.message}`);
      throw error;
    }
  }

  async searchContactsByProperty(propertyName, values) {
    if (!values.length) {
      return { results: [] };
    }
    
    try {
      const CHUNK_SIZE = 10;
      const valueChunks = [];
      
      for (let i = 0; i < values.length; i += CHUNK_SIZE) {
        valueChunks.push(values.slice(i, i + CHUNK_SIZE));
      }
      
      const allResults = [];
      
      for (const chunk of valueChunks) {
        const filterGroups = chunk.map(value => ({
          filters: [{ 
            propertyName: propertyName, 
            operator: 'EQ', 
            value: String(value) 
          }]
        }));
        
        const response = await this._makeRequest(
          'POST',
          '/crm/v3/objects/contacts/search',
          {
            filterGroups,
            properties: [propertyName, 'firstname', 'lastname', 'email', 'id'],
            limit: chunk.length
          }
        );
        
        if (response.data.results) {
          allResults.push(...response.data.results);
        }
        
        if (valueChunks.length > 1) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
      
      return { results: allResults };
      
    } catch (error) {
      this.logger.error(`Batch search contacts failed: ${error.message}`);
      throw error;
    }
  }

  async searchDealsByProperty(propertyName, values) {
    if (!values.length) {
      return { results: [] };
    }
    
    try {
      const CHUNK_SIZE = 10;
      const valueChunks = [];
      
      for (let i = 0; i < values.length; i += CHUNK_SIZE) {
        valueChunks.push(values.slice(i, i + CHUNK_SIZE));
      }
      
      const allResults = [];
      
      for (const chunk of valueChunks) {
        const filterGroups = chunk.map(value => ({
          filters: [{ 
            propertyName: propertyName, 
            operator: 'EQ', 
            value: String(value) 
          }]
        }));
        
        const response = await this._makeRequest(
          'POST',
          '/crm/v3/objects/deals/search',
          {
            filterGroups,
            properties: [propertyName, 'dealname', 'dealstage', 'pipeline', 'id'],
            limit: chunk.length
          }
        );
        
        if (response.data.results) {
          allResults.push(...response.data.results);
        }
        
        if (valueChunks.length > 1) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
      
      return { results: allResults };
      
    } catch (error) {
      this.logger.error(`Batch search deals failed: ${error.message}`, {
        propertyName,
        values,
        status: error.response?.status,
        statusText: error.response?.statusText,
        hubspotError: error.response?.data,
        hubspotMessage: error.response?.data?.message,
        category: error.response?.data?.category,
        validationResults: error.response?.data?.validationResults
      });
      throw error;
    }
  }

  async createCompany({ properties }) {
    const cleanedProperties = {};
    for (const [key, value] of Object.entries(properties || {})) {
      if (value !== null && value !== undefined && value !== '') {
        cleanedProperties[key] = String(value);
      }
    }
    
    const response = await this._makeRequest('POST', '/crm/v3/objects/companies', { 
      properties: cleanedProperties 
    });
    return response.data;
  }

  async updateCompany({ companyId, properties }) {
    const cleanedProperties = {};
    for (const [key, value] of Object.entries(properties || {})) {
      if (value !== null && value !== undefined && value !== '') {
        cleanedProperties[key] = String(value);
      }
    }
    
    const response = await this._makeRequest('PATCH', `/crm/v3/objects/companies/${companyId}`, { 
      properties: cleanedProperties 
    });
    return response.data;
  }

  async createContact({ properties }) {
    const cleanedProperties = {};
    for (const [key, value] of Object.entries(properties || {})) {
      if (value !== null && value !== undefined && value !== '') {
        cleanedProperties[key] = String(value);
      }
    }
    
    const response = await this._makeRequest('POST', '/crm/v3/objects/contacts', { 
      properties: cleanedProperties 
    });
    return response.data;
  }

  async updateContact({ contactId, properties }) {
    const cleanedProperties = {};
    for (const [key, value] of Object.entries(properties || {})) {
      if (value !== null && value !== undefined && value !== '') {
        cleanedProperties[key] = String(value);
      }
    }
    
    const response = await this._makeRequest('PATCH', `/crm/v3/objects/contacts/${contactId}`, { 
      properties: cleanedProperties 
    });
    return response.data;
  }

  async createDeal({ properties, associations = [] }) {
    const cleanedProperties = {};
    for (const [key, value] of Object.entries(properties || {})) {
      if (value !== null && value !== undefined && value !== '') {
        cleanedProperties[key] = String(value);
      }
    }
    
    const payload = { properties: cleanedProperties };
    if (associations.length > 0) {
      payload.associations = associations;
    }
    
    const response = await this._makeRequest('POST', '/crm/v3/objects/deals', payload);
    return response.data;
  }

  async updateDeal({ dealId, properties }) {
    const cleanedProperties = {};
    for (const [key, value] of Object.entries(properties || {})) {
      if (value !== null && value !== undefined && value !== '') {
        cleanedProperties[key] = String(value);
      }
    }
    
    const response = await this._makeRequest('PATCH', `/crm/v3/objects/deals/${dealId}`, { 
      properties: cleanedProperties 
    });
    return response.data;
  }

  async createLineItem({ properties, associations = [] }) {
    const cleanedProperties = {};
    for (const [key, value] of Object.entries(properties || {})) {
      if (value !== null && value !== undefined && value !== '') {
        cleanedProperties[key] = String(value);
      }
    }
    
    const payload = { properties: cleanedProperties };
    if (associations.length > 0) {
      payload.associations = associations;
    }
    
    const response = await this._makeRequest('POST', '/crm/v3/objects/line_items', payload);
    return response.data;
  }

  async updateLineItem({ lineItemId, properties }) {
    const cleanedProperties = {};
    for (const [key, value] of Object.entries(properties || {})) {
      if (value !== null && value !== undefined && value !== '') {
        cleanedProperties[key] = String(value);
      }
    }
    
    const response = await this._makeRequest('PATCH', `/crm/v3/objects/line_items/${lineItemId}`, { 
      properties: cleanedProperties 
    });
    return response.data;
  }

  async searchCompanies({ body }) {
    const response = await this._makeRequest('POST', '/crm/v3/objects/companies/search', body);
    return response.data;
  }

  async searchContacts({ body }) {
    const response = await this._makeRequest('POST', '/crm/v3/objects/contacts/search', body);
    return response.data;
  }

  async searchDeals({ body }) {
    const response = await this._makeRequest('POST', '/crm/v3/objects/deals/search', body);
    return response.data;
  }

  async searchLineItems({ body }) {
    const response = await this._makeRequest('POST', '/crm/v3/objects/line_items/search', body);
    return response.data;
  }

  async createAssociation(fromObjectType, fromObjectId, toObjectType, toObjectId, associationTypeId) {
    return this._makeRequest(
      'PUT',
      `/crm/v4/objects/${fromObjectType}/${fromObjectId}/associations/${toObjectType}/${toObjectId}/${associationTypeId}`
    );
  }

  async getAssociationTypes(fromObjectType, toObjectType) {
    try {
      const response = await this._makeRequest(
        'GET',
        `/crm/v4/associations/${fromObjectType}/${toObjectType}/labels`
      );
      return response.data;
    } catch (error) {
      this.logger.warn(`Failed to get association types for ${fromObjectType} to ${toObjectType}: ${error.message}`);
      return null;
    }
  }

  async createAssociationV3(fromObjectType, fromObjectId, toObjectType, toObjectId, associationCategory) {
    // V3 API uses association categories instead of type IDs
    return this._makeRequest(
      'PUT',
      `/crm/v3/objects/${fromObjectType}/${fromObjectId}/associations/${toObjectType}/${toObjectId}/${associationCategory}`
    );
  }
}

async function hubspotAdapterPlugin(fastify, options) {
  const hubspotToken = fastify.config.HUBSPOT_ACCESS_TOKEN;

  if (!hubspotToken) {
    fastify.log.error('HubSpot access token not configured');
    fastify.decorate('hubspotAdapter', null);
    return;
  }

  try {
    const hubspotAdapter = new HubspotAdapter(
      fastify.httpClient, 
      fastify.config,
      fastify.log
    );
    
    fastify.log.info('Testing HubSpot connection...');
    await hubspotAdapter.searchCompanies({
      body: {
        filterGroups: [],
        properties: ['name'],
        limit: 1
      }
    });
    
    fastify.log.info('HubSpot adapter initialized successfully');
    fastify.decorate('hubspotAdapter', hubspotAdapter);
    
  } catch (error) {
    fastify.log.error(`Failed to initialize HubSpot adapter: ${error.message}`);
    fastify.decorate('hubspotAdapter', null);
  }
}

export default fp(hubspotAdapterPlugin, {
  name: 'hubspotAdapter',
  dependencies: ['httpClient', 'appConfig'],
});