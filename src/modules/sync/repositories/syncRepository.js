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
    });
  }
}

export default fp(syncRepository, {
  name: 'syncRepository',
  dependencies: ['mongo'],
});