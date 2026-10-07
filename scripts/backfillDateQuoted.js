#!/usr/bin/env node
/**
 * One-time backfill: Epicor QuoteHed_DateQuoted -> HubSpot deal "Date Quoted".
 *
 * HubSpot-only (no Epicor calls), so it runs from any machine with the
 * HubSpot token — local PC or Lightsail.
 *
 * Input: the CSV exported from QUOTES.json (columns: QuoteNum, DateQuoted, ...).
 * Matching: deals are found by orderdtl_quotenum (same key the integration uses).
 * Writes: ONLY the target date property, via HubSpot batch update (100 per call).
 * Idempotent: deals that already hold the same date are skipped.
 *
 * ── Usage ──────────────────────────────────────────────────────
 *   node scripts/backfillDateQuoted.js --csv=quotes_with_datequoted.csv            # DRY RUN
 *   node scripts/backfillDateQuoted.js --csv=quotes_with_datequoted.csv --apply    # write
 *
 * Options:
 *   --csv=PATH            CSV file (required)
 *   --property=NAME       HubSpot deal property internal name (default: quotehed_datequoted)
 *   --apply               Actually update HubSpot (default is DRY RUN)
 *   --overwrite           Also overwrite deals that already have a DIFFERENT date
 *                         (default: only fill empty values; differences are reported)
 *   --quotes=1,2,3        Only process these QuoteNums (handy for a first test)
 *   --limit=N             Only process the first N quotes from the CSV
 *   --report=PATH         Output report CSV (default: backfill_datequoted_report_<ts>.csv)
 *
 * Token: HUBSPOT_ACCESS_TOKEN from the repo .env (or environment).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const HUBSPOT_BASE = process.env.HUBSPOT_BASE_URL || 'https://api.hubapi.com';
const QUOTE_KEY_PROPERTY = 'orderdtl_quotenum';
const SEARCH_CHUNK = 100;   // values per IN filter / results per page
const UPDATE_CHUNK = 100;   // HubSpot batch update max
const SEARCH_DELAY_MS = 250; // search API is limited to ~5 req/s
const MAX_RETRIES = 6;

// ── Helpers ─────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadEnvFile(envPath) {
  const out = {};
  if (!fs.existsSync(envPath)) return out;
  for (const rawLine of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    out[key] = value;
  }
  return out;
}

function parseArgs(argv) {
  const flags = {};
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const [k, v] = arg.slice(2).split(/=(.*)/s);
    flags[k] = v === undefined ? true : v;
  }
  return flags;
}

/** Minimal RFC-4180 CSV parser (handles quotes, escaped quotes, CRLF, BOM). */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const [header, ...data] = rows.filter((r) => r.some((v) => v.trim() !== ''));
  const cols = header.map((h) => h.trim());
  return data.map((r) => Object.fromEntries(cols.map((h, i) => [h, (r[i] ?? '').trim()])));
}

/** "2026-08-27" or "2026-08-27T00:00:00-04:00" or "8/27/2026" -> "2026-08-27" (calendar date, no TZ shift). */
function normalizeDate(value) {
  const v = String(value || '').trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v); // Excel re-save (M/D/YYYY)
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return null;
}

/** HubSpot date properties are stored as midnight UTC epoch ms. */
const toHubspotDate = (ymd) => String(Date.parse(`${ymd}T00:00:00Z`));

/** HubSpot may return a date as "YYYY-MM-DD", ISO datetime, or epoch ms. */
function hubspotValueToYmd(value) {
  if (value == null || value === '') return null;
  const s = String(value);
  if (/^\d+$/.test(s)) return new Date(Number(s)).toISOString().slice(0, 10);
  return s.slice(0, 10);
}

function csvEscape(v) {
  return `"${String(v ?? '').replace(/"/g, '""')}"`;
}

// ── HubSpot client (retries on 429 / 5xx) ───────────────────────
function createClient(token) {
  return async function request(method, url, body) {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const res = await fetch(`${HUBSPOT_BASE}${url}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (res.ok) return res.status === 204 ? null : res.json();

      const text = await res.text();
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt === MAX_RETRIES) {
        const err = new Error(`HubSpot ${method} ${url} -> ${res.status}: ${text.slice(0, 500)}`);
        err.status = res.status;
        throw err;
      }
      const retryAfter = Number(res.headers.get('retry-after')) * 1000;
      const wait = retryAfter || Math.min(1000 * 2 ** (attempt - 1), 30000);
      console.warn(`  ${res.status} on ${url}, retry ${attempt}/${MAX_RETRIES - 1} in ${wait}ms`);
      await sleep(wait);
    }
  };
}

// ── Main ────────────────────────────────────────────────────────
async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const apply = flags.apply === true;
  const overwrite = flags.overwrite === true;
  const property = flags.property || 'quotehed_datequoted';

  if (!flags.csv || flags.help) {
    console.error('Usage: node scripts/backfillDateQuoted.js --csv=FILE [--property=NAME] [--apply] [--overwrite] [--quotes=1,2] [--limit=N]');
    process.exit(flags.help ? 0 : 1);
  }

  const config = { ...process.env, ...loadEnvFile(path.join(PROJECT_ROOT, '.env')) };
  if (!config.HUBSPOT_ACCESS_TOKEN) {
    console.error('ERROR: HUBSPOT_ACCESS_TOKEN not found in .env or environment.');
    process.exit(1);
  }
  const hs = createClient(config.HUBSPOT_ACCESS_TOKEN);

  console.log(`\nMode: ${apply ? 'APPLY (writes to HubSpot)' : 'DRY RUN (no writes)'}${overwrite ? ' + OVERWRITE' : ''}`);
  console.log(`Target property: deals.${property}\n`);

  // 1. Validate the target property exists, is a date, and is writable.
  let prop;
  try {
    prop = await hs('GET', `/crm/v3/properties/deals/${encodeURIComponent(property)}`);
  } catch (e) {
    console.error(`ERROR: deal property "${property}" not found in HubSpot. Create it first (Date picker) or pass --property=<internal name>.\n${e.message}`);
    process.exit(1);
  }
  const readOnly = prop.calculated || prop.modificationMetadata?.readOnlyValue;
  console.log(`Property "${prop.label}" type=${prop.type} fieldType=${prop.fieldType} readOnly=${Boolean(readOnly)}`);
  if (prop.type !== 'date') {
    console.error(`ERROR: property type is "${prop.type}", expected "date".`);
    process.exit(1);
  }
  if (readOnly) {
    console.error('ERROR: property is read-only / calculated by HubSpot; it cannot be written.');
    process.exit(1);
  }

  // 2. Load CSV -> Map(quoteNum -> yyyy-mm-dd)
  const rows = parseCsv(fs.readFileSync(path.resolve(flags.csv), 'utf8'));
  const onlyQuotes = flags.quotes ? new Set(String(flags.quotes).split(',').map((s) => s.trim())) : null;
  const wanted = new Map();
  let invalid = 0;
  for (const r of rows) {
    const quoteNum = String(r.QuoteNum || '').trim();
    const ymd = normalizeDate(r.DateQuoted);
    if (!quoteNum) continue;
    if (onlyQuotes && !onlyQuotes.has(quoteNum)) continue;
    if (!ymd) { invalid++; continue; }
    wanted.set(quoteNum, ymd);
  }
  let quoteNums = [...wanted.keys()];
  if (flags.limit) quoteNums = quoteNums.slice(0, Number(flags.limit));
  console.log(`CSV rows: ${rows.length} | quotes to process: ${quoteNums.length} | invalid/empty dates skipped: ${invalid}\n`);

  // 3. Find deals by orderdtl_quotenum (IN filter, 100 values per search, paginated).
  const dealsByQuote = new Map(); // quoteNum -> [{id, current, dealname}]
  for (let i = 0; i < quoteNums.length; i += SEARCH_CHUNK) {
    const chunk = quoteNums.slice(i, i + SEARCH_CHUNK);
    let after;
    do {
      const body = {
        filterGroups: [{ filters: [{ propertyName: QUOTE_KEY_PROPERTY, operator: 'IN', values: chunk }] }],
        properties: [QUOTE_KEY_PROPERTY, property, 'dealname'],
        limit: 100,
        ...(after ? { after } : {}),
      };
      const data = await hs('POST', '/crm/v3/objects/deals/search', body);
      for (const d of data.results || []) {
        const q = String(d.properties?.[QUOTE_KEY_PROPERTY] ?? '').trim();
        if (!wanted.has(q)) continue;
        if (!dealsByQuote.has(q)) dealsByQuote.set(q, []);
        dealsByQuote.get(q).push({ id: d.id, current: hubspotValueToYmd(d.properties?.[property]), dealname: d.properties?.dealname });
      }
      after = data.paging?.next?.after;
      await sleep(SEARCH_DELAY_MS);
    } while (after);
    process.stdout.write(`\r  Searched ${Math.min(i + SEARCH_CHUNK, quoteNums.length)}/${quoteNums.length} quotes, deals matched for ${dealsByQuote.size}`);
  }
  console.log('\n');

  // 4. Plan
  const report = [];
  const updates = [];
  const counts = { update: 0, already_set: 0, different_kept: 0, no_deal: 0, multi_deal: 0 };
  for (const q of quoteNums) {
    const target = wanted.get(q);
    const deals = dealsByQuote.get(q) || [];
    if (!deals.length) {
      counts.no_deal++;
      report.push([q, '', '', '', target, 'NO_DEAL_IN_HUBSPOT']);
      continue;
    }
    if (deals.length > 1) counts.multi_deal++;
    for (const d of deals) {
      let action;
      if (d.current === target) { action = 'ALREADY_SET'; counts.already_set++; }
      else if (d.current && !overwrite) { action = 'DIFFERENT_KEPT'; counts.different_kept++; }
      else { action = apply ? 'UPDATED' : 'WOULD_UPDATE'; counts.update++; updates.push({ id: d.id, properties: { [property]: toHubspotDate(target) } }); }
      report.push([q, d.id, d.dealname, d.current || '', target, deals.length > 1 ? `${action} (MULTI_DEAL)` : action]);
    }
  }

  // 5. Apply
  let failed = 0;
  if (apply && updates.length) {
    for (let i = 0; i < updates.length; i += UPDATE_CHUNK) {
      const batch = updates.slice(i, i + UPDATE_CHUNK);
      try {
        await hs('POST', '/crm/v3/objects/deals/batch/update', { inputs: batch });
      } catch (e) {
        failed += batch.length;
        const ids = new Set(batch.map((b) => b.id));
        for (const r of report) if (ids.has(r[1]) && r[5].startsWith('UPDATED')) r[5] = `FAILED: ${e.message.slice(0, 200)}`;
        console.error(`  Batch ${i / UPDATE_CHUNK + 1} failed: ${e.message}`);
      }
      process.stdout.write(`\r  Updated ${Math.min(i + UPDATE_CHUNK, updates.length)}/${updates.length} deals`);
      await sleep(150);
    }
    console.log('\n');
  }

  // 6. Report
  const reportPath = path.resolve(flags.report || `backfill_datequoted_report_${new Date().toISOString().replace(/[:.]/g, '-')}.csv`);
  const header = ['QuoteNum', 'DealId', 'DealName', 'CurrentValue', 'EpicorDateQuoted', 'Action'];
  fs.writeFileSync(reportPath, [header, ...report].map((r) => r.map(csvEscape).join(',')).join('\n'));

  console.log('Summary');
  console.log(`  ${apply ? 'Updated' : 'Would update'}:        ${counts.update - failed}`);
  if (failed) console.log(`  FAILED:               ${failed}`);
  console.log(`  Already correct:      ${counts.already_set}`);
  console.log(`  Different (kept):     ${counts.different_kept}${counts.different_kept ? '  -> review, rerun with --overwrite if Epicor should win' : ''}`);
  console.log(`  Quote with no deal:   ${counts.no_deal}`);
  console.log(`  Quotes on >1 deal:    ${counts.multi_deal}`);
  console.log(`\nReport: ${reportPath}`);
  if (!apply) console.log('\nDRY RUN - nothing was written. Re-run with --apply to update HubSpot.');
}

main().catch((e) => {
  console.error(`FATAL: ${e.message}`);
  process.exit(1);
});
