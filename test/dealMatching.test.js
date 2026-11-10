import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isDealReusableByName,
  pickReusableDealByName,
  protectClosedDeal,
  shouldRegeneratePdf,
  numberFromPdfName,
} from '../src/modules/shared/dealMatching.js';
import { STAGES } from './helpers/fakeFastify.js';

const deal = (props) => ({ id: '1', properties: props });

test('quote: deal without Quote Num or order is reusable', () => {
  assert.equal(isDealReusableByName(deal({}), { quoteNum: 172707 }), true);
});

test('quote: deal of another quote is not reusable (#172707 took #165233)', () => {
  assert.equal(isDealReusableByName(deal({ orderdtl_quotenum: '165233' }), { quoteNum: 172707 }), false);
});

test('quote: deal with a Sales Order Num is not reusable (#172706 took order 207987)', () => {
  assert.equal(
    isDealReusableByName(deal({ orderdtl_quotenum: '', orderhed_ordernum: '207987' }), { quoteNum: 172706 }),
    false,
  );
});

test('quote: deal already carrying the same Quote Num is reusable', () => {
  assert.equal(isDealReusableByName(deal({ orderdtl_quotenum: '172707' }), { quoteNum: '172707' }), true);
});

test('order: deal of its own quote is reusable, deal of another order is not', () => {
  assert.equal(isDealReusableByName(deal({ orderdtl_quotenum: '169693' }), { quoteNum: 169693, orderNum: 207987 }), true);
  assert.equal(isDealReusableByName(deal({ orderhed_ordernum: '111' }), { quoteNum: 169693, orderNum: 207987 }), false);
  assert.equal(isDealReusableByName(deal({ orderhed_ordernum: '0' }), { orderNum: 207987 }), true);
});

test('pickReusableDealByName skips taken deals and picks the first free one', () => {
  const taken = { id: 'a', properties: { orderdtl_quotenum: '1' } };
  const free = { id: 'b', properties: {} };
  const { deal: picked, rejected } = pickReusableDealByName([taken, free], { quoteNum: 2 });
  assert.equal(picked.id, 'b');
  assert.deepEqual(rejected.map((d) => d.id), ['a']);
  assert.equal(pickReusableDealByName([taken], { quoteNum: 2 }).deal, null);
});

test('closed won deal keeps stage and close date', () => {
  const props = { dealstage: STAGES.QUOTE_CREATED, closedate: '', task_conclusion: 'NEXT' };
  const { protectedStage } = protectClosedDeal(props, STAGES.CLOSED_WON, STAGES);
  assert.equal(protectedStage, true);
  assert.equal('dealstage' in props, false);
  assert.equal('closedate' in props, false);
  assert.equal(props.task_conclusion, 'NEXT');
});

test('closed won deal is not moved to closed lost by the quote sync', () => {
  const props = { dealstage: STAGES.CLOSED_LOST, closedate: '' };
  protectClosedDeal(props, STAGES.CLOSED_WON, STAGES);
  assert.equal('dealstage' in props, false);
});

test('closed lost deal can still move to closed won', () => {
  const props = { dealstage: STAGES.CLOSED_WON };
  const { protectedStage } = protectClosedDeal(props, STAGES.CLOSED_LOST, STAGES);
  assert.equal(protectedStage, false);
  assert.equal(props.dealstage, STAGES.CLOSED_WON);
});

test('open deal is not touched by the protection', () => {
  const props = { dealstage: STAGES.QUOTE_CREATED, closedate: '' };
  protectClosedDeal(props, STAGES.QUOTE_CREATED, STAGES);
  assert.deepEqual(props, { dealstage: STAGES.QUOTE_CREATED, closedate: '' });
});

test('PDF is regenerated only when needed', () => {
  assert.equal(shouldRegeneratePdf({ currentFileId: '', recordTime: 5, state: null }), true, 'no pdf on deal');
  assert.equal(shouldRegeneratePdf({ currentFileId: 'f1', recordTime: 5, state: null }), true, 'no state yet');
  assert.equal(shouldRegeneratePdf({ currentFileId: 'f1', recordTime: 5, state: { fileId: 'f2', recordTime: 5 } }), true, 'different file');
  assert.equal(shouldRegeneratePdf({ currentFileId: 'f1', recordTime: 6, state: { fileId: 'f1', recordTime: 5 } }), true, 'record changed');
  assert.equal(shouldRegeneratePdf({ currentFileId: 'f1', recordTime: 5, state: { fileId: 'f1', recordTime: 5 } }), false, 'unchanged');
});

test('numberFromPdfName reads quote and order file names', () => {
  assert.equal(numberFromPdfName('Quote-172707.pdf', 'quote'), '172707');
  assert.equal(numberFromPdfName('Quote-170240.pdf.pdf', 'quote'), '170240');
  assert.equal(numberFromPdfName('Sales Order-207987.pdf', 'order'), '207987');
  assert.equal(numberFromPdfName('random.pdf', 'quote'), null);
});
