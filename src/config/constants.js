import fp from 'fastify-plugin';

export const constants = {
  ENDPOINTS: {
    CONTACTS: '68138-HSCustCnt',
    CUSTOMERS: '68138-HSCustomers',
    ORDERS: '68138-HSOrder',
    ORDER_PROD_MIX: '68138-HSOrderProdMix',
    QSEAT_ETAB: '68138-HSQSeatEtab',
    QUOTES: '68138-HSQuote',
    QUOTE_PROD_MIX: '68138-HSQuoteProdMix',
  },
  HUBSPOT_OBJECTS: {
    CONTACTS: 'contacts',
    COMPANIES: 'companies',
    DEALS: 'deals',
    LINE_ITEMS: 'line_items',
  },
  HUBSPOT_PIPELINES: {
    QUOTES: 'default',
  },
  HUBSPOT_DEAL_STAGES: {
    QUOTE_CREATED: '2817003207',
    CLOSED_WON: 'closedwon',
  },
  PAGINATION: {
    TOP: process.env.NODE_ENV === 'production' ? 50000 : 100000,
    INITIAL_SKIP: 0,
  },
  REQUEST_TIMEOUT: process.env.NODE_ENV === 'production' ? 45000 : 30000,
  FILTER_TIMESTAMP: 1767225600,
  TABLE_RELATIONSHIPS: {
    ORDER_PROD_MIX: {
      parentTable: 'ORDERS',
      relatedField: 'OrderDtl_OrderNum',
      parentField: 'OrderHed_OrderNum',
    },
    QUOTE_PROD_MIX: {
      parentTable: 'QUOTES',
      relatedField: 'QuoteDtl_QuoteNum',
      parentField: 'QuoteHed_QuoteNum',
    },
    QSEAT_ETAB: {
      parentTable: 'QUOTES',
      relatedField: 'QuoteDtl_QuoteNum',
      parentField: 'QuoteHed_QuoteNum',
    },
  },
  PRIMARY_TABLES: ['ORDERS', 'QUOTES', 'CONTACTS', 'CUSTOMERS'],
  DEPENDENT_TABLES: ['ORDER_PROD_MIX', 'QUOTE_PROD_MIX', 'QSEAT_ETAB'],
  MAX_RETRIES: process.env.NODE_ENV === 'production' ? 5 : 3,
  SYNC_INTERVAL: 5 * 60 * 1000, // 5 minutes
  ERROR_CODES: {
    INVALID_ENDPOINT: 'INVALID_ENDPOINT',
    API_ERROR: 'API_ERROR',
    NETWORK_ERROR: 'NETWORK_ERROR',
    TIMEOUT_ERROR: 'TIMEOUT_ERROR',
    AUTH_ERROR: 'AUTH_ERROR',
    CONFIG_ERROR: 'CONFIG_ERROR',
    RATE_LIMIT_EXCEEDED: 'RATE_LIMIT_EXCEEDED',
    VALIDATION_ERROR: 'VALIDATION_ERROR',
  },
  BATCH_SIZES: {
    CONTACTS: process.env.NODE_ENV === 'production' ? 50 : 100,
    CUSTOMERS: process.env.NODE_ENV === 'production' ? 50 : 100,
    ORDERS: process.env.NODE_ENV === 'production' ? 50 : 100,
    QUOTES: process.env.NODE_ENV === 'production' ? 50 : 100,
    LINE_ITEMS: process.env.NODE_ENV === 'production' ? 50 : 100,
  },
};

export const {
  ENDPOINTS,
  HUBSPOT_OBJECTS,
  HUBSPOT_PIPELINES,
  HUBSPOT_DEAL_STAGES,
  PAGINATION,
  REQUEST_TIMEOUT,
  FILTER_TIMESTAMP,
  TABLE_RELATIONSHIPS,
  PRIMARY_TABLES,
  DEPENDENT_TABLES,
  MAX_RETRIES,
  SYNC_INTERVAL,
  ERROR_CODES,
  BATCH_SIZES
} = constants;

export default fp(
  async (fastify) => {
    fastify.decorate('constants', constants);
  },
  { name: 'constants' },
);