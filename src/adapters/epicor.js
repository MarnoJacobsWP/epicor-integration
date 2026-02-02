import fp from 'fastify-plugin';

export default fp(
  async (fastify) => {
    class EpicorAdapter {
      constructor(httpClient, config) {
        this.client = httpClient;
        this.config = config;
        this.baseURL = config.BASE_URL;
        this.credentials = {
          username: config.API_USERNAME,
          password: config.API_PASSWORD
        };
        this.headers = {
          'Accept': 'application/json',
          'X-API-Key': config.API_KEY,
          'User-Agent': `Epicor-HubSpot-Integration/${process.env.NODE_ENV}`
        };
        
        this.constants = fastify.constants;
        this.PAGINATION = this.constants.PAGINATION;
        this.REQUEST_TIMEOUT = this.constants.REQUEST_TIMEOUT;
        this.FILTER_TIMESTAMP = this.constants.FILTER_TIMESTAMP;
        
        fastify.log.info('Epicor adapter initialized');
      }

      async _makeRequest(url, options = {}) {
        const maxRetries = this.constants?.MAX_RETRIES || 3;
        const baseDelayMs = 1000;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
          try {
            const startTime = Date.now();
            const response = await this.client.get(url, {
              headers: this.headers,
              auth: this.credentials,
              timeout: this.REQUEST_TIMEOUT,
              ...options
            });
            
            const duration = Date.now() - startTime;
            
            fastify.log.debug(`Epicor API request: ${url} - ${response.status} - ${duration}ms`);
            
            if (response.data) {
              return response;
            }

            fastify.log.warn(
              `Attempt ${attempt} returned no data. Retrying after ${baseDelayMs * attempt}ms…`
            );
          } catch (error) {
            const status = error.response?.status;
            const statusText = error.response?.statusText;
            
            fastify.log.warn(
              { err: error },
              `Epicor API attempt ${attempt} failed. Status: ${status} ${statusText}`
            );
            
            if (status === 429) {
              // Rate limited - exponential backoff
              const waitTime = Math.min(baseDelayMs * Math.pow(2, attempt), 30000);
              fastify.log.info(`Rate limited, waiting ${waitTime}ms before retry`);
              await new Promise((res) => setTimeout(res, waitTime));
            }
          }

          if (attempt < maxRetries) {
            await new Promise((res) => setTimeout(res, baseDelayMs * attempt));
          } else {
            throw new Error(`Failed after ${maxRetries} retries for URL: ${url}`);
          }
        }
      }

      async fetchAllRecords(queryName) {
        if (!queryName || typeof queryName !== 'string') {
          throw new Error('Invalid endpoint name provided');
        }

        const allRecords = [];
        let skip = this.PAGINATION.INITIAL_SKIP;
        const top = this.PAGINATION.TOP;
        let pagesFetched = 0;
        const startTime = Date.now();

        if (!this.baseURL || !this.credentials.username || !this.credentials.password || !this.headers['X-API-Key']) {
          throw new Error('Missing required Epicor API configuration');
        }

        while (true) {
          const url = `${this.baseURL}/${queryName}/Data?$top=${top}&$skip=${skip}`;

          try {
            const response = await this._makeRequest(url);
            const records = response.data.value || [];
            pagesFetched++;

            if (records.length === 0) {
              break;
            }

            allRecords.push(...records);

            if (records.length < top) {
              break;
            }

            skip += top;
          } catch (error) {
            fastify.log.error(`Error fetching ${queryName}:`, error.message);
            break;
          }
        }

        return {
          records: allRecords,
          metadata: {
            totalRecords: allRecords.length,
            pagesFetched,
            elapsedTimeMs: Date.now() - startTime,
          },
        };
      }

      async fetchLimitedRecords(queryName, maxRecords = 1000) {
        if (!queryName || typeof queryName !== 'string') {
          throw new Error('Invalid endpoint name provided');
        }

        const allRecords = [];
        let skip = this.PAGINATION.INITIAL_SKIP;
        const top = this.PAGINATION.TOP;
        let pagesFetched = 0;
        const startTime = Date.now();

        while (allRecords.length < maxRecords) {
          const url = `${this.baseURL}/${queryName}/Data?$top=${top}&$skip=${skip}`;

          try {
            const response = await this._makeRequest(url);
            const records = response.data.value || [];
            pagesFetched++;

            if (records.length === 0) {
              break;
            }

            allRecords.push(...records);

            if (records.length < top || allRecords.length >= maxRecords) {
              break;
            }

            skip += top;
          } catch (error) {
            fastify.log.error(`Error fetching ${queryName}:`, error.message);
            break;
          }
        }

        return {
          records: allRecords.slice(0, maxRecords),
          metadata: {
            totalRecords: allRecords.length,
            pagesFetched,
            elapsedTimeMs: Date.now() - startTime,
          },
        };
      }

      async fetchFilteredRecords(queryName, timestamp = this.FILTER_TIMESTAMP) {
        if (!queryName || typeof queryName !== 'string') {
          throw new Error('Invalid endpoint name provided');
        }

        const allRecords = [];
        let skip = this.PAGINATION.INITIAL_SKIP;
        const top = this.PAGINATION.TOP;
        let pagesFetched = 0;
        const startTime = Date.now();

        const odataFilter = `Calculated_Time gt ${timestamp}`;

        while (true) {
          const url = `${this.baseURL}/${queryName}/Data?$top=${top}&$skip=${skip}&$filter=${encodeURIComponent(odataFilter)}`;
          
          fastify.log.info(`Fetching filtered records from: ${url}`);

          try {
            const response = await this._makeRequest(url);
            const records = response.data.value || [];
            pagesFetched++;

            if (records.length === 0) {
              break;
            }

            allRecords.push(...records);

            if (records.length < top) {
              break;
            }

            skip += top;
          } catch (error) {
            fastify.log.error(`Error fetching filtered ${queryName}:`, {
              message: error.message,
              url
            });
            break;
          }
        }

        return {
          records: allRecords,
          metadata: {
            totalRecords: allRecords.length,
            pagesFetched,
            elapsedTimeMs: Date.now() - startTime,
          },
        };
      }

      async fetchRelatedRecords(queryName, filterField, filterValue) {
        if (!queryName || typeof queryName !== 'string') {
          throw new Error('Invalid endpoint name provided');
        }

        if (!filterField || !filterValue) {
          throw new Error('Filter field and value are required for related records');
        }

        const allRecords = [];
        let skip = this.PAGINATION.INITIAL_SKIP;
        const top = this.PAGINATION.TOP;
        let pagesFetched = 0;
        const startTime = Date.now();

        const odataFilter = `${filterField} eq ${filterValue}`;

        while (true) {
          const url = `${this.baseURL}/${queryName}/Data?$top=${top}&$skip=${skip}&$filter=${encodeURIComponent(odataFilter)}`;

          try {
            const response = await this._makeRequest(url);
            const records = response.data.value || [];
            pagesFetched++;

            if (records.length === 0) {
              break;
            }

            allRecords.push(...records);

            if (records.length < top) {
              break;
            }

            skip += top;
          } catch (error) {
            fastify.log.error(`Error fetching related ${queryName}:`, error.message);
            break;
          }
        }

        return {
          records: allRecords,
          metadata: {
            totalRecords: allRecords.length,
            pagesFetched,
            elapsedTimeMs: Date.now() - startTime,
          },
        };
      }
    }

    async function epicorAdapterPlugin(fastify, options) {
      const epicorAdapter = new EpicorAdapter(
        fastify.httpClient,
        fastify.config
      );

      fastify.decorate('epicorAdapter', epicorAdapter);
    }

    await epicorAdapterPlugin(fastify);
  },
  { 
    name: 'epicorAdapter',
    dependencies: ['httpClient', 'appConfig', 'constants'],
  },
);