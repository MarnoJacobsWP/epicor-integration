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
 * @param {object} [options]
 * @param {(item: object) => string} [options.desiredKeyFn] - Custom key builder for desired items (default: name+price)
 * @param {(item: object) => string} [options.existingKeyFn] - Custom key builder for existing items (default: name+price)
 * @returns {{ toCreate: Array, toUpdate: Array<{existingId: string, properties: object}>, toDelete: Array, unchangedCount: number }}
 */
function reconcileLineItems(desiredItems, existingItems, options = {}) {
  const {
    desiredKeyFn = (item) => buildMatchKey(item.name, item.price),
    existingKeyFn = (item) => {
      const props = item.properties || {};
      return buildMatchKey(props.name, props.price ?? props.amount);
    },
  } = options;

  const existingByKey = new Map();
  for (const item of existingItems) {
    const key = existingKeyFn(item);
    if (!existingByKey.has(key)) {
      existingByKey.set(key, []);
    }
    existingByKey.get(key).push(item);
  }

  const toCreate = [];
  const toUpdate = [];
  const matchedIds = new Set();

  for (const desired of desiredItems) {
    const key = desiredKeyFn(desired);
    const candidates = existingByKey.get(key) || [];
    const match = candidates.find((c) => !matchedIds.has(c.id));

    if (match) {
      matchedIds.add(match.id);
      toUpdate.push({ existingId: match.id, properties: desired });
    } else {
      toCreate.push(desired);
    }
  }

  const toDelete = existingItems.filter((item) => !matchedIds.has(item.id));

  return { toCreate, toUpdate, toDelete, unchangedCount: matchedIds.size };
}

/**
 * Deduplicates an array of desired items by a key function.
 * Keeps the first occurrence for each unique key.
 *
 * @param {Array} items - Transformed desired items
 * @param {(item: object) => string} keyFn - Builds a dedup key for each item
 * @returns {Array} Items with duplicates removed
 */
function deduplicateDesiredItems(items, keyFn) {
  const seen = new Set();
  const unique = [];
  for (const item of items) {
    const key = keyFn(item);
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(item);
    }
  }
  return unique;
}

/**
 * Scans all line items on a deal and identifies cross-source duplicates.
 *
 * Duplicate detection strategy:
 *  - QSeatEtab items (hs_sku present): keyed by name + hs_sku
 *  - ProdMix items (no hs_sku, price present): keyed by name + price
 *
 * For each key group with more than one item, all items after the first
 * are returned for deletion.
 *
 * @param {Array<{id: string, properties: object}>} lineItems - All line items on a deal
 * @returns {Array<{id: string}>} Line items that should be deleted as duplicates
 */
function findDuplicatesOnDeal(lineItems) {
  const groups = new Map();

  for (const item of lineItems) {
    const props = item.properties || {};
    const hsSku = props.hs_sku;
    const hasSku = hsSku != null && String(hsSku).trim() !== '';
    const key = hasSku
      ? `sku::${buildMatchKey(props.name, hsSku)}`
      : `price::${buildMatchKey(props.name, props.price ?? props.amount)}`;

    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(item);
  }

  const duplicates = [];
  for (const items of groups.values()) {
    if (items.length > 1) {
      // Keep the first, mark the rest for deletion
      for (let i = 1; i < items.length; i++) {
        duplicates.push(items[i]);
      }
    }
  }

  return duplicates;
}

export { normalizeAmount, buildMatchKey, reconcileLineItems, deduplicateDesiredItems, findDuplicatesOnDeal };
