/**
 * Chunks an array into smaller arrays of specified size
 * @param {Array} array - The array to chunk
 * @param {number} size - The size of each chunk
 * @returns {Array[]} Array of chunked arrays
 */
export function chunkArray(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

/**
 * Pads customer number to 4 digits with leading zeros
 * @param {string|number} value - The customer number to pad
 * @returns {string|null} Padded customer number or null if invalid
 */
export function padCustNum(value) {
  if (!value) return null;
  const str = String(value).trim();
  return str.padStart(4, '0');
}
