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

async function lineItemRepository(fastify) {
  const collection = fastify.mongo.db.collection('line_items');

  if (!fastify.hasDecorator('lineItemRepository')) {
    fastify.decorate('lineItemRepository', {
      findByIdProperty: (idProperty) => findByIdProperty(collection, idProperty),
      findByQuery: (query) => findByQuery(collection, query),
      updateDatabase: (filter, data) => updateDatabase(collection, filter, data),
      insertDatabase: (data) => insertDatabase(collection, data),
      deleteDatabase: (filter) => deleteDatabase(collection, filter),
    });
  }
}

export default fp(lineItemRepository, {
  name: 'lineItemRepository',
  dependencies: ['mongo'],
});