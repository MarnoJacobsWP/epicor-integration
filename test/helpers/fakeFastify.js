import { constants } from '../../src/config/constants.js';

/**
 * Minimal in-memory stand-in for the Fastify instance the sync services use.
 * Every HubSpot / Epicor call is recorded in `calls` so tests can assert on it.
 */
export function createFakeFastify({ deals = [], files = {} } = {}) {
  const calls = [];
  const record = (name, args) => calls.push({ name, args });
  let nextDealId = 9000;
  let nextFileId = 7000;
  const pdfState = new Map();

  const matches = (deal, prop, value) => String(deal.properties?.[prop] ?? '') === String(value);

  const hubspotAdapter = {
    async searchDealsByProperty(prop, values, options = {}) {
      record('searchDealsByProperty', { prop, values, options });
      const limit = options.limit || values.length;
      return { results: deals.filter((d) => values.some((v) => matches(d, prop, v))).slice(0, limit) };
    },
    async getDealById({ dealId }) {
      record('getDealById', { dealId });
      return deals.find((d) => String(d.id) === String(dealId)) || { properties: {} };
    },
    async updateDeal({ dealId, properties }) {
      record('updateDeal', { dealId, properties: { ...properties } });
      const deal = deals.find((d) => String(d.id) === String(dealId));
      if (deal) Object.assign(deal.properties, properties);
      return { id: dealId };
    },
    async createDeal({ properties }) {
      const id = String(nextDealId++);
      record('createDeal', { id, properties: { ...properties } });
      deals.push({ id, properties: { ...properties } });
      return { id };
    },
    async getFileById(fileId) {
      record('getFileById', { fileId });
      return { path: files[fileId] || '' };
    },
    async uploadFile({ fileName }) {
      const id = String(nextFileId++);
      record('uploadFile', { id, fileName });
      files[id] = `/Quotes/${fileName}`;
      return { id, path: files[id] };
    },
    async deleteFile(fileId) { record('deleteFile', { fileId }); },
    async renameFile() {},
    async getLineItemsForDeal() { return []; },
    async deleteLineItem() {},
    async searchCompaniesByProperty() { return { results: [] }; },
    async ensureAssociation() { return { skipped: true }; },
    async getPropertyOptionsDetailed() { return []; },
  };

  const epicorAdapter = {
    async generateQuotePDF(n) { record('generateQuotePDF', { n }); return Buffer.from('%PDF-quote').toString('base64'); },
    async generateSalesOrderPDF(n) { record('generateSalesOrderPDF', { n }); return Buffer.from('%PDF-order').toString('base64'); },
  };

  const noopLineItems = {
    async syncLineItemsForQuote() {},
    async syncLineItemsForOrder() {},
    async purgeQuoteProdMixItems() { return { deleted: 0 }; },
  };

  const mongoCollection = {
    async findOne(q) { return pdfState.get(`${q.kind}:${q.num}`) || null; },
    async updateOne(q, { $set }) { pdfState.set(`${q.kind}:${q.num}`, { ...$set }); },
  };

  const log = { info() {}, warn() {}, error() {}, debug() {} };

  const fastify = {
    constants,
    config: { EPICOR_QUOTE_PDF_URL: 'x', EPICOR_SALES_ORDER_PDF_URL: 'x' },
    log,
    backoff: (fn) => fn(),
    hubspotAdapter,
    epicorAdapter,
    quoteProdMixService: noopLineItems,
    qSeatEtabService: noopLineItems,
    orderProdMixService: noopLineItems,
    mongo: { db: { collection: () => mongoCollection } },
    hasDecorator(name) { return name in this; },
    decorate(name, value) { this[name] = value; },
  };

  return { fastify, calls, deals, files, pdfState };
}

export const STAGES = constants.HUBSPOT_DEAL_STAGES;
