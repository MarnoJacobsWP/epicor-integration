import fp from 'fastify-plugin';

/**
 * File Audit Module
 *
 * Read-only diagnostics (and, later, backfill migrations) for the Quote /
 * Sales Order PDFs that are uploaded to HubSpot Files and referenced from the
 * `quote_pdf` / `sales_order_pdf` deal properties.
 *
 * PHASE 0 — POST /fileAudit/diagnose
 *   Enumerates every deal that has a non-empty quote_pdf or sales_order_pdf,
 *   fetches each file via hubspotAdapter.getFileById(), and reports:
 *     - the distribution of access levels (how many are NOT PUBLIC_NOT_INDEXABLE)
 *     - the distinct actual folder identities seen per expected logical folder
 *       (multiple distinct folder ids under one logical path = folder drift)
 *   No mutations. Optional body: { limit, dealIds } to scope a test run.
 *
 * ── Usage ──────────────────────────────────────────────────────
 *   POST /fileAudit/diagnose
 *   POST /fileAudit/diagnose  { "limit": 50 }
 *   POST /fileAudit/diagnose  { "dealIds": ["123","456"] }
 */

const DESIRED_ACCESS = 'PUBLIC_NOT_INDEXABLE';

// The two deal properties that hold a HubSpot fileId, and the folder each
// upload is *supposed* to land in.
const FILE_PROPERTIES = ['quote_pdf', 'sales_order_pdf'];

// Candidate field names on the getFileById() response that may carry folder
// info — the exact shape is unverified, so we probe several and report what we
// actually find (see the `samples` array in the response).
const FOLDER_ID_FIELDS = ['parentFolderId', 'folderId', 'parentFolderPath', 'folderPath', 'path'];

export default fp(
  async function fileAudit(fastify, _opts) {
    // Expected logical folder per property. Quotes follow the adapter's
    // configurable default; Sales Orders are hardcoded upstream in orderServices.
    const expectedFolderFor = (property) => {
      if (property === 'quote_pdf') {
        return fastify.config?.HUBSPOT_FILES_FOLDER_PATH || '/Quotes';
      }
      return '/Sales Orders';
    };

    /**
     * Page through every deal that has at least one of FILE_PROPERTIES set.
     * Returns a flat list of { dealId, property, fileId, expectedFolder }.
     */
    async function enumerateFileRefs() {
      const body = {
        // filterGroups are OR'd together → deals with quote_pdf OR sales_order_pdf
        filterGroups: FILE_PROPERTIES.map((propertyName) => ({
          filters: [{ propertyName, operator: 'HAS_PROPERTY' }],
        })),
        properties: FILE_PROPERTIES,
        limit: 100,
      };

      const refs = [];
      let after;
      let pages = 0;

      do {
        const pageBody = after ? { ...body, after } : body;
        const data = await fastify.backoff(
          () => fastify.hubspotAdapter.searchDeals({ body: pageBody }),
          { operation: 'fileAudit.searchDeals' },
        );

        for (const deal of data?.results || []) {
          const props = deal.properties || {};
          for (const property of FILE_PROPERTIES) {
            const fileId = props[property];
            if (fileId !== null && fileId !== undefined && String(fileId).trim() !== '') {
              refs.push({
                dealId: String(deal.id),
                property,
                fileId: String(fileId).trim(),
                expectedFolder: expectedFolderFor(property),
              });
            }
          }
        }

        after = data?.paging?.next?.after;
        pages += 1;
      } while (after);

      fastify.log.info(`fileAudit: enumerated ${refs.length} file ref(s) across ${pages} page(s)`);
      return refs;
    }

    /**
     * Enumerate refs then apply optional { dealIds, limit } scoping from a
     * request body. Shared by diagnose and both backfill routes so a first
     * real run can be scoped to a handful of known deals.
     */
    async function selectRefs(body) {
      const dealIdFilter = Array.isArray(body?.dealIds)
        ? new Set(body.dealIds.map((id) => String(id)))
        : null;
      const limit = Number.isFinite(body?.limit) ? Number(body.limit) : null;

      let refs = await enumerateFileRefs();
      if (dealIdFilter) {
        refs = refs.filter((r) => dealIdFilter.has(r.dealId));
      }
      if (limit && refs.length > limit) {
        refs = refs.slice(0, limit);
      }
      return refs;
    }

    /** Pick the first folder-identifying field present on a file object. */
    const pickFolderKey = (file) => {
      for (const field of FOLDER_ID_FIELDS) {
        if (file?.[field] !== null && file?.[field] !== undefined && file[field] !== '') {
          return { field, value: String(file[field]) };
        }
      }
      return { field: null, value: '(none found)' };
    };

    /**
     * Return the corrected name if the file has a doubled ".pdf.pdf" (or more)
     * extension, collapsing it to a single ".pdf". Returns null when the name
     * is already fine — we deliberately do NOT strip "-1"/"-2" suffixes here,
     * since renaming those risks colliding with a sibling file of the canonical
     * name. Backfill never re-uploads, so no new suffixes are ever created.
     */
    const repairedName = (name) => {
      if (typeof name !== 'string' || !name) return null;
      const collapsed = name.replace(/(\.pdf)(?:\.pdf)+$/i, '.pdf');
      return collapsed !== name ? collapsed : null;
    };

    // ── Route ───────────────────────────────────────────────────
    fastify.post('/fileAudit/diagnose', async (request, reply) => {
      try {
        const limit = Number.isFinite(request.body?.limit) ? Number(request.body.limit) : null;
        const dealIdFilter = Array.isArray(request.body?.dealIds)
          ? new Set(request.body.dealIds.map((id) => String(id)))
          : null;

        let refs = await enumerateFileRefs();
        const totalDeals = new Set(refs.map((r) => r.dealId)).size;

        if (dealIdFilter) {
          refs = refs.filter((r) => dealIdFilter.has(r.dealId));
        }
        if (limit && refs.length > limit) {
          refs = refs.slice(0, limit);
        }

        fastify.log.info(`fileAudit: fetching details for ${refs.length} file(s)...`);

        const accessCounts = {};          // access value -> count
        const folderByExpected = {};      // expected folder -> { folderKey -> { count, samplePath } }
        const mismatchByExpected = {};    // expected folder -> { checked, notInExpected, unknown }
        const errors = [];
        const samples = [];               // a few full raw file objects for field verification
        const nameIssues = { doubledPdfExt: 0, dashNumberSuffix: 0, examples: [] };
        let filesChecked = 0;

        for (const ref of refs) {
          let file;
          try {
            file = await fastify.backoff(
              () => fastify.hubspotAdapter.getFileById(ref.fileId),
              { operation: 'fileAudit.getFileById' },
            );
          } catch (error) {
            errors.push({ dealId: ref.dealId, fileId: ref.fileId, property: ref.property, message: error.message });
            continue;
          }

          if (!file) {
            errors.push({ dealId: ref.dealId, fileId: ref.fileId, property: ref.property, message: 'no file data returned' });
            continue;
          }

          filesChecked += 1;

          // Access distribution
          const access = file.access ?? '(no access field)';
          accessCounts[access] = (accessCounts[access] || 0) + 1;

          // Folder identity distribution, grouped by the expected logical folder
          const { field: folderField, value: folderKey } = pickFolderKey(file);
          const exp = ref.expectedFolder;
          folderByExpected[exp] = folderByExpected[exp] || {};
          folderByExpected[exp][folderKey] = folderByExpected[exp][folderKey] || {
            count: 0,
            folderField,
            samplePath: file.path ?? null,
          };
          folderByExpected[exp][folderKey].count += 1;

          // Best-effort "is it in the expected folder?" using any path-like field
          mismatchByExpected[exp] = mismatchByExpected[exp] || { checked: 0, notInExpected: 0, unknown: 0 };
          mismatchByExpected[exp].checked += 1;
          const pathLike = file.path ?? file.parentFolderPath ?? file.folderPath ?? null;
          if (pathLike === null) {
            mismatchByExpected[exp].unknown += 1;
          } else if (!String(pathLike).toLowerCase().startsWith(exp.toLowerCase())) {
            mismatchByExpected[exp].notInExpected += 1;
          }

          // Name issues: doubled ".pdf.pdf" (we'll repair) and "-N" suffixes (info only)
          const currentName = file.name ?? '';
          const fixedName = repairedName(currentName);
          if (fixedName) {
            nameIssues.doubledPdfExt += 1;
            if (nameIssues.examples.length < 15) {
              nameIssues.examples.push({ fileId: ref.fileId, from: currentName, to: fixedName });
            }
          }
          if (/-\d+\.pdf$/i.test(currentName)) {
            nameIssues.dashNumberSuffix += 1;
          }

          // Keep a few full samples so we can confirm the real field names
          if (samples.length < 3) {
            samples.push({ expectedFolder: exp, property: ref.property, file });
          }
        }

        const notDesiredAccess = filesChecked - (accessCounts[DESIRED_ACCESS] || 0);
        const pct = (n) => (filesChecked ? Math.round((n / filesChecked) * 1000) / 10 : 0);

        // Summarize folder drift: distinct folder identities per expected folder
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

        const summary = {
          success: true,
          desiredAccess: DESIRED_ACCESS,
          totalDeals,
          totalFileRefs: refs.length,
          filesChecked,
          errorCount: errors.length,
          access: {
            counts: accessCounts,
            notDesired: notDesiredAccess,
            pctNotDesired: pct(notDesiredAccess),
          },
          folder: {
            drift: folderDrift,
            mismatchByExpected,
          },
          nameIssues,
          samples,
          errors: errors.slice(0, 25),
        };

        fastify.log.info(
          `fileAudit: done — checked=${filesChecked} notDesiredAccess=${notDesiredAccess} (${summary.access.pctNotDesired}%) errors=${errors.length}`,
        );

        return summary;
      } catch (error) {
        fastify.log.error(`fileAudit diagnose failed: ${error.message}`);
        return reply.status(500).send({ success: false, error: error.message });
      }
    });

    // ── Backfill: access level ──────────────────────────────────
    // Sets every existing Quote/Sales Order PDF to PUBLIC_NOT_INDEXABLE.
    // Body: { dryRun=true, dealIds?, limit? }. Skips files already correct.
    fastify.post('/fileAudit/backfillAccess', async (request, reply) => {
      try {
        const dryRun = request.body?.dryRun !== false; // default true
        const refs = await selectRefs(request.body);

        const results = { total: refs.length, updated: 0, skipped: 0, errors: 0, dryRun };
        const errorDetail = [];

        for (const ref of refs) {
          try {
            const file = await fastify.backoff(
              () => fastify.hubspotAdapter.getFileById(ref.fileId),
              { operation: 'fileAudit.getFileById' },
            );
            if (file?.access === DESIRED_ACCESS) {
              results.skipped += 1;
              continue;
            }
            if (dryRun) {
              results.updated += 1; // would-update
              continue;
            }
            await fastify.backoff(
              () => fastify.hubspotAdapter.updateFileAccess(ref.fileId, DESIRED_ACCESS),
              { operation: 'fileAudit.updateFileAccess' },
            );
            results.updated += 1;
          } catch (error) {
            results.errors += 1;
            if (errorDetail.length < 25) {
              errorDetail.push({ dealId: ref.dealId, fileId: ref.fileId, message: error.message });
            }
          }
        }

        fastify.log.info(
          `fileAudit backfillAccess (dryRun=${dryRun}): ${results.updated} ${dryRun ? 'would-update' : 'updated'}, ${results.skipped} skipped, ${results.errors} errors`,
        );
        return { success: true, desiredAccess: DESIRED_ACCESS, ...results, errors: errorDetail };
      } catch (error) {
        fastify.log.error(`fileAudit backfillAccess failed: ${error.message}`);
        return reply.status(500).send({ success: false, error: error.message });
      }
    });

    // ── Backfill: file names ────────────────────────────────────
    // Repairs doubled ".pdf.pdf" extensions to a single ".pdf" via an in-place
    // rename (PATCH — no re-upload, so no "-1" suffix is ever created). Names
    // that are already fine are left untouched. Body: { dryRun=true, dealIds?, limit? }.
    fastify.post('/fileAudit/fixNames', async (request, reply) => {
      try {
        const dryRun = request.body?.dryRun !== false; // default true
        const refs = await selectRefs(request.body);

        const results = { total: refs.length, renamed: 0, skipped: 0, errors: 0, dryRun };
        const detail = [];

        for (const ref of refs) {
          try {
            const file = await fastify.backoff(
              () => fastify.hubspotAdapter.getFileById(ref.fileId),
              { operation: 'fileAudit.getFileById' },
            );
            const currentName = file?.name ?? '';
            const fixedName = repairedName(currentName);
            if (!fixedName) {
              results.skipped += 1;
              continue;
            }
            if (detail.length < 25) {
              detail.push({ dealId: ref.dealId, fileId: ref.fileId, from: currentName, to: fixedName });
            }
            if (!dryRun) {
              await fastify.backoff(
                () => fastify.hubspotAdapter.renameFile(ref.fileId, fixedName),
                { operation: 'fileAudit.renameFile' },
              );
            }
            results.renamed += 1; // would-rename when dryRun
          } catch (error) {
            results.errors += 1;
            if (detail.length < 25) {
              detail.push({ dealId: ref.dealId, fileId: ref.fileId, error: error.message });
            }
          }
        }

        fastify.log.info(
          `fileAudit fixNames (dryRun=${dryRun}): ${results.renamed} ${dryRun ? 'would-rename' : 'renamed'}, ${results.skipped} skipped, ${results.errors} errors`,
        );
        return { success: true, ...results, detail };
      } catch (error) {
        fastify.log.error(`fileAudit fixNames failed: ${error.message}`);
        return reply.status(500).send({ success: false, error: error.message });
      }
    });

    // ── Backfill: folder placement ──────────────────────────────
    // Moves existing PDFs into the canonical /Quotes and /Sales Orders folders.
    // Only useful if /fileAudit/diagnose confirmed folder drift.
    // Body: { dryRun=true, dealIds?, limit?, folderIds? } where folderIds is an
    // optional override map { "/Quotes": "123", "/Sales Orders": "456" } used
    // when path->id resolution is ambiguous.
    fastify.post('/fileAudit/backfillFolder', async (request, reply) => {
      try {
        const dryRun = request.body?.dryRun !== false; // default true
        const overrideIds = request.body?.folderIds || {};

        // Resolve the target folderId for each expected logical folder once.
        const expectedFolders = [...new Set(FILE_PROPERTIES.map(expectedFolderFor))];
        const targets = {};
        const resolution = {};
        for (const exp of expectedFolders) {
          if (overrideIds[exp]) {
            targets[exp] = String(overrideIds[exp]);
            resolution[exp] = { folderId: targets[exp], source: 'override' };
            continue;
          }
          const resolved = await fastify.hubspotAdapter.resolveFolderId(exp);
          resolution[exp] = { folderId: resolved.folderId, matches: resolved.matches, source: 'resolved' };
          // Only auto-use a resolved id when it's unambiguous (exactly one match).
          if (resolved.matches.length === 1) {
            targets[exp] = resolved.folderId;
          }
        }

        const refs = await selectRefs(request.body);
        const results = { total: refs.length, updated: 0, skipped: 0, errors: 0, dryRun };
        const errorDetail = [];

        for (const ref of refs) {
          const targetId = targets[ref.expectedFolder];
          if (!targetId) {
            results.errors += 1;
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
            const file = await fastify.backoff(
              () => fastify.hubspotAdapter.getFileById(ref.fileId),
              { operation: 'fileAudit.getFileById' },
            );
            const currentFolderId = file?.parentFolderId != null ? String(file.parentFolderId) : null;
            if (currentFolderId === targetId) {
              results.skipped += 1;
              continue;
            }
            if (dryRun) {
              results.updated += 1; // would-move
              continue;
            }
            await fastify.backoff(
              () => fastify.hubspotAdapter.moveFileToFolder(ref.fileId, targetId),
              { operation: 'fileAudit.moveFileToFolder' },
            );
            results.updated += 1;
          } catch (error) {
            results.errors += 1;
            if (errorDetail.length < 25) {
              errorDetail.push({ dealId: ref.dealId, fileId: ref.fileId, message: error.message });
            }
          }
        }

        fastify.log.info(
          `fileAudit backfillFolder (dryRun=${dryRun}): ${results.updated} ${dryRun ? 'would-move' : 'moved'}, ${results.skipped} skipped, ${results.errors} errors`,
        );
        return { success: true, targets: resolution, ...results, errors: errorDetail };
      } catch (error) {
        fastify.log.error(`fileAudit backfillFolder failed: ${error.message}`);
        return reply.status(500).send({ success: false, error: error.message });
      }
    });

    fastify.log.info('FileAudit module loaded');
  },
  {
    name: 'fileAudit',
    dependencies: ['hubspotAdapter', 'backoff'],
  },
);
