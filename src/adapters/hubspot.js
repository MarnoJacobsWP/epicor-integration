import fp from 'fastify-plugin';

const DEFAULT_TIMEOUT_MS = 30000;
const MAX_PROPERTY_LENGTH = 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;

const normalizeString = (value, maxLength = MAX_PROPERTY_LENGTH) => {
  if (value === null || value === undefined || value === '') return null;
  let str = String(value);
  str = str.replaceAll('\u0000', '');
  str = str.replaceAll(/[^\x20-\x7E\u00A0-\u00FF]/g, '?');
  return str.substring(0, maxLength);
};

const normalizeProperties = (properties, maxLength = MAX_PROPERTY_LENGTH) => {
  const cleaned = {};
  if (!properties || typeof properties !== 'object') return cleaned;

  for (const [key, value] of Object.entries(properties)) {
    const normalized = normalizeString(value, maxLength);
    if (normalized !== null && normalized !== undefined && normalized !== '') {
      cleaned[key] = normalized;
    }
  }

  return cleaned;
};

const isRetryableStatus = (status) => status === 429 || (status >= 500 && status <= 599);

const computeRetryDelay = (attempt, retryAfterMs, baseDelayMs = 1000, maxDelayMs = 30000) => {
  if (retryAfterMs) return Math.min(retryAfterMs, maxDelayMs);
  const exponential = baseDelayMs * Math.pow(2, attempt - 1);
  const jitter = Math.floor(Math.random() * 100);
  return Math.min(exponential + jitter, maxDelayMs);
};

const safeStringify = (value, maxLength = 4000) => {
  if (value === undefined) return undefined;
  try {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    if (text.length <= maxLength) return text;
    return `${text.slice(0, maxLength)}...`;
  } catch (error) {
    return `[unserializable: ${error?.message || 'unknown error'}]`;
  }
};

const extractHubspotErrorDetails = (responseData) => {
  if (!responseData || typeof responseData !== 'object') {
    return { errorMessage: undefined, errorDetails: undefined };
  }

  const errorMessage = responseData.message || responseData.error || responseData.status || undefined;
  const errorDetails = Array.isArray(responseData.errors)
    ? responseData.errors.map((item) => item?.message || item?.reason || safeStringify(item)).filter(Boolean)
    : undefined;

  return { errorMessage, errorDetails };
};

const normalizeAssociations = (associations = []) => {
  if (!Array.isArray(associations) || associations.length === 0) return [];

  const normalized = [];
  for (const association of associations) {
    if (!association?.to?.id) continue;
    const types = Array.isArray(association.types)
      ? association.types.filter((t) => t?.associationTypeId != null)
      : [];
    if (!types.length) continue;
    normalized.push({ ...association, types });
  }

  return normalized;
};

class HubspotAdapter {
  constructor(httpClient, config, logger, constants) {
    this.client = httpClient;
    this.baseURL = 'https://api.hubapi.com';
    this.token = config.HUBSPOT_ACCESS_TOKEN;
    this.logger = logger;
    this.maxRetries = constants?.MAX_RETRIES || 3;
    this.requestTimeout = constants?.REQUEST_TIMEOUT || DEFAULT_TIMEOUT_MS;
    this.minRequestIntervalMs = Number(config?.HUBSPOT_MIN_REQUEST_INTERVAL_MS || 125);
    this.requestQueue = null;
    this.nextRequestAt = 0;
    this.propertyOptionsCache = new Map();
    
    if (!this.token) {
      this.logger.warn('HubSpot access token is empty');
    }
  }

  async _scheduleRequest(fn) {
    const run = async () => {
      const now = Date.now();
      const waitMs = Math.max(0, this.nextRequestAt - now);
      if (waitMs > 0) {
        await sleep(waitMs);
      }

      this.nextRequestAt = Date.now() + this.minRequestIntervalMs;
      return await fn();
    };

    const queue = this.requestQueue || Promise.resolve();
    const scheduled = queue.then(run, run);
    this.requestQueue = scheduled.then(() => undefined, () => undefined);
    return await scheduled;
  }

  async _makeRequest(method, url, data = null, options = {}) {
    if (!isNonEmptyString(method) || !isNonEmptyString(url)) {
      throw new Error('HubSpot request requires a valid method and URL');
    }

    const config = {
      method,
      url: `${this.baseURL}${url}`,
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      timeout: this.requestTimeout,
      ...options,
    };

    if (data !== null && data !== undefined) {
      config.data = data;
    }

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        const response = await this._scheduleRequest(() => this.client(config));
        if (method.toUpperCase() !== 'DELETE' && !response?.data) {
          throw new Error('HubSpot response missing data');
        }
        return response;
      } catch (error) {
        const status = error?.response?.status;
        const statusText = error?.response?.statusText || '';
        const correlationId = error?.response?.headers?.['x-hubspot-correlation-id'];
        const retryAfterHeader = error?.response?.headers?.['retry-after'];
        const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : undefined;

        if (!isRetryableStatus(status) || attempt >= this.maxRetries) {
          const responseBody = safeStringify(error?.response?.data);
          const { errorMessage, errorDetails } = extractHubspotErrorDetails(error?.response?.data);
          const messageSuffix = errorMessage ? ` - ${errorMessage}` : '';
          const message = `HubSpot request failed: ${method.toUpperCase()} ${url} - ${status || 'unknown'} ${statusText}${messageSuffix}`;
          const correlationSuffix = correlationId ? ` (correlationId: ${correlationId})` : '';
          const requestBody = safeStringify(config?.data);
          this.logger.error(
            {
              status,
              statusText,
              correlationId,
              responseBody,
              errorMessage,
              errorDetails,
              requestBody,
            },
            `${message}${correlationSuffix}`,
          );
          const wrappedError = new Error(message, { cause: error });
          wrappedError.response = error?.response;
          wrappedError.status = status;
          throw wrappedError;
        }

        const delayMs = computeRetryDelay(attempt, retryAfterMs);
        this.logger.warn(
          `HubSpot request retry ${attempt} for ${method.toUpperCase()} ${url} in ${delayMs}ms (status ${status})`,
        );
        await sleep(delayMs);
      }
    }

    throw new Error(`HubSpot request failed after ${this.maxRetries} retries.`);
  }

  async getPropertyOptions(objectType, propertyName) {
    if (!isNonEmptyString(objectType) || !isNonEmptyString(propertyName)) {
      throw new Error('getPropertyOptions requires objectType and propertyName');
    }

    const cacheKey = `${objectType}:${propertyName}`;
    const cached = this.propertyOptionsCache.get(cacheKey);
    const now = Date.now();
    if (cached && now - cached.fetchedAt < 5 * 60 * 1000) {
      return cached.options;
    }

    const response = await this._makeRequest(
      'GET',
      `/crm/v3/properties/${objectType}/${propertyName}`,
    );

    const options = Array.isArray(response?.data?.options)
      ? response.data.options
        .map((option) => option?.value)
        .filter((value) => isNonEmptyString(value))
      : [];

    this.propertyOptionsCache.set(cacheKey, { fetchedAt: now, options });
    return options;
  }

  async batchUpsertCompanies(batchData, idProperty = 'customer_custid_') {
    if (!Array.isArray(batchData)) {
      throw new TypeError('batchUpsertCompanies requires an array of records');
    }
    if (!isNonEmptyString(idProperty)) {
      throw new Error('batchUpsertCompanies requires a valid idProperty');
    }

    this.logger.info(`Batch upsert: ${batchData.length} companies, idProperty: ${idProperty}`);

    const inputs = batchData.map((item, index) => {
      if (!item?.id) {
        throw new Error(`Item ${index}: Missing id field`);
      }
      if (!item.properties || typeof item.properties !== 'object') {
        throw new Error(`Item ${index}: Invalid properties`);
      }

      const properties = { ...item.properties };
      const uniquePropertyValue = properties[idProperty] || String(item.id);
      properties[idProperty] = uniquePropertyValue;

      return {
        id: String(item.id),
        properties: normalizeProperties(properties),
        idProperty: idProperty,
      };
    });

    const response = await this._makeRequest(
      'POST',
      '/crm/v3/objects/companies/batch/upsert',
      { inputs },
    );

    const result = response.data;

    if (result?.status === 'COMPLETE') {
      const created = result.results?.filter((r) => r.new)?.length || 0;
      const updated = result.results?.filter((r) => !r.new)?.length || 0;
      this.logger.info(`Batch completed: Created ${created}, Updated ${updated}, Errors: ${result.numErrors || 0}`);
    } else {
      this.logger.warn(`Batch status: ${result?.status || 'unknown'}`);
    }

    return result;
  }

  async batchUpsertContacts(batchData, idProperty = 'email') {
    if (!Array.isArray(batchData)) {
      throw new TypeError('batchUpsertContacts requires an array of records');
    }
    if (!isNonEmptyString(idProperty)) {
      throw new Error('batchUpsertContacts requires a valid idProperty');
    }

    this.logger.info(`Batch upsert: ${batchData.length} contacts, idProperty: ${idProperty}`);

    const inputs = batchData.map((item, index) => {
      if (!item?.id) {
        throw new Error(`Item ${index}: Missing id field`);
      }
      if (!item.properties || typeof item.properties !== 'object') {
        throw new Error(`Item ${index}: Invalid properties`);
      }

      const properties = { ...item.properties };
      const uniquePropertyValue = properties[idProperty] || String(item.id);
      properties[idProperty] = uniquePropertyValue;

      return {
        id: String(item.id),
        properties: normalizeProperties(properties),
        idProperty: idProperty,
      };
    });

    const response = await this._makeRequest(
      'POST',
      '/crm/v3/objects/contacts/batch/upsert',
      { inputs },
    );

    const result = response.data;

    if (result?.status === 'COMPLETE') {
      const created = result.results?.filter((r) => r.new)?.length || 0;
      const updated = result.results?.filter((r) => !r.new)?.length || 0;
      this.logger.info(`Contacts batch completed: Created ${created}, Updated ${updated}, Errors: ${result.numErrors || 0}`);
    } else {
      this.logger.warn(`Contacts batch status: ${result?.status || 'unknown'}`);
    }

    return result;
  }

  async batchUpsertDeals(batchData, idProperty = 'orderhed_ordernum') {
    if (!Array.isArray(batchData)) {
      throw new TypeError('batchUpsertDeals requires an array of records');
    }
    if (!isNonEmptyString(idProperty)) {
      throw new Error('batchUpsertDeals requires a valid idProperty');
    }

    this.logger.info(`Batch upsert: ${batchData.length} deals, idProperty: ${idProperty}`);

    const inputs = batchData.map((item, index) => {
      if (!item?.id) {
        throw new Error(`Item ${index}: Missing id field`);
      }
      if (!item.properties || typeof item.properties !== 'object') {
        throw new Error(`Item ${index}: Invalid properties`);
      }

      const properties = { ...item.properties };
      const uniquePropertyValue = properties[idProperty] || String(item.id);
      properties[idProperty] = uniquePropertyValue;

      return {
        id: String(item.id),
        properties: normalizeProperties(properties),
        idProperty: idProperty,
      };
    });

    const response = await this._makeRequest(
      'POST',
      '/crm/v3/objects/deals/batch/upsert',
      { inputs },
    );

    const result = response.data;

    if (result?.status === 'COMPLETE') {
      const created = result.results?.filter((r) => r.new)?.length || 0;
      const updated = result.results?.filter((r) => !r.new)?.length || 0;
      this.logger.info(`Deals batch completed: Created ${created}, Updated ${updated}, Errors: ${result.numErrors || 0}`);
    } else {
      this.logger.warn(`Deals batch status: ${result?.status || 'unknown'}`);
    }

    return result;
  }

  async batchUpsertLineItems(batchData, idProperty = 'rowident_') {
    if (!Array.isArray(batchData)) {
      throw new TypeError('batchUpsertLineItems requires an array of records');
    }
    if (!isNonEmptyString(idProperty)) {
      throw new Error('batchUpsertLineItems requires a valid idProperty');
    }

    this.logger.info(`Batch upsert: ${batchData.length} line items, idProperty: ${idProperty}`);

    const inputs = batchData.map((item, index) => {
      if (!item?.id) {
        throw new Error(`Item ${index}: Missing id field`);
      }
      if (!item.properties || typeof item.properties !== 'object') {
        throw new Error(`Item ${index}: Invalid properties`);
      }

      const properties = { ...item.properties };
      const uniquePropertyValue = properties[idProperty] || String(item.id);
      properties[idProperty] = uniquePropertyValue;

      return {
        id: String(item.id),
        properties: normalizeProperties(properties),
        idProperty: idProperty,
      };
    });

    const response = await this._makeRequest(
      'POST',
      '/crm/v3/objects/line_items/batch/upsert',
      { inputs },
    );

    const result = response.data;

    if (result?.status === 'COMPLETE') {
      const created = result.results?.filter((r) => r.new)?.length || 0;
      const updated = result.results?.filter((r) => !r.new)?.length || 0;
      this.logger.info(`Line items batch completed: Created ${created}, Updated ${updated}, Errors: ${result.numErrors || 0}`);
    } else {
      this.logger.warn(`Line items batch status: ${result?.status || 'unknown'}`);
    }

    return result;
  }

  async searchCompaniesByProperty(propertyName, values) {
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
          '/crm/v3/objects/companies/search',
          {
            filterGroups,
            properties: [propertyName, 'name', 'id'],
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
        
        const requestBody = {
          filterGroups,
          properties: [propertyName, 'dealname', 'dealstage', 'pipeline', 'id'],
          limit: chunk.length
        };
        
        const response = await this._makeRequest(
          'POST',
          '/crm/v3/objects/deals/search',
          requestBody
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
      this.logger.error(`Batch search deals failed for ${propertyName}: ${error.message}`);
      throw error;
    }
  }

  async getDealById({ dealId, properties = [] }) {
    const params = new URLSearchParams();
    if (properties.length) {
      params.set('properties', properties.join(','));
    }

    const queryString = params.toString();
    const path = queryString ? `/crm/v3/objects/deals/${dealId}?${queryString}` : `/crm/v3/objects/deals/${dealId}`;
    const response = await this._makeRequest('GET', path);
    return response.data;
  }

  async createCompany({ properties }) {
    const response = await this._makeRequest('POST', '/crm/v3/objects/companies', {
      properties: normalizeProperties(properties),
    });
    return response.data;
  }

  async updateCompany({ companyId, properties }) {
    const response = await this._makeRequest('PATCH', `/crm/v3/objects/companies/${companyId}`, {
      properties: normalizeProperties(properties),
    });
    return response.data;
  }

  async createContact({ properties }) {
    const response = await this._makeRequest('POST', '/crm/v3/objects/contacts', {
      properties: normalizeProperties(properties),
    });
    return response.data;
  }

  async updateContact({ contactId, properties }) {
    const response = await this._makeRequest('PATCH', `/crm/v3/objects/contacts/${contactId}`, {
      properties: normalizeProperties(properties),
    });
    return response.data;
  }

  async createDeal({ properties, associations = [] }) {
    const payload = { properties: normalizeProperties(properties) };
    const normalizedAssociations = normalizeAssociations(associations);
    if (normalizedAssociations.length > 0) {
      payload.associations = normalizedAssociations;
    }
    const response = await this._makeRequest('POST', '/crm/v3/objects/deals', payload);
    return response.data;
  }

  async updateDeal({ dealId, properties }) {
    const response = await this._makeRequest('PATCH', `/crm/v3/objects/deals/${dealId}`, {
      properties: normalizeProperties(properties),
    });
    return response.data;
  }

  async createLineItem({ properties, associations = [] }) {
    const payload = { properties: normalizeProperties(properties) };
    const normalizedAssociations = normalizeAssociations(associations);
    if (normalizedAssociations.length > 0) {
      payload.associations = normalizedAssociations;
    }
    const response = await this._makeRequest('POST', '/crm/v3/objects/line_items', payload);
    return response.data;
  }

  async updateLineItem({ lineItemId, properties }) {
    const response = await this._makeRequest('PATCH', `/crm/v3/objects/line_items/${lineItemId}`, {
      properties: normalizeProperties(properties),
    });
    return response.data;
  }

  async deleteLineItem(lineItemId) {
    await this._makeRequest('DELETE', `/crm/v3/objects/line_items/${lineItemId}`);
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

  async getLineItemsForDeal(dealId, properties = []) {
    const allLineItems = [];
    let after;

    do {
      const assocData = await this.getAssociations('deals', dealId, 'line_items', { limit: 500, after });
      const lineItemIds = (assocData?.results || []).map(r => r.toObjectId || r.id).filter(Boolean);

      for (const lineItemId of lineItemIds) {
        try {
          const params = new URLSearchParams();
          if (properties.length) params.set('properties', properties.join(','));
          const queryString = params.toString();
          const path = queryString
            ? `/crm/v3/objects/line_items/${lineItemId}?${queryString}`
            : `/crm/v3/objects/line_items/${lineItemId}`;

          const response = await this._makeRequest('GET', path);
          if (response.data) allLineItems.push(response.data);
        } catch (error) {
          const is404 = error.message?.includes('404') || error.statusCode === 404;
          if (is404) {
            this.logger.info(`Line item ${lineItemId} for deal ${dealId} no longer exists (stale association), skipping`);
          } else {
            this.logger.warn(`Failed to fetch line item ${lineItemId} for deal ${dealId}: ${error.message}`);
          }
        }
      }

      after = assocData?.paging?.next?.after;
    } while (after);

    return allLineItems;
  }

  async getAssociations(fromObjectType, fromObjectId, toObjectType, options = {}) {
    try {
      const params = new URLSearchParams();
      if (options.limit) params.set('limit', String(options.limit));
      if (options.after) params.set('after', String(options.after));

      const queryString = params.toString();
      const path = queryString
        ? `/crm/v4/objects/${fromObjectType}/${fromObjectId}/associations/${toObjectType}?${queryString}`
        : `/crm/v4/objects/${fromObjectType}/${fromObjectId}/associations/${toObjectType}`;

      const response = await this._makeRequest(
        'GET',
        path
      );
      return response.data;
    } catch (error) {
      this.logger.warn(`Failed to get associations for ${fromObjectType} ${fromObjectId} to ${toObjectType}: ${error.message}`);
      return { results: [] };
    }
  }

  async createAssociation(fromObjectType, fromObjectId, toObjectType, toObjectId, associationTypeId) {
    if (associationTypeId == null) {
      throw new Error(`associationTypeId is required to associate ${fromObjectType} to ${toObjectType}`);
    }
    const body = [
      {
        associationCategory: 'HUBSPOT_DEFINED',
        associationTypeId: associationTypeId
      }
    ];
    return this._makeRequest(
      'PUT',
      `/crm/v4/objects/${fromObjectType}/${fromObjectId}/associations/${toObjectType}/${toObjectId}`,
      body
    );
  }

  async ensureAssociation(fromObjectType, fromObjectId, toObjectType, toObjectId, associationTypeId) {
    try {
      const existsForward = await this._associationExists(fromObjectType, fromObjectId, toObjectType, toObjectId);
      if (existsForward) {
        return { skipped: true, direction: 'forward' };
      }

      const existsReverse = await this._associationExists(toObjectType, toObjectId, fromObjectType, fromObjectId);
      if (existsReverse) {
        return { skipped: true, direction: 'reverse' };
      }

      return await this.createAssociation(
        fromObjectType,
        fromObjectId,
        toObjectType,
        toObjectId,
        associationTypeId
      );
    } catch (error) {
      this.logger.warn(`Failed to ensure association ${fromObjectType} ${fromObjectId} -> ${toObjectType} ${toObjectId}: ${error.message}`);
      return { skipped: false, error };
    }
  }

  async _associationExists(fromObjectType, fromObjectId, toObjectType, toObjectId) {
    let after;
    do {
      const data = await this.getAssociations(fromObjectType, fromObjectId, toObjectType, { limit: 500, after });
      const exists = data?.results?.some(result => {
        const targetId = result?.toObjectId || result?.id;
        return String(targetId) === String(toObjectId);
      });
      if (exists) return true;
      after = data?.paging?.next?.after;
    } while (after);

    return false;
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

  async getObjectProperty(objectType, propertyName) {
    try {
      const response = await this._makeRequest(
        'GET',
        `/crm/v3/properties/${objectType}/${propertyName}`
      );
      return response.data;
    } catch (error) {
      this.logger.warn(`Failed to get property ${propertyName} for ${objectType}: ${error.message}`);
      return null;
    }
  }

  async createAssociationV3(fromObjectType, fromObjectId, toObjectType, toObjectId, associationCategory) {
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
      fastify.log,
      fastify.constants,
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
  dependencies: ['httpClient', 'appConfig', 'constants'],
});