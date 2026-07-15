/**
 * File Audit — shared core logic
 *
 * Pure functions for auditing and backfilling the Quote / Sales Order PDFs
 * that live in HubSpot Files and are referenced from the quote_pdf /
 * sales_order_pdf deal properties. These are consumed by BOTH:
 *   - the Fastify routes in ./index.js (deployed on Lightsail), and
 *   - the local CLI in scripts/hubspotBackfill.js (HubSpot-only, no Epicor).
 *
 * Every operation here touches HubSpot ONLY (searchDeals / getFileById /
 * updateFileAccess / renameFile / moveFileToFolder) — nothing calls Epicor —
 * so it can run from a machine whose IP is not whitelisted for Epicor.
 *
 * ── Context object (`ctx`) ─────────────────────────────────────
 *   adapter : a HubspotAdapter instance
 *   run     : async (fn, opLabel?) => fn()  — executor wrapper
 *             (routes pass fastify.backoff; the CLI passes a passthrough,
 *              since the adapter already retries internally)
 *   log     : { info(msg) }
 *
 * ── Folders object (`folders`) ─────────────────────────────────
 *   { quotesFolder, ordersFolder }  — expected logical folder per property
 */

export const DESIRED_ACCESS = 'PUBLIC_NOT_INDEXABLE';

// The two deal properties that hold a HubSpot fileId.
export const FILE_PROPERTIES = ['quote_pdf', 'sales_order_pdf'];

// The deal property that holds the Epicor number needed to regenerate each PDF.
const NUMBER_PROPERTY_FOR = {
  quote_pdf: 'orderdtl_quotenum',
  sales_order_pdf: 'orderhed_ordernum',
};
const NUMBER_PROPERTIES = Object.values(NUMBER_PROPERTY_FOR);

// Candidate field names on the getFileById() response that may carry folder
// info — the exact shape is unverified, so we probe several.
const FOLDER_ID_FIELDS = ['parentFolderId', 'folderId', 'parentFolderPath', 'folderPath', 'path'];

export function expectedFolderFor(property, { quotesFolder = '/Quotes', ordersFolder = '/Sales Orders' } = {}) {
  return property === 'quote_pdf' ? quotesFolder : ordersFolder;
}

/**
 * The displayed filename (with extension). HubSpot stores `name` WITHOUT the
 * extension (e.g. "Quote-170240") and keeps `extension` ("pdf") separate, so a
 * doubled ".pdf.pdf" shows up in `path` ("/Quotes/Quote-170240.pdf.pdf"), never
 * in `name`. Prefer the path basename, which is the source of truth.
 */
export function displayName(file) {
  if (typeof file?.path === 'string' && file.path) {
    return file.path.split('/').pop();
  }
  const name = typeof file?.name === 'string' ? file.name : '';
  const ext = typeof file?.extension === 'string' ? file.extension : '';
  if (ext && !name.toLowerCase().endsWith(`.${ext.toLowerCase()}`)) {
    return `${name}.${ext}`;
  }
  return name;
}

/**
 * Given a displayed basename, return the corrected basename if it has a doubled
 * ".pdf.pdf" (or more) extension, collapsing it to a single ".pdf". Returns null
 * when already fine. Deliberately does NOT strip "-1"/"-2" suffixes, since
 * renaming those risks colliding with a sibling of the canonical name. None of
 * these operations re-upload, so no new suffix is ever created. The returned
 * value is passed to renameFile(), which normalizes to the stem internally.
 */
export function repairedName(basename) {
  if (typeof basename !== 'string' || !basename) return null;
  const collapsed = basename.replace(/(\.pdf)(?:\.pdf)+$/i, '.pdf');
  return collapsed !== basename ? collapsed : null;
}

/**
 * The corrected `name` FIELD value for a doubled-extension file, or null if fine.
 * HubSpot builds the displayed path as `name + "." + extension`, so a file stored
 * as name="Quote-168938.pdf" / extension="pdf" renders as ".../Quote-168938.pdf.pdf".
 * The fix is to strip the redundant trailing ".<ext>" from `name` (renameFile
 * with this stem makes HubSpot append the extension exactly once). Passing the
 * full "Quote-168938.pdf" instead is a silent no-op — HubSpot keeps that as the
 * name and re-appends ".pdf" → still doubled. Verified empirically.
 */
export function desiredNameField(file) {
  const name = typeof file?.name === 'string' ? file.name : '';
  const ext = typeof file?.extension === 'string' ? file.extension : '';
  if (!name || !ext) return null;
  const re = new RegExp(`(\\.${ext.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})+$`, 'i');
  const fixed = name.replace(re, '');
  return fixed && fixed !== name ? fixed : null;
}

/**
 * HubSpot returns 400 "File visibility cannot be changed" for files whose access
 * cannot be PATCHed (e.g. PRIVATE). Those must be regenerated instead of flipped.
 */
function isVisibilityBlocked(error) {
  return /visibility cannot be changed/i.test(String(error?.message || ''));
}

/** Fallback: extract the Epicor number from a filename like "Quote-170240.pdf". */
function numberFromFileName(basename, property) {
  if (typeof basename !== 'string') return null;
  const re = property === 'quote_pdf' ? /Quote-(\d+)/i : /Sales Order-(\d+)/i;
  const m = re.exec(basename);
  return m ? m[1] : null;
}

/** Pick the first folder-identifying field present on a file object. */
function pickFolderKey(file) {
  for (const field of FOLDER_ID_FIELDS) {
    if (file?.[field] !== null && file?.[field] !== undefined && file[field] !== '') {
      return { field, value: String(file[field]) };
    }
  }
  return { field: null, value: '(none found)' };
}

/**
 * Page through every deal that has at least one of FILE_PROPERTIES set.
 * Returns a flat list of { dealId, property, fileId, expectedFolder }.
 */
export async function enumerateFileRefs(ctx, folders) {
  const body = {
    // filterGroups are OR'd together → deals with quote_pdf OR sales_order_pdf
    filterGroups: FILE_PROPERTIES.map((propertyName) => ({
      filters: [{ propertyName, operator: 'HAS_PROPERTY' }],
    })),
    properties: [...FILE_PROPERTIES, ...NUMBER_PROPERTIES],
    limit: 100,
  };

  const refs = [];
  let after;
  let pages = 0;

  do {
    const pageBody = after ? { ...body, after } : body;
    const data = await ctx.run(
      () => ctx.adapter.searchDeals({ body: pageBody }),
      'fileAudit.searchDeals',
    );

    for (const deal of data?.results || []) {
      const props = deal.properties || {};
      for (const property of FILE_PROPERTIES) {
        const fileId = props[property];
        if (fileId !== null && fileId !== undefined && String(fileId).trim() !== '') {
          const rawNumber = props[NUMBER_PROPERTY_FOR[property]];
          refs.push({
            dealId: String(deal.id),
            property,
            fileId: String(fileId).trim(),
            number: rawNumber != null && String(rawNumber).trim() !== '' ? String(rawNumber).trim() : null,
            expectedFolder: expectedFolderFor(property, folders),
          });
        }
      }
    }

    after = data?.paging?.next?.after;
    pages += 1;
  } while (after);

  ctx.log.info(`fileAudit: enumerated ${refs.length} file ref(s) across ${pages} page(s)`);
  return refs;
}

/** Enumerate then apply optional { dealIds, limit } scoping. */
export async function selectRefs(ctx, folders, body = {}) {
  const dealIdFilter = Array.isArray(body?.dealIds)
    ? new Set(body.dealIds.map(String))
    : null;
  const limit = Number.isFinite(body?.limit) ? Number(body.limit) : null;

  let refs = await enumerateFileRefs(ctx, folders);
  if (dealIdFilter) {
    refs = refs.filter((r) => dealIdFilter.has(r.dealId));
  }
  if (limit && refs.length > limit) {
    refs = refs.slice(0, limit);
  }
  return refs;
}

/** Read-only diagnostic. No mutations. */
export async function diagnose(ctx, folders, body = {}) {
  let refs = await enumerateFileRefs(ctx, folders);
  const totalDeals = new Set(refs.map((r) => r.dealId)).size;

  const dealIdFilter = Array.isArray(body?.dealIds) ? new Set(body.dealIds.map(String)) : null;
  const limit = Number.isFinite(body?.limit) ? Number(body.limit) : null;
  if (dealIdFilter) refs = refs.filter((r) => dealIdFilter.has(r.dealId));
  if (limit && refs.length > limit) refs = refs.slice(0, limit);

  ctx.log.info(`fileAudit: fetching details for ${refs.length} file(s)...`);

  const accessCounts = {};
  const folderByExpected = {};
  const mismatchByExpected = {};
  const errors = [];
  const samples = [];
  const nameIssues = { doubledPdfExt: 0, dashNumberSuffix: 0, examples: [], dashNumberExamples: [] };
  let filesChecked = 0;

  for (const ref of refs) {
    let file;
    try {
      file = await ctx.run(() => ctx.adapter.getFileById(ref.fileId), 'fileAudit.getFileById');
    } catch (error) {
      errors.push({ dealId: ref.dealId, fileId: ref.fileId, property: ref.property, message: error.message });
      continue;
    }
    if (!file) {
      errors.push({ dealId: ref.dealId, fileId: ref.fileId, property: ref.property, message: 'no file data returned' });
      continue;
    }

    filesChecked += 1;

    const access = file.access ?? '(no access field)';
    accessCounts[access] = (accessCounts[access] || 0) + 1;

    const { field: folderField, value: folderKey } = pickFolderKey(file);
    const exp = ref.expectedFolder;
    folderByExpected[exp] = folderByExpected[exp] || {};
    folderByExpected[exp][folderKey] = folderByExpected[exp][folderKey] || {
      count: 0,
      folderField,
      samplePath: file.path ?? null,
    };
    folderByExpected[exp][folderKey].count += 1;

    mismatchByExpected[exp] = mismatchByExpected[exp] || { checked: 0, notInExpected: 0, unknown: 0 };
    mismatchByExpected[exp].checked += 1;
    const pathLike = file.path ?? file.parentFolderPath ?? file.folderPath ?? null;
    if (pathLike === null) {
      mismatchByExpected[exp].unknown += 1;
    } else if (!String(pathLike).toLowerCase().startsWith(exp.toLowerCase())) {
      mismatchByExpected[exp].notInExpected += 1;
    }

    const basename = displayName(file);
    const fixedName = repairedName(basename);
    if (fixedName) {
      nameIssues.doubledPdfExt += 1;
      if (nameIssues.examples.length < 15) {
        nameIssues.examples.push({ fileId: ref.fileId, from: basename, to: fixedName });
      }
    }
    // A real duplicate suffix is a SECOND trailing "-N" after the canonical
    // "Quote-<num>" / "Sales Order-<num>" (e.g. "Quote-170240-1.pdf"). Matching
    // a single "-<digits>.pdf" would false-positive on the number itself.
    if (/-\d+-\d+\.pdf$/i.test(basename)) {
      nameIssues.dashNumberSuffix += 1;
      if (nameIssues.dashNumberExamples.length < 15) {
        nameIssues.dashNumberExamples.push({ fileId: ref.fileId, name: basename });
      }
    }

    if (samples.length < 3) {
      samples.push({ expectedFolder: exp, property: ref.property, file });
    }
  }

  const notDesiredAccess = filesChecked - (accessCounts[DESIRED_ACCESS] || 0);
  const pct = (n) => (filesChecked ? Math.round((n / filesChecked) * 1000) / 10 : 0);

  const folderDrift = {};
  for (const [exp, byKey] of Object.entries(folderByExpected)) {
    const distinct = Object.entries(byKey).map(([folderKey, info]) => ({
      folderKey,
      folderField: info.folderField,
      count: info.count,
      samplePath: info.samplePath,
    }));
    folderDrift[exp] = {
      distinctFolderIdentities: distinct.length,
      driftLikely: distinct.length > 1,
      identities: distinct,
    };
  }

  return {
    success: true,
    desiredAccess: DESIRED_ACCESS,
    totalDeals,
    totalFileRefs: refs.length,
    filesChecked,
    errorCount: errors.length,
    access: { counts: accessCounts, notDesired: notDesiredAccess, pctNotDesired: pct(notDesiredAccess) },
    folder: { drift: folderDrift, mismatchByExpected },
    nameIssues,
    samples,
    errors: errors.slice(0, 25),
  };
}

/** Set every existing PDF to PUBLIC_NOT_INDEXABLE. In-place PATCH, no re-upload. */
export async function backfillAccess(ctx, folders, body = {}) {
  const dryRun = body?.dryRun !== false; // default true
  const refs = await selectRefs(ctx, folders, body);

  const results = { total: refs.length, updated: 0, skipped: 0, errors: 0, dryRun };
  const errorDetail = [];
  const needsRegeneration = [];
  let i = 0;

  for (const ref of refs) {
    i += 1;
    const tag = `[${i}/${refs.length}] deal=${ref.dealId} file=${ref.fileId}`;
    let current = 'unknown';
    try {
      const file = await ctx.run(() => ctx.adapter.getFileById(ref.fileId), 'fileAudit.getFileById');
      current = file?.access ?? 'unknown';
      if (file?.access === DESIRED_ACCESS) {
        results.skipped += 1;
        ctx.log.info(`${tag} already ${DESIRED_ACCESS} — skip`);
        continue;
      }
      if (!dryRun) {
        await ctx.run(() => ctx.adapter.updateFileAccess(ref.fileId, DESIRED_ACCESS), 'fileAudit.updateFileAccess');
      }
      results.updated += 1; // would-update when dryRun
      ctx.log.info(`${tag} ${current} -> ${DESIRED_ACCESS}${dryRun ? ' (dry-run)' : ' OK'}`);
    } catch (error) {
      // Files HubSpot refuses to re-visibility must be regenerated instead.
      if (isVisibilityBlocked(error)) {
        needsRegeneration.push({
          dealId: ref.dealId,
          fileId: ref.fileId,
          property: ref.property,
          number: ref.number,
          currentAccess: current,
        });
        ctx.log.info(`${tag} BLOCKED (${current}) — needs regeneration`);
      } else {
        results.errors += 1;
        ctx.log.info(`${tag} ERROR: ${error.message}`);
        if (errorDetail.length < 25) {
          errorDetail.push({ dealId: ref.dealId, fileId: ref.fileId, message: error.message });
        }
      }
    }
  }

  ctx.log.info(
    `fileAudit backfillAccess (dryRun=${dryRun}): ${results.updated} ${dryRun ? 'would-update' : 'updated'}, ${results.skipped} skipped, ${needsRegeneration.length} need-regeneration, ${results.errors} errors`,
  );
  return {
    success: true,
    desiredAccess: DESIRED_ACCESS,
    ...results,
    needsRegenerationCount: needsRegeneration.length,
    needsRegenerationDealIds: [...new Set(needsRegeneration.map((r) => r.dealId))],
    needsRegeneration: needsRegeneration.slice(0, 100),
    errors: errorDetail,
  };
}

/** Repair doubled ".pdf.pdf" extensions via in-place rename (no re-upload). */
export async function fixNames(ctx, folders, body = {}) {
  const dryRun = body?.dryRun !== false; // default true
  const refs = await selectRefs(ctx, folders, body);

  const results = { total: refs.length, renamed: 0, skipped: 0, errors: 0, dryRun };
  const detail = [];
  let i = 0;

  for (const ref of refs) {
    i += 1;
    const tag = `[${i}/${refs.length}] deal=${ref.dealId} file=${ref.fileId}`;
    try {
      const file = await ctx.run(() => ctx.adapter.getFileById(ref.fileId), 'fileAudit.getFileById');
      const nameStem = desiredNameField(file); // the `name` field to set (no extension)
      if (!nameStem) {
        results.skipped += 1;
        continue;
      }
      const fromDisplay = displayName(file);
      const toDisplay = repairedName(fromDisplay) || `${nameStem}.${file.extension}`;
      if (detail.length < 25) {
        detail.push({ dealId: ref.dealId, fileId: ref.fileId, from: fromDisplay, to: toDisplay });
      }
      if (!dryRun) {
        await ctx.run(() => ctx.adapter.renameFile(ref.fileId, nameStem), 'fileAudit.renameFile');
      }
      results.renamed += 1; // would-rename when dryRun
      ctx.log.info(`${tag} "${fromDisplay}" -> "${toDisplay}"${dryRun ? ' (dry-run)' : ' OK'}`);
    } catch (error) {
      results.errors += 1;
      ctx.log.info(`${tag} ERROR: ${error.message}`);
      if (detail.length < 25) {
        detail.push({ dealId: ref.dealId, fileId: ref.fileId, error: error.message });
      }
    }
  }

  ctx.log.info(
    `fileAudit fixNames (dryRun=${dryRun}): ${results.renamed} ${dryRun ? 'would-rename' : 'renamed'}, ${results.skipped} skipped, ${results.errors} errors`,
  );
  return { success: true, ...results, detail };
}

/**
 * Move existing PDFs into the canonical /Quotes and /Sales Orders folders.
 * Only useful if diagnose confirmed folder drift. Resolves each logical folder
 * to a numeric folderId (unambiguous match only), or uses a { "/Quotes": "id" }
 * override map from body.folderIds.
 */
export async function backfillFolder(ctx, folders, body = {}) {
  const dryRun = body?.dryRun !== false; // default true
  const overrideIds = body?.folderIds || {};

  const expectedFolders = [...new Set(FILE_PROPERTIES.map((p) => expectedFolderFor(p, folders)))];
  const targets = {};
  const resolution = {};
  for (const exp of expectedFolders) {
    if (overrideIds[exp]) {
      targets[exp] = String(overrideIds[exp]);
      resolution[exp] = { folderId: targets[exp], source: 'override' };
      continue;
    }
    const resolved = await ctx.adapter.resolveFolderId(exp);
    resolution[exp] = { folderId: resolved.folderId, matches: resolved.matches, source: 'resolved' };
    if (resolved.matches.length === 1) {
      targets[exp] = resolved.folderId;
    }
  }

  const refs = await selectRefs(ctx, folders, body);
  const results = { total: refs.length, updated: 0, skipped: 0, errors: 0, dryRun };
  const errorDetail = [];
  let i = 0;

  for (const ref of refs) {
    i += 1;
    const tag = `[${i}/${refs.length}] deal=${ref.dealId} file=${ref.fileId}`;
    const targetId = targets[ref.expectedFolder];
    if (!targetId) {
      results.errors += 1;
      ctx.log.info(`${tag} ERROR: no unambiguous folderId for ${ref.expectedFolder}`);
      if (errorDetail.length < 25) {
        errorDetail.push({
          dealId: ref.dealId,
          fileId: ref.fileId,
          message: `no unambiguous target folderId for ${ref.expectedFolder} — pass folderIds override`,
        });
      }
      continue;
    }

    try {
      const file = await ctx.run(() => ctx.adapter.getFileById(ref.fileId), 'fileAudit.getFileById');
      const currentFolderId = file?.parentFolderId != null ? String(file.parentFolderId) : null;
      if (currentFolderId === targetId) {
        results.skipped += 1;
        continue;
      }
      if (!dryRun) {
        await ctx.run(() => ctx.adapter.moveFileToFolder(ref.fileId, targetId), 'fileAudit.moveFileToFolder');
      }
      results.updated += 1; // would-move when dryRun
      ctx.log.info(`${tag} folder ${currentFolderId ?? 'n/a'} -> ${targetId}${dryRun ? ' (dry-run)' : ' OK'}`);
    } catch (error) {
      results.errors += 1;
      ctx.log.info(`${tag} ERROR: ${error.message}`);
      if (errorDetail.length < 25) {
        errorDetail.push({ dealId: ref.dealId, fileId: ref.fileId, message: error.message });
      }
    }
  }

  ctx.log.info(
    `fileAudit backfillFolder (dryRun=${dryRun}): ${results.updated} ${dryRun ? 'would-move' : 'moved'}, ${results.skipped} skipped, ${results.errors} errors`,
  );
  return { success: true, targets: resolution, ...results, errors: errorDetail };
}

/**
 * Regenerate + replace PDFs that could not be flipped in place (the blocked set
 * from backfillAccess). For each deal-with-PDF whose file is still NOT
 * PUBLIC_NOT_INDEXABLE, pull a fresh PDF from Epicor by number, upload it public,
 * set the deal property, and delete the old file — all handled by the injected
 * ctx.regenerateQuote / ctx.regenerateOrder (the existing generateAndUpload*Pdf).
 *
 * REQUIRES Epicor connectivity → Lightsail only. `ctx` must additionally provide:
 *   regenerateQuote(quoteNum, dealId, previousFileId)
 *   regenerateOrder(orderNum, dealId, previousFileId)
 */
export async function regenerate(ctx, folders, body = {}) {
  const dryRun = body?.dryRun !== false; // default true
  const refs = await selectRefs(ctx, folders, body);

  const results = { total: refs.length, regenerated: 0, skipped: 0, errors: 0, dryRun };
  const errorDetail = [];
  let i = 0;

  for (const ref of refs) {
    i += 1;
    const tag = `[${i}/${refs.length}] deal=${ref.dealId} file=${ref.fileId} (${ref.property})`;
    try {
      const file = await ctx.run(() => ctx.adapter.getFileById(ref.fileId), 'fileAudit.getFileById');
      if (file?.access === DESIRED_ACCESS) {
        results.skipped += 1; // already public (e.g. flipped in Phase A)
        continue;
      }

      // Resolve the Epicor number: deal property first, then the filename.
      const number = ref.number || numberFromFileName(displayName(file), ref.property);
      if (!number) {
        results.errors += 1;
        ctx.log.info(`${tag} ERROR: no quote/order number on deal or filename — cannot regenerate`);
        if (errorDetail.length < 25) {
          errorDetail.push({ dealId: ref.dealId, fileId: ref.fileId, message: 'unresolved number' });
        }
        continue;
      }

      if (!dryRun) {
        if (ref.property === 'quote_pdf') {
          await ctx.regenerateQuote(number, ref.dealId, ref.fileId);
        } else {
          await ctx.regenerateOrder(number, ref.dealId, ref.fileId);
        }
      }
      results.regenerated += 1; // would-regenerate when dryRun
      ctx.log.info(`${tag} regenerate num=${number}${dryRun ? ' (dry-run)' : ' OK'}`);
    } catch (error) {
      results.errors += 1;
      ctx.log.info(`${tag} ERROR: ${error.message}`);
      if (errorDetail.length < 25) {
        errorDetail.push({ dealId: ref.dealId, fileId: ref.fileId, message: error.message });
      }
    }
  }

  ctx.log.info(
    `fileAudit regenerate (dryRun=${dryRun}): ${results.regenerated} ${dryRun ? 'would-regenerate' : 'regenerated'}, ${results.skipped} skipped, ${results.errors} errors`,
  );
  return { success: true, ...results, errors: errorDetail };
}
