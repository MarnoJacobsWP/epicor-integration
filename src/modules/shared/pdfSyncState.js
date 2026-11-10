/**
 * Remembers, per quote / sales order, which PDF file the sync last uploaded and
 * the Epicor Calculated_Time of the record it was generated from. Used to skip
 * re-uploading an unchanged PDF on every sync run.
 *
 * Stored in MongoDB collection `pdf_sync_state`. Every call is best-effort:
 * if Mongo is unavailable the sync behaves as before (regenerates the PDF).
 */

const COLLECTION = 'pdf_sync_state';

function collection(fastify) {
  return fastify?.mongo?.db?.collection(COLLECTION) || null;
}

/**
 * @param {object} fastify
 * @param {'quote'|'order'} kind
 * @param {string|number} num
 * @returns {Promise<{fileId?: string, recordTime?: number}|null>}
 */
export async function getPdfState(fastify, kind, num) {
  try {
    const col = collection(fastify);
    if (!col) return null;
    return await col.findOne({ kind, num: String(num) }, { maxTimeMS: 2000 });
  } catch (error) {
    fastify?.log?.warn(`pdf_sync_state read failed for ${kind} ${num}: ${error.message}`);
    return null;
  }
}

/**
 * @param {object} fastify
 * @param {'quote'|'order'} kind
 * @param {string|number} num
 * @param {{fileId: string, recordTime?: number, dealId?: string}} state
 */
export async function setPdfState(fastify, kind, num, { fileId, recordTime, dealId }) {
  try {
    const col = collection(fastify);
    if (!col) return;
    await col.updateOne(
      { kind, num: String(num) },
      {
        $set: {
          kind,
          num: String(num),
          fileId: String(fileId),
          recordTime: Number.isFinite(Number(recordTime)) ? Number(recordTime) : null,
          dealId: dealId ? String(dealId) : null,
          updatedAt: new Date(),
        },
      },
      { upsert: true },
    );
  } catch (error) {
    fastify?.log?.warn(`pdf_sync_state write failed for ${kind} ${num}: ${error.message}`);
  }
}
