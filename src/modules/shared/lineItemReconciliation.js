/**
 * Shared reconciliation logic for syncing Epicor line items to HubSpot.
 *
 * Compares desired (Epicor) line items against existing (HubSpot) line items
 * using multiset matching on name + normalized amount, and returns the minimal
 * set of create/delete operations to make HubSpot match Epicor exactly.
 */

/**
 * Normalizes a price/amount value to a fixed-precision string for comparison.
 * @param {*} value - Raw price or amount value
 * @returns {string} Normalized string representation
 */
function normalizeAmount(value) {
  if (value == null || value === '') return '';
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric.toFixed(4);
  return String(value).trim();
}

/**
 * Builds a composite key from a line item name and amount.
 * @param {string} name - Line item name
 * @param {*} amount - Line item price/amount
 * @returns {string} Composite match key
 */
function buildMatchKey(name, amount) {
  return `${String(name ?? '').trim()}||${normalizeAmount(amount)}`;
}

/**
 * Reconciles desired line items against existing HubSpot line items.
 *
 * Uses multiset matching to correctly handle duplicate name+amount pairs.
 * Returns the minimal set of operations needed to make HubSpot match Epicor.
 *
 * @param {Array<{name: string, price: *}>} desiredItems - Transformed Epicor items
 * @param {Array<{id: string, properties: {name: string, price: *}}>} existingItems - HubSpot line items
 * @returns {{ toCreate: Array, toDelete: Array, unchangedCount: number }}
 */
function reconcileLineItems(desiredItems, existingItems) {
  const existingByKey = new Map();
  for (const item of existingItems) {
    const props = item.properties || {};
    const key = buildMatchKey(props.name, props.price ?? props.amount);
    if (!existingByKey.has(key)) {
      existingByKey.set(key, []);
    }
    existingByKey.get(key).push(item);
  }

  const toCreate = [];
  const matchedIds = new Set();

  for (const desired of desiredItems) {
    const key = buildMatchKey(desired.name, desired.price);
    const candidates = existingByKey.get(key) || [];
    const match = candidates.find((c) => !matchedIds.has(c.id));

    if (match) {
      matchedIds.add(match.id);
    } else {
      toCreate.push(desired);
    }
  }

  const toDelete = existingItems.filter((item) => !matchedIds.has(item.id));

  return { toCreate, toDelete, unchangedCount: matchedIds.size };
}

export { normalizeAmount, buildMatchKey, reconcileLineItems };
