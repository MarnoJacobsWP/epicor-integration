#!/usr/bin/env node
/**
 * Local HubSpot backfill CLI (HubSpot-only — no Epicor, so it runs fine from a
 * machine whose IP is not whitelisted for Epicor).
 *
 * Constructs the same HubspotAdapter the app uses (same throttle + retry) and
 * runs the shared fileAudit core operations against the live portal.
 *
 * ── Usage ──────────────────────────────────────────────────────
 *   node scripts/hubspotBackfill.js <command> [options]
 *
 * Commands:
 *   diagnose   Read-only report: access levels, folder drift, name issues
 *   access     Set every PDF to PUBLIC_NOT_INDEXABLE (in-place, no re-upload)
 *   names      Repair ".pdf.pdf" -> ".pdf" (in-place rename, no re-upload)
 *   folder     Move PDFs into canonical /Quotes and /Sales Orders folders
 *
 * Options:
 *   --apply                 Actually perform mutations (default is DRY RUN)
 *   --deals=123,456         Scope to specific deal ids
 *   --limit=50              Cap the number of files processed
 *   --folderIds="/Quotes=123,/Sales Orders=456"   (folder command override)
 *   --json                  Print full JSON only (no human summary)
 *
 * Examples:
 *   node scripts/hubspotBackfill.js diagnose
 *   node scripts/hubspotBackfill.js access                 # dry run
 *   node scripts/hubspotBackfill.js access --deals=123 --apply
 *   node scripts/hubspotBackfill.js names --apply
 */

import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import axios from 'axios';

import { HubspotAdapter } from '../src/adapters/hubspot.js';
import { MAX_RETRIES, REQUEST_TIMEOUT } from '../src/config/constants.js';
import * as core from '../src/modules/fileAudit/core.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

// ── Minimal .env parser (dotenv is not a project dependency) ─────
function loadEnvFile(envPath) {
  const out = {};
  if (!fs.existsSync(envPath)) return out;
  const text = fs.readFileSync(envPath, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      // strip inline comment (" # ...") from unquoted values
      value = value.replace(/\s+#.*$/, '').trim();
    }
    out[key] = value;
  }
  return out;
}

// ── Arg parsing ─────────────────────────────────────────────────
function parseArgs(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  for (const arg of rest) {
    if (!arg.startsWith('--')) continue;
    const [k, v] = arg.slice(2).split(/=(.*)/s);
    flags[k] = v === undefined ? true : v;
  }
  return { command, flags };
}

function parseFolderIds(raw) {
  if (!raw || typeof raw !== 'string') return {};
  const map = {};
  for (const pair of raw.split(',')) {
    const idx = pair.lastIndexOf('=');
    if (idx === -1) continue;
    map[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
  }
  return map;
}

const COMMANDS = {
  diagnose: core.diagnose,
  access: core.backfillAccess,
  names: core.fixNames,
  folder: core.backfillFolder,
};

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));

  const isKnown = command === 'testUpload' || Boolean(COMMANDS[command]);
  if (!command || flags.help || flags.h || !isKnown) {
    console.error(
      'Usage: node scripts/hubspotBackfill.js <diagnose|access|names|folder|testUpload> [--apply] [--deals=1,2] [--limit=N] [--folderIds="/Quotes=123"] [--cleanup]',
    );
    console.error('Note: "regenerate" needs Epicor and runs only on Lightsail via POST /fileAudit/regenerate.');
    process.exit(command && !isKnown ? 1 : 0);
    return;
  }

  // File values win over process.env so editing .env is the source of truth.
  const config = { ...process.env, ...loadEnvFile(path.join(PROJECT_ROOT, '.env')) };

  if (!config.HUBSPOT_ACCESS_TOKEN) {
    console.error('ERROR: HUBSPOT_ACCESS_TOKEN not found in .env (or environment).');
    process.exit(1);
    return;
  }

  const allowInsecureTls = config.ALLOW_INSECURE_TLS === true || config.ALLOW_INSECURE_TLS === 'true';
  const httpClient = axios.create({
    httpsAgent: new https.Agent({ rejectUnauthorized: !allowInsecureTls }),
    timeout: REQUEST_TIMEOUT,
    maxContentLength: 50 * 1024 * 1024,
  });

  // Route all adapter logging to stderr so stdout carries only the JSON result.
  const logger = {
    info: (...a) => console.error('[info]', ...a),
    warn: (...a) => console.error('[warn]', ...a),
    error: (...a) => console.error('[error]', ...a),
    debug: () => {},
  };

  const adapter = new HubspotAdapter(httpClient, config, logger, { MAX_RETRIES, REQUEST_TIMEOUT });

  const ctx = {
    adapter,
    // The adapter already retries internally; no extra backoff wrapper needed.
    run: (fn) => fn(),
    log: { info: (msg) => console.error('[info]', msg) },
  };

  const folders = {
    quotesFolder: (config.HUBSPOT_FILES_FOLDER_PATH || '/Quotes').replace(/\s+#.*$/, '').trim(),
    ordersFolder: (config.HUBSPOT_SALES_ORDER_FILES_FOLDER_PATH || '/Sales Orders').replace(/\s+#.*$/, '').trim(),
  };

  // Feasibility probe: does HubSpot honor PUBLIC_NOT_INDEXABLE at UPLOAD time for
  // this portal? (A fresh upload is a different path than the blocked PATCH.)
  if (command === 'testUpload') {
    const pdf = Buffer.from(
      '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 144]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
      'utf8',
    );
    const fileName = `fileaudit-testUpload-${Date.now()}.pdf`;
    console.error('\n=== hubspotBackfill: testUpload ===');
    console.error(`Uploading "${fileName}" with access=PUBLIC_NOT_INDEXABLE to ${folders.quotesFolder} ...`);
    const uploaded = await adapter.uploadFile({
      buffer: pdf,
      fileName,
      contentType: 'application/pdf',
      access: 'PUBLIC_NOT_INDEXABLE',
      folderPath: folders.quotesFolder,
    });
    const file = await adapter.getFileById(uploaded.id);
    const publicOk = file?.access === 'PUBLIC_NOT_INDEXABLE';
    console.error(
      `\nRESULT: actual access=${file?.access} (wanted PUBLIC_NOT_INDEXABLE) — ${publicOk ? 'OK: fresh uploads CAN be public' : 'NOT public: regeneration will not help — stop and rethink'}`,
    );
    if (flags.cleanup) {
      await adapter.deleteFile(uploaded.id);
      console.error(`Cleaned up test file ${uploaded.id}.`);
    } else {
      console.error(`Left test file ${uploaded.id} in place (pass --cleanup to delete it).`);
    }
    process.stdout.write(
      `${JSON.stringify({ success: true, fileId: uploaded.id, requestedAccess: 'PUBLIC_NOT_INDEXABLE', actualAccess: file?.access, publicOk, name: file?.name, path: file?.path }, null, 2)}\n`,
    );
    return;
  }

  const body = {
    dryRun: !flags.apply, // dry run unless --apply
    dealIds: typeof flags.deals === 'string' ? flags.deals.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
    limit: flags.limit !== undefined ? Number(flags.limit) : undefined,
    folderIds: parseFolderIds(flags.folderIds),
  };

  const mutating = command !== 'diagnose';
  console.error(`\n=== hubspotBackfill: ${command} ${mutating ? (body.dryRun ? '(DRY RUN)' : '(APPLYING CHANGES)') : ''} ===`);
  if (body.dealIds) console.error(`Scoped to deals: ${body.dealIds.join(', ')}`);
  if (body.limit) console.error(`Limit: ${body.limit}`);

  const result = await COMMANDS[command](ctx, folders, body);

  // Human summary to stderr, full JSON to stdout.
  printSummary(command, result);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function printSummary(command, result) {
  const lines = ['', '--- Summary ---'];
  if (command === 'diagnose') {
    lines.push(`Deals with a PDF property: ${result.totalDeals}`);
    lines.push(`Files checked: ${result.filesChecked} (errors: ${result.errorCount})`);
    lines.push(`Access counts: ${JSON.stringify(result.access.counts)}`);
    lines.push(`NOT ${result.desiredAccess}: ${result.access.notDesired} (${result.access.pctNotDesired}%)`);
    lines.push(`Name issues — ".pdf.pdf": ${result.nameIssues.doubledPdfExt}, "-N.pdf": ${result.nameIssues.dashNumberSuffix}`);
    for (const [folder, d] of Object.entries(result.folder.drift)) {
      lines.push(`Folder "${folder}": ${d.distinctFolderIdentities} distinct identity(ies)${d.driftLikely ? '  <-- DRIFT LIKELY' : ''}`);
    }
  } else {
    for (const [k, v] of Object.entries(result)) {
      if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') lines.push(`${k}: ${v}`);
    }
  }
  lines.push('---------------', '');
  console.error(lines.join('\n'));
}

main().catch((error) => {
  console.error('FATAL:', error?.stack || error?.message || error);
  process.exit(1);
});
