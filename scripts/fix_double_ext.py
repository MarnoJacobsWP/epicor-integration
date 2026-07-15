#!/usr/bin/env python3
"""
Fast standalone fix for doubled ".pdf.pdf" filenames in HubSpot.

Walks every deal that has a quote_pdf / sales_order_pdf, looks up each file, and
if its name renders as "...pdf.pdf" it PATCHes the name so the extension appears
once. HubSpot only — needs no Epicor, so it runs from any machine.

Why the fix is "set name to the stem": HubSpot stores `name` WITHOUT the
extension and builds the path as `name + "." + extension`. A doubled file is
stored as name="Quote-170240.pdf" / extension="pdf" -> path ".../Quote-170240.pdf.pdf".
Setting name to the stem "Quote-170240" makes HubSpot append ".pdf" exactly once.
(Sending "Quote-170240.pdf" as the name is a silent no-op.)

Only stdlib is used (urllib + threads) so there is nothing to pip install.

Usage:
    python scripts/fix_double_ext.py                 # DRY RUN (report only)
    python scripts/fix_double_ext.py --apply         # rename the doubled files
    python scripts/fix_double_ext.py --apply --workers 16
    python scripts/fix_double_ext.py --limit 100     # cap files (testing)

Reads HUBSPOT_ACCESS_TOKEN from .env in the project root (or the environment).
"""

import argparse
import json
import os
import re
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from threading import Lock

BASE = "https://api.hubapi.com"
FILE_PROPERTIES = ["quote_pdf", "sales_order_pdf"]
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

_ssl_ctx = ssl.create_default_context()


def load_env(path):
    env = {}
    if not os.path.exists(path):
        return env
    with open(path, encoding="utf-8") as fh:
        for raw in fh:
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, val = line.split("=", 1)
            key, val = key.strip(), val.strip()
            if (val.startswith('"') and val.endswith('"')) or (val.startswith("'") and val.endswith("'")):
                val = val[1:-1]
            else:
                val = re.sub(r"\s+#.*$", "", val).strip()
            env[key] = val
    return env


def api(method, url, token, body=None, params=None):
    """One HubSpot request with retry on 429/5xx (honors Retry-After)."""
    if params:
        url += "?" + urllib.parse.urlencode(params)
    data = json.dumps(body).encode() if body is not None else None
    for attempt in range(1, 7):
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("Authorization", f"Bearer {token}")
        if data is not None:
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=30, context=_ssl_ctx) as resp:
                payload = resp.read()
                return json.loads(payload) if payload else {}
        except urllib.error.HTTPError as err:
            if err.code == 429 or 500 <= err.code < 600:
                retry_after = err.headers.get("Retry-After")
                time.sleep(float(retry_after) if retry_after else 0.4 * 2 ** (attempt - 1))
                continue
            detail = err.read().decode("utf-8", "ignore")[:200]
            raise RuntimeError(f"HTTP {err.code}: {detail}") from None
        except urllib.error.URLError:
            if attempt < 6:
                time.sleep(0.4 * 2 ** (attempt - 1))
                continue
            raise
    raise RuntimeError("retries exhausted")


def deal_file_ids(token):
    """Every fileId referenced by quote_pdf / sales_order_pdf across all deals."""
    ids = set()
    after = None
    pages = 0
    while True:
        body = {
            "filterGroups": [{"filters": [{"propertyName": p, "operator": "HAS_PROPERTY"}]} for p in FILE_PROPERTIES],
            "properties": FILE_PROPERTIES,
            "limit": 100,
        }
        if after:
            body["after"] = after
        data = api("POST", f"{BASE}/crm/v3/objects/deals/search", token, body=body)
        for deal in data.get("results", []):
            props = deal.get("properties") or {}
            for prop in FILE_PROPERTIES:
                val = props.get(prop)
                if val not in (None, ""):
                    ids.add(str(val).strip())
        pages += 1
        after = ((data.get("paging") or {}).get("next") or {}).get("after")
        if not after:
            break
    print(f"Enumerated {len(ids)} unique fileId(s) across {pages} deal page(s).", file=sys.stderr)
    return sorted(ids)


def stem_for(file_obj):
    """The corrected `name` value if the file's path is doubled, else None."""
    path = file_obj.get("path") or ""
    basename = path.split("/")[-1] if path else ""
    if not basename:
        return None
    corrected = re.sub(r"(?:\.pdf){2,}$", ".pdf", basename, flags=re.IGNORECASE)
    if corrected == basename:
        return None  # not doubled
    ext = file_obj.get("extension") or ""
    if ext:
        return re.sub(r"\." + re.escape(ext) + r"$", "", corrected, flags=re.IGNORECASE)
    return corrected


def main():
    parser = argparse.ArgumentParser(description="Fix doubled .pdf.pdf HubSpot filenames.")
    parser.add_argument("--apply", action="store_true", help="actually rename (default is a dry run)")
    parser.add_argument("--workers", type=int, default=12, help="concurrent requests (default 12)")
    parser.add_argument("--limit", type=int, default=0, help="cap number of files processed (0 = all)")
    args = parser.parse_args()

    config = {**os.environ, **load_env(os.path.join(PROJECT_ROOT, ".env"))}
    token = config.get("HUBSPOT_ACCESS_TOKEN")
    if not token:
        print("ERROR: HUBSPOT_ACCESS_TOKEN not found in .env or environment.", file=sys.stderr)
        sys.exit(1)

    mode = "APPLYING" if args.apply else "DRY RUN"
    print(f"\n=== fix_double_ext ({mode}) — workers={args.workers} ===", file=sys.stderr)

    file_ids = deal_file_ids(token)
    if args.limit:
        file_ids = file_ids[: args.limit]

    print(f"Checking {len(file_ids)} file(s)...", file=sys.stderr)

    lock = Lock()
    stats = {"checked": 0, "renamed": 0, "skipped": 0, "errors": 0}
    fixes = []
    errors = []

    def process(file_id):
        try:
            file_obj = api("GET", f"{BASE}/files/v3/files/{file_id}", token)
            stem = stem_for(file_obj)
            if not stem:
                with lock:
                    stats["skipped"] += 1
                    stats["checked"] += 1
                return
            basename = (file_obj.get("path") or "").split("/")[-1]
            if args.apply:
                api("PATCH", f"{BASE}/files/v3/files/{file_id}", token, body={"name": stem})
            with lock:
                stats["renamed"] += 1
                stats["checked"] += 1
                if len(fixes) < 200:
                    fixes.append({"fileId": file_id, "from": basename, "to": f"{stem}.{file_obj.get('extension', 'pdf')}"})
            print(f"  {file_id} \"{basename}\" -> name=\"{stem}\"{'' if args.apply else ' (dry-run)'}", file=sys.stderr)
        except Exception as exc:  # noqa: BLE001 - report and continue
            with lock:
                stats["errors"] += 1
                stats["checked"] += 1
                if len(errors) < 50:
                    errors.append({"fileId": file_id, "error": str(exc)})
            print(f"  {file_id} ERROR: {exc}", file=sys.stderr)

    start = time.time()
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = [pool.submit(process, fid) for fid in file_ids]
        for done, _ in enumerate(as_completed(futures), 1):
            if done % 200 == 0:
                print(f"  ...{done}/{len(file_ids)} ({stats['renamed']} doubled so far)", file=sys.stderr)

    elapsed = round(time.time() - start, 1)
    verb = "renamed" if args.apply else "would-rename"
    print(
        f"\nDONE in {elapsed}s: {stats['renamed']} {verb}, {stats['skipped']} ok, {stats['errors']} errors.",
        file=sys.stderr,
    )
    print(json.dumps({"mode": mode, **stats, "elapsedSeconds": elapsed, "fixes": fixes, "errors": errors}, indent=2))


if __name__ == "__main__":
    main()
