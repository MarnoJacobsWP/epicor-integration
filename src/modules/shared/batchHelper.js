import fp from 'fastify-plugin';

const BATCH_SIZE = 100; // HubSpot batch limit

function chunkArray(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

async function batchHelper(fastify, _) {
  async function batchSearchByProperty(hubspotAdapter, objectType, propertyName, values, additionalProperties = []) {
    if (!values.length) return new Map();
    
    const valueChunks = chunkArray(values, BATCH_SIZE);
    const valueToObjectMap = new Map();
    
    for (const valueChunk of valueChunks) {
      const filterGroups = valueChunk.map(value => ({
        filters: [{ propertyName, operator: 'EQ', value: String(value) }]
      }));
      
      let searchMethod;
      let searchBody;
      
      switch (objectType) {
        case 'contacts':
          searchMethod = hubspotAdapter.searchContacts;
          searchBody = {
            body: {
              filterGroups,
              limit: valueChunk.length,
              properties: [propertyName, 'id', ...additionalProperties],
            },
          };
          break;
        case 'companies':
          searchMethod = hubspotAdapter.searchCompanies;
          searchBody = {
            body: {
              filterGroups,
              limit: valueChunk.length,
              properties: [propertyName, 'id', ...additionalProperties],
            },
          };
          break;
        case 'deals':
          searchMethod = hubspotAdapter.searchDeals;
          searchBody = {
            body: {
              filterGroups,
              limit: valueChunk.length,
              properties: [propertyName, 'id', ...additionalProperties],
            },
          };
          break;
        case 'line_items':
          searchMethod = hubspotAdapter.searchLineItems;
          searchBody = {
            body: {
              filterGroups,
              limit: valueChunk.length,
              properties: [propertyName, 'id', ...additionalProperties],
            },
          };
          break;
        default:
          throw new Error(`Unsupported object type: ${objectType}`);
      }
      
      const { results } = await fastify.backoff(() => searchMethod(searchBody));
      
      if (results) {
        results.forEach(obj => {
          const value = obj.properties?.[propertyName];
          if (value) {
            valueToObjectMap.set(value, {
              id: obj.id,
              properties: obj.properties
            });
          }
        });
      }
    }
    
    return valueToObjectMap;
  }

  async function batchCreateObjects(hubspotAdapter, objectType, objectsData) {
    if (!objectsData.length) return [];
    
    const chunks = chunkArray(objectsData, BATCH_SIZE);
    const createdObjects = [];
    
    for (const chunk of chunks) {
      let batchMethod;
      
      switch (objectType) {
        case 'contacts':
          batchMethod = hubspotAdapter.batchCreateContacts;
          break;
        case 'companies':
          batchMethod = hubspotAdapter.batchCreateCompanies;
          break;
        case 'deals':
          batchMethod = hubspotAdapter.batchCreateDeals;
          break;
        case 'line_items':
          batchMethod = hubspotAdapter.batchCreateLineItems;
          break;
        default:
          throw new Error(`Unsupported object type: ${objectType}`);
      }
      
      const batchInputs = chunk.map(props => ({ properties: props }));
      
      try {
        const result = await fastify.backoff(() => batchMethod(batchInputs));
        
        if (result.status === 'COMPLETE' && result.results) {
          createdObjects.push(...result.results);
        }
      } catch (error) {
        fastify.log.error(`Batch create ${objectType} failed: ${error.message}`);
        createdObjects.push(...chunk.map((_, index) => ({ 
          index, 
          chunk, 
          error: error.message 
        })));
      }
    }
    
    return createdObjects;
  }

  async function batchUpdateObjects(hubspotAdapter, objectType, updateData) {
    if (!updateData.length) return [];
    
    const chunks = chunkArray(updateData, BATCH_SIZE);
    const updatedObjects = [];
    
    for (const chunk of chunks) {
      let batchMethod;
      
      switch (objectType) {
        case 'contacts':
          batchMethod = hubspotAdapter.batchUpdateContacts;
          break;
        case 'companies':
          batchMethod = hubspotAdapter.batchUpdateCompanies;
          break;
        case 'deals':
          batchMethod = hubspotAdapter.batchUpdateDeals;
          break;
        case 'line_items':
          batchMethod = hubspotAdapter.batchUpdateLineItems;
          break;
        default:
          throw new Error(`Unsupported object type: ${objectType}`);
      }
      
      const batchInputs = chunk.map(({ id, properties }) => ({ 
        id, 
        properties 
      }));
      
      try {
        const result = await fastify.backoff(() => batchMethod(batchInputs));
        
        if (result.status === 'COMPLETE' && result.results) {
          updatedObjects.push(...result.results);
        }
      } catch (error) {
        fastify.log.error(`Batch update ${objectType} failed: ${error.message}`);
        updatedObjects.push(...chunk.map((data, index) => ({ 
          index, 
          data, 
          error: error.message 
        })));
      }
    }
    
    return updatedObjects;
  }

  fastify.decorate('batchHelper', {
    chunkArray,
    batchSearchByProperty,
    batchCreateObjects,
    batchUpdateObjects,
    BATCH_SIZE
  });
}

export default fp(batchHelper, {
  name: 'batchHelper',
  dependencies: ['hubspotAdapter', 'backoff']
});
