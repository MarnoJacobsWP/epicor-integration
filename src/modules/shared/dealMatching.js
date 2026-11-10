/**
 * Shared, side-effect-free rules for matching Epicor records to HubSpot deals
 * and for deciding what the sync is allowed to overwrite.
 *
 * Background (Oct 2026 incident, quotes #172707 and #172706): when a quote had
 * no deal with its own Quote Num, the sync reused ANY deal with the same name
 * ("Job - Customer"). That deal could already belong to another quote or to a
 * closed order, which got overwritten, reopened and lost its close date.
 */

/** Deal properties needed to evaluate the rules below. */
export const MATCH_PROPERTIES = ['orderdtl_quotenum', 'orderhed_ordernum', 'dealstage', 'closedate', 'quote_pdf'];

const hasValue = (v) => v != null && String(v).trim() !== '' && String(v).trim() !== '0';
const same = (a, b) => String(a ?? '').trim() === String(b ?? '').trim();

/**
 * Can a deal found ONLY by name be reused for this Epicor record?
 *
 * A deal is reusable when it does not already belong to a different quote or
 * order:
 *  - quote sync (orderNum empty): the deal must have no Quote Num (or the same
 *    one) and no Sales Order Num.
 *  - order sync: the deal must have no Sales Order Num (or the same one) and
 *    no Quote Num, or the order's own Quote Num.
 *
 * @param {{properties?: object}} deal
 * @param {{quoteNum?: *, orderNum?: *}} record
 * @returns {boolean}
 */
export function isDealReusableByName(deal, { quoteNum, orderNum } = {}) {
  const props = deal?.properties || {};
  const dealQuote = props.orderdtl_quotenum;
  const dealOrder = props.orderhed_ordernum;

  if (hasValue(dealOrder) && !(hasValue(orderNum) && same(dealOrder, orderNum))) return false;
  if (hasValue(dealQuote) && !(hasValue(quoteNum) && same(dealQuote, quoteNum))) return false;
  return true;
}

/**
 * From the deals returned by a name search, pick the first one that may be
 * reused. Returns null when every candidate belongs to another quote/order.
 *
 * @param {Array} deals
 * @param {{quoteNum?: *, orderNum?: *}} record
 * @returns {{deal: object|null, rejected: Array}}
 */
export function pickReusableDealByName(deals, record) {
  const rejected = [];
  for (const deal of deals || []) {
    if (isDealReusableByName(deal, record)) return { deal, rejected };
    rejected.push(deal);
  }
  return { deal: null, rejected };
}

/**
 * Quote sync must never reopen a closed deal. When the existing deal is Closed
 * Won or Closed Lost and the quote would move it to an open stage, the stage
 * and close date are dropped from the update. Moving a Closed Lost deal to
 * Closed Won is still allowed (a lost quote later won in Epicor).
 *
 * A Closed Won deal is never moved by the quote sync at all (it is an order).
 * The close date is never cleared on a closed deal.
 *
 * Mutates and returns `props`.
 *
 * @param {object} props - properties about to be sent to HubSpot
 * @param {string|undefined} existingStage - current dealstage of the deal
 * @param {{CLOSED_WON: string, CLOSED_LOST: string}} stages
 * @returns {{props: object, protectedStage: boolean}}
 */
export function protectClosedDeal(props, existingStage, stages) {
  const isClosed = existingStage === stages.CLOSED_WON || existingStage === stages.CLOSED_LOST;
  if (!isClosed) return { props, protectedStage: false };

  const target = props.dealstage;
  const allowed = existingStage === stages.CLOSED_LOST && target === stages.CLOSED_WON;
  let protectedStage = false;

  if (target !== undefined && target !== existingStage && !allowed) {
    delete props.dealstage;
    protectedStage = true;
  }
  if (props.closedate === '' || props.closedate === null) {
    delete props.closedate;
  }
  return { props, protectedStage };
}

/**
 * Should a PDF be (re)generated for this record?
 *
 * Regenerate when the deal has no PDF, when the PDF on the deal is not the one
 * we last uploaded for this record, or when the Epicor record changed since
 * that upload. Without this, every sync run inside the look-back window
 * re-uploaded the same PDF and deleted the previous copy.
 *
 * @param {{currentFileId?: *, recordTime?: number, state?: {fileId?: string, recordTime?: number}|null}} args
 * @returns {boolean}
 */
export function shouldRegeneratePdf({ currentFileId, recordTime, state }) {
  if (!hasValue(currentFileId)) return true;
  if (!state || !hasValue(state.fileId)) return true;
  if (!same(state.fileId, currentFileId)) return true;
  const t = Number(recordTime);
  const last = Number(state.recordTime);
  if (!Number.isFinite(t) || !Number.isFinite(last)) return true;
  return t > last;
}

/**
 * Number embedded in a stored PDF file name, e.g. "Quote-170240.pdf" -> "170240",
 * "Sales Order-207987.pdf" -> "207987". Null when it cannot be determined.
 *
 * @param {string} fileName
 * @param {'quote'|'order'} kind
 */
export function numberFromPdfName(fileName, kind) {
  const pattern = kind === 'order' ? /Sales[-\s]*Order-(\d+)/i : /Quote-(\d+)/i;
  const match = pattern.exec(String(fileName || ''));
  return match ? match[1] : null;
}
