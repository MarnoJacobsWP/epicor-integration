/**
 * End-to-end scenarios for the quote and order sync against an in-memory
 * HubSpot. They reproduce the Oct 2026 incidents (#172707, #172706).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import quoteServices from '../src/modules/quotes/services/quoteServices.js';
import orderServices from '../src/modules/orders/services/orderServices.js';
import { createFakeFastify, STAGES } from './helpers/fakeFastify.js';

async function runQuotes(env, quotes) {
  await quoteServices(env.fastify, {});
  const results = { created: 0, updated: 0, errors: 0 };
  await env.fastify.quoteTask.processQuotesIndividually(quotes, results);
  return results;
}

async function runOrders(env, orders) {
  await orderServices(env.fastify, {});
  const results = { created: 0, updated: 0, errors: 0 };
  await env.fastify.orderTask.processOrdersIndividually(orders, results);
  return results;
}

const quote = (num, extra = {}) => ({
  QuoteHed_QuoteNum: num,
  QuoteHed_CustNum: 257,
  Customer_Name: 'Discount Office Solutions',
  QuoteHed_Character08: 'RBC',
  Task_Conclusion: 'NEXT',
  Calculated_Time: 1000,
  ...extra,
});

const updatesTo = (calls, dealId) => calls.filter((c) => c.name === 'updateDeal' && c.args.dealId === dealId);

test('#172707: a new quote no longer takes over a closed deal of another quote', async () => {
  const env = createFakeFastify({
    deals: [{
      id: '306975389370',
      properties: {
        dealname: 'RBC - Discount Office Solutions',
        orderdtl_quotenum: '165233',
        orderhed_ordernum: '200001',
        dealstage: STAGES.CLOSED_WON,
        closedate: '2026-01-19',
      },
    }],
  });

  const results = await runQuotes(env, [quote(172707)]);

  assert.equal(results.errors, 0);
  assert.equal(results.created, 1, 'a new deal is created for #172707');
  assert.equal(updatesTo(env.calls, '306975389370').length, 0, 'the #165233 deal is not touched');
  const old = env.deals.find((d) => d.id === '306975389370').properties;
  assert.equal(old.orderdtl_quotenum, '165233');
  assert.equal(old.dealstage, STAGES.CLOSED_WON);
  assert.equal(old.closedate, '2026-01-19');
  const created = env.calls.find((c) => c.name === 'createDeal');
  assert.equal(created.args.properties.orderdtl_quotenum, '172707');
});

test('#172706: a revision does not take over a deal that already has a Sales Order Num', async () => {
  const env = createFakeFastify({
    deals: [{
      id: '329982826217',
      properties: {
        dealname: 'SCHEVE FL 12- - M.O.I - VA',
        orderdtl_quotenum: '169693',
        orderhed_ordernum: '207987',
        dealstage: STAGES.CLOSED_WON,
      },
    }],
  });

  await runQuotes(env, [quote(172706, { Customer_Name: 'M.O.I - VA', QuoteHed_Character08: 'SCHEVE FL 12-' })]);

  assert.equal(updatesTo(env.calls, '329982826217').length, 0);
  assert.equal(env.calls.filter((c) => c.name === 'createDeal').length, 1);
});

test('a deal with the same name but no Quote Num is still reused (pre-integration deals)', async () => {
  const env = createFakeFastify({
    deals: [{ id: '500', properties: { dealname: 'RBC - Discount Office Solutions', dealstage: STAGES.QUOTE_CREATED } }],
  });

  const results = await runQuotes(env, [quote(172707)]);

  assert.equal(results.updated, 1);
  assert.equal(env.calls.filter((c) => c.name === 'createDeal').length, 0);
  assert.equal(env.deals[0].properties.orderdtl_quotenum, '172707');
});

test('the quote sync never reopens its own Closed Won deal', async () => {
  const env = createFakeFastify({
    deals: [{
      id: '600',
      properties: {
        dealname: 'RBC - Discount Office Solutions',
        orderdtl_quotenum: '169693',
        orderhed_ordernum: '207987',
        dealstage: STAGES.CLOSED_WON,
        closedate: '2026-09-03',
      },
    }],
  });

  await runQuotes(env, [quote(169693, { Task_Conclusion: 'NEXT' })]);

  const [update] = updatesTo(env.calls, '600');
  assert.ok(update, 'the deal is still updated with the quote fields');
  assert.equal('dealstage' in update.args.properties, false);
  assert.equal('closedate' in update.args.properties, false);
  assert.equal(env.deals[0].properties.dealstage, STAGES.CLOSED_WON);
  assert.equal(env.deals[0].properties.closedate, '2026-09-03');
});

test('quote PDF is uploaded once and not re-uploaded while the quote is unchanged', async () => {
  const env = createFakeFastify();

  await runQuotes(env, [quote(172707, { Calculated_Time: 1000 })]);
  await runQuotes(env, [quote(172707, { Calculated_Time: 1000 })]);
  await runQuotes(env, [quote(172707, { Calculated_Time: 1000 })]);
  assert.equal(env.calls.filter((c) => c.name === 'uploadFile').length, 1, 'three runs, one upload');

  await runQuotes(env, [quote(172707, { Calculated_Time: 2000 })]);
  assert.equal(env.calls.filter((c) => c.name === 'uploadFile').length, 2, 'quote changed: one more upload');
  const deletes = env.calls.filter((c) => c.name === 'deleteFile');
  assert.equal(deletes.length, 1, 'the superseded PDF of the same quote is deleted');
});

test('a previous PDF that belongs to another quote is never deleted', async () => {
  const env = createFakeFastify({
    deals: [{
      id: '700',
      properties: {
        dealname: 'RBC - Discount Office Solutions',
        orderdtl_quotenum: '172707',
        dealstage: STAGES.QUOTE_CREATED,
        quote_pdf: 'old-file',
      },
    }],
    files: { 'old-file': '/Quotes/Quote-165233.pdf' },
  });

  await runQuotes(env, [quote(172707)]);

  assert.equal(env.calls.filter((c) => c.name === 'uploadFile').length, 1);
  assert.equal(env.calls.filter((c) => c.name === 'deleteFile').length, 0);
});

test('an order does not take over a deal that belongs to another order by name', async () => {
  const env = createFakeFastify({
    deals: [{
      id: '800',
      properties: {
        dealname: 'RBC - Discount Office Solutions',
        orderdtl_quotenum: '165233',
        orderhed_ordernum: '200001',
        dealstage: STAGES.CLOSED_WON,
      },
    }],
  });

  const results = await runOrders(env, [{
    OrderHed_OrderNum: 210000,
    OrderDtl_QuoteNum: null,
    OrderHed_CustNum: 257,
    Customer_Name: 'Discount Office Solutions',
    OrderHed_Character08: 'RBC',
    Calculated_Time: 1000,
  }]);

  assert.equal(results.errors, 0);
  assert.equal(updatesTo(env.calls, '800').length, 0);
  assert.equal(env.calls.filter((c) => c.name === 'createDeal').length, 1);
});

test('an order does not take over its quote deal when that deal belongs to another order', async () => {
  const env = createFakeFastify({
    deals: [{
      id: '900',
      properties: {
        dealname: 'RBC - Discount Office Solutions',
        orderdtl_quotenum: '165233',
        orderhed_ordernum: '200001',
        dealstage: STAGES.CLOSED_WON,
      },
    }],
  });

  await runOrders(env, [{
    OrderHed_OrderNum: 200002,
    OrderDtl_QuoteNum: 165233,
    OrderHed_CustNum: 257,
    Customer_Name: 'Discount Office Solutions',
    OrderHed_Character08: 'RBC',
    Calculated_Time: 1000,
  }]);

  assert.equal(updatesTo(env.calls, '900').length, 0, 'order 200001 deal untouched');
  assert.equal(env.calls.filter((c) => c.name === 'createDeal').length, 1);
});

test('an order still takes over its own quote deal (normal quote -> order flow)', async () => {
  const env = createFakeFastify({
    deals: [{
      id: '950',
      properties: {
        dealname: 'SCHEVE FL 12- - M.O.I - VA',
        orderdtl_quotenum: '169693',
        dealstage: STAGES.QUOTE_CREATED,
      },
    }],
  });

  const results = await runOrders(env, [{
    OrderHed_OrderNum: 207987,
    OrderDtl_QuoteNum: 169693,
    OrderHed_CustNum: 1988,
    Customer_Name: 'M.O.I - VA',
    OrderHed_Character08: 'SCHEVE FL 12-',
    Calculated_Time: 1000,
  }]);

  assert.equal(results.updated, 1);
  assert.equal(env.calls.filter((c) => c.name === 'createDeal').length, 0);
  const deal = env.deals[0].properties;
  assert.equal(deal.orderhed_ordernum, '207987');
  assert.equal(deal.dealstage, STAGES.CLOSED_WON);
});
