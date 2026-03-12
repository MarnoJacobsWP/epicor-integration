import fp from 'fastify-plugin';

async function findByIdProperty(collection, idProperty) {
  return collection.findOne(idProperty);
}

async function findByQuery(collection, query) {
  return collection.findOne(query);
}

async function updateDatabase(collection, filter, data) {
  return collection.updateOne(filter, {
    $set: { ...data, modifiedAt: new Date() },
  });
}

async function insertDatabase(collection, data) {
  return collection.insertOne({
    ...data,
    createdAt: new Date(),
    modifiedAt: new Date(),
  });
}

async function deleteDatabase(collection, filter) {
  return collection.deleteOne(filter);
}

async function findLastSync(collection, syncType) {
  return collection.findOne(
    { syncType },
    { sort: { createdAt: -1 } }
  );
}

/**
 * Retrieve the last-known sync cursor (Unix-seconds timestamp) for a given
 * sync type.  Returns `null` when no cursor has been stored yet.
 */
async function getSyncCursor(collection, syncType) {
  const doc = await collection.findOne(
    { _type: 'sync_cursor', syncType },
  );
  return doc?.timestamp ?? null;
}

/**
 * Persist a sync cursor so the next run knows where to pick up.
 * Uses upsert so the first call creates the document.
 *
 * @param {string}  syncType  e.g. 'contacts', 'customers', 'orders', 'quotes', 'full'
 * @param {number}  timestamp Unix-seconds value to store
 */
async function setSyncCursor(collection, syncType, timestamp) {
  return collection.updateOne(
    { _type: 'sync_cursor', syncType },
    {
      $set: {
        _type: 'sync_cursor',
        syncType,
        timestamp,
        updatedAt: new Date(),
      },
    },
    { upsert: true },
  );
}

async function syncRepository(fastify) {
  const collection = fastify.mongo.db.collection('sync_logs');

  if (!fastify.hasDecorator('syncRepository')) {
    fastify.decorate('syncRepository', {
      findByIdProperty: (idProperty) => findByIdProperty(collection, idProperty),
      findByQuery: (query) => findByQuery(collection, query),
      updateDatabase: (filter, data) => updateDatabase(collection, filter, data),
      insertDatabase: (data) => insertDatabase(collection, data),
      deleteDatabase: (filter) => deleteDatabase(collection, filter),
      findLastSync: (syncType) => findLastSync(collection, syncType),
      getSyncCursor: (syncType) => getSyncCursor(collection, syncType),
      setSyncCursor: (syncType, timestamp) => setSyncCursor(collection, syncType, timestamp),
    });
  }
}

export default fp(syncRepository, {
  name: 'syncRepository',
  dependencies: ['mongo'],
});