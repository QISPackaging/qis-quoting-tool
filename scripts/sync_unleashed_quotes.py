#!/usr/bin/env python3
"""Hourly sync: pull Sales Quotes from Unleashed (via the connector) into the
quoting tool's Supabase database so they appear in the Saved Quotes tab.

Design (v1 - deliberately conservative):
  - INSERT-ONLY. Quotes already in Supabase (matched by quote_number) are never
    touched, so costs/notes/follow-ups added by reps are never overwritten.
  - Only quotes dated on/after SYNC_FROM (default below) are imported.
  - Costs are filled from qis_products.json (kept fresh by the product sync).
    Unknown SKUs get cost 0 and are listed in the quote's notes for the rep.
  - Deleted quotes in Unleashed are skipped entirely.

Credentials:
  - UNLEASHED_CONNECTOR_URL from environment (GitHub Actions secret).
  - Supabase URL + anon key are read from ../index.html so they can never
    drift out of sync with the tool itself.
"""
import json
import os
import re
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
INDEX_HTML = os.path.join(HERE, "..", "index.html")
PRODUCTS_JSON = os.path.join(HERE, "..", "qis_products.json")

SYNC_FROM = os.environ.get("SYNC_QUOTES_FROM", "2026-07-03")  # only import quotes on/after this date
MAX_INSERTS_PER_RUN = 300  # safety cap
REPS = ["Allegra", "Jack", "Liam", "Luke", "Maddy", "Rick", "Will"]

STATUS_MAP = {
    "open": "pending",
    "draft": "pending",
    "pending": "pending",
    "accepted": "won",
    "completed": "won",
    "declined": "lost",
    "expired": "withdrawn",
}

_session_id = None
_msg_id = 0

TRANSIENT_MARKERS = ("429", "500", "502", "503", "504", "520", "521", "522", "523", "524",
                     "timed out", "timeout", "temporarily")


# ---------- MCP client (same pattern as the product sync) ----------

def _post(url, payload):
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 QIS-QuoteSync/1.0",
    }
    if _session_id:
        headers["mcp-session-id"] = _session_id
    req = urllib.request.Request(url, data=json.dumps(payload).encode(), headers=headers)
    last_err = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                body = resp.read().decode()
                ctype = resp.headers.get("Content-Type", "")
                if not body.strip():
                    return None, resp.headers
                if "text/event-stream" in ctype:
                    return _parse_sse(body), resp.headers
                return json.loads(body), resp.headers
        except urllib.error.HTTPError as e:
            detail = e.read().decode(errors="replace")[:500]
            raise SystemExit("Connector returned HTTP %d: %s" % (e.code, detail))
        except Exception as e:
            last_err = e
            time.sleep(5 * (attempt + 1))
    raise SystemExit("Request failed after retries: %s" % last_err)


def _parse_sse(body):
    result = None
    for line in body.splitlines():
        line = line.strip()
        if line.startswith("data:"):
            chunk = line[5:].strip()
            if chunk:
                try:
                    result = json.loads(chunk)
                except json.JSONDecodeError:
                    pass
    if result is None:
        raise SystemExit("Could not parse SSE response from connector.")
    return result


def rpc(url, method, params=None, is_notification=False):
    global _msg_id, _session_id
    payload = {"jsonrpc": "2.0", "method": method}
    if params is not None:
        payload["params"] = params
    if not is_notification:
        _msg_id += 1
        payload["id"] = _msg_id
    data, headers = _post(url, payload)
    sid = headers.get("mcp-session-id") or headers.get("Mcp-Session-Id")
    if sid:
        _session_id = sid
    if is_notification:
        return None
    if data is None:
        raise SystemExit("Empty response from connector for %s" % method)
    if "error" in data:
        raise SystemExit("Connector error on %s: %s" % (method, data["error"]))
    return data.get("result", {})


def call_tool(url, name, arguments):
    attempts = 4
    for attempt in range(1, attempts + 1):
        result = rpc(url, "tools/call", {"name": name, "arguments": arguments})
        text = ""
        for block in result.get("content", []):
            if block.get("type") == "text":
                text += block.get("text", "")
        if result.get("isError"):
            lowered = text.lower()
            if any(m in lowered for m in TRANSIENT_MARKERS) and attempt < attempts:
                wait = 15 * attempt
                print("Transient error on '%s' (attempt %d/%d) -- retrying in %ds"
                      % (name, attempt, attempts, wait))
                time.sleep(wait)
                continue
            return None, text  # caller decides what a hard error means
        try:
            return json.loads(text), None
        except json.JSONDecodeError:
            return None, "non-JSON response: " + text[:300]
    return None, "failed after %d attempts" % attempts


# ---------- Unleashed helpers ----------

BRISBANE_OFFSET_SECONDS = 10 * 3600  # AEST, UTC+10 - Queensland has no daylight saving


def parse_unleashed_date(value):
    """Unleashed returns dates like '/Date(1719878400000)/' or ISO strings.

    Timestamps are converted in Brisbane time (UTC+10). Without this, a quote
    dated today in Unleashed can parse as yesterday and be wrongly skipped."""
    if not value:
        return None
    if isinstance(value, str):
        m = re.search(r"/Date\((\-?\d+)", value)
        if m:
            ms = int(m.group(1))
            t = time.gmtime(ms / 1000 + BRISBANE_OFFSET_SECONDS)
            return "%04d-%02d-%02d" % (t.tm_year, t.tm_mon, t.tm_mday)
        m = re.match(r"(\d{4}-\d{2}-\d{2})", value)
        if m:
            return m.group(1)
    return None


def get_lines(q):
    """Unleashed's field is SalesQuoteLines (QuoteLines kept as fallback)."""
    return q.get("SalesQuoteLines") or q.get("QuoteLines") or []


def num(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def map_rep(sales_person):
    name = ""
    if isinstance(sales_person, dict):
        name = sales_person.get("FullName") or sales_person.get("Email") or ""
    elif isinstance(sales_person, str):
        name = sales_person
    name = name.lower()
    for rep in REPS:
        if rep.lower() in name:
            return rep
    return None


def quote_to_row(q, cost_lookup):
    status_raw = (q.get("QuoteStatus") or "").strip().lower()
    if status_raw == "deleted":
        return None
    status = STATUS_MAP.get(status_raw, "pending")

    lines = []
    missing_cost = []
    total_sell = 0.0
    total_cost = 0.0
    for i, ln in enumerate(get_lines(q), start=1):
        prod = ln.get("Product") or {}
        sku = (prod.get("ProductCode") or "").strip()
        desc = (prod.get("ProductDescription") or ln.get("LineComments") or "").strip()
        qty = num(ln.get("QuoteQuantity") or ln.get("OrderQuantity"))
        # Effective unit sell: LineTotal/qty honours any discount on the line
        line_total = num(ln.get("LineTotal"))
        sell = round(line_total / qty, 4) if (line_total > 0 and qty > 0) else num(ln.get("UnitPrice"))
        # Cost: Unleashed's own line cost snapshot first, product file second
        cost = num(ln.get("UnitCost"))
        if cost == 0.0:
            cost = cost_lookup.get(sku, 0.0)
        if sku and cost == 0.0:
            missing_cost.append(sku)
        lines.append({"id": i, "sku": sku, "desc": desc,
                      "qty": qty, "cost": cost, "sell": sell})
        total_sell += qty * sell
        total_cost += qty * cost

    if not lines:
        return None  # caller logs the reason and the fields actually seen

    gp = ((total_sell - total_cost) / total_sell * 100.0) if total_sell > 0 else 0.0
    notes = "Imported from Unleashed."
    if missing_cost:
        notes += " Cost missing for: " + ", ".join(sorted(set(missing_cost))[:20])

    customer = q.get("Customer") or {}
    return {
        "business_name": (customer.get("CustomerName") or "").strip() or None,
        "customer": None,
        "phone": None,
        "email": None,
        "rep": map_rep(q.get("SalesPerson")),
        "quote_number": (q.get("QuoteNumber") or "").strip() or None,
        "quote_date": parse_unleashed_date(q.get("QuoteDate")),
        "expiry_date": parse_unleashed_date(q.get("ExpiryDate")),
        "status": status,
        "freight": 0,
        "freight_in_gp": False,
        "sell_price": round(total_sell, 2),
        "cost_price": round(total_cost, 2),
        "gp_percent": round(gp, 2),
        "gp_percent_ex_freight": round(gp, 2),
        "gross_profit": round(total_sell - total_cost, 2),
        "line_items": json.dumps(lines),
        "followups": "[]",
        "notes": notes,
        "source": "unleashed",
    }


# ---------- Supabase ----------

def read_supabase_creds():
    html = open(INDEX_HTML, encoding="utf-8", errors="replace").read()
    surl = re.search(r"const SURL='([^']+)'", html)
    skey = re.search(r"const SKEY='([^']+)'", html)
    if not surl or not skey:
        raise SystemExit("Could not read SURL/SKEY from index.html - has the tool changed?")
    return surl.group(1), skey.group(1)


def supabase_request(surl, skey, method, path, body=None):
    req = urllib.request.Request(
        surl + path,
        data=json.dumps(body).encode() if body is not None else None,
        method=method,
        headers={
            "apikey": skey,
            "Authorization": "Bearer " + skey,
            "Content-Type": "application/json",
            "Prefer": "return=minimal",
        })
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            raw = resp.read().decode()
            return json.loads(raw) if raw.strip() else None
    except urllib.error.HTTPError as e:
        raise RuntimeError("Supabase %s %s -> HTTP %d: %s"
                           % (method, path, e.code, e.read().decode(errors="replace")[:300]))


def existing_quote_numbers(surl, skey):
    rows = supabase_request(surl, skey, "GET",
                            "/rest/v1/quotes?select=quote_number&limit=10000") or []
    return {r.get("quote_number") for r in rows if r.get("quote_number")}


# ---------- main ----------

def fetch_quotes(url):
    """Fetch quotes via the connector's list_quotes tool (service token).

    Tries with a startDate filter first; if the deployed tool doesn't accept
    that argument, falls back to unfiltered paging - the client-side date
    check in main() keeps only quotes on/after SYNC_FROM either way."""
    for args_base in ({"startDate": SYNC_FROM, "pageSize": 200},
                      {"pageSize": 200},
                      {}):
        all_items, page = [], 1
        bad_args = False
        while True:
            args = dict(args_base)
            args["page"] = page
            data, err = call_tool(url, "list_quotes", args)
            if err is not None:
                lowered = err.lower()
                if any(k in lowered for k in ("unknown", "invalid", "unexpected", "argument", "parameter", "400")):
                    print("list_quotes rejected args %s (%s) - retrying simpler" % (args_base, err[:120]))
                    bad_args = True
                    break
                raise SystemExit("Connector error from list_quotes: %s" % err[:400])
            items = data.get("Items", [])
            all_items.extend(items)
            total_pages = int((data.get("Pagination") or {}).get("NumberOfPages") or 1)
            print("Fetched quotes page %d of %d (%d items)" % (page, total_pages, len(items)))
            if page >= total_pages or not items:
                break
            page += 1
            time.sleep(3)
        if not bad_args:
            return all_items
    raise SystemExit("list_quotes rejected every argument combination - ask Liam what "
                     "parameters his list_quotes tool accepts.")


def fetch_quote_detail(url, qnum):
    """The Quotes list endpoint returns quotes WITHOUT line items. Re-query
    filtered by quote number, which returns full detail on some accounts.
    Returns the quote dict (with lines if available) or None."""
    data, err = call_tool(url, "list_quotes", {"quoteNumber": qnum, "pageSize": 200})
    if err is not None:
        print("Detail lookup failed for %s: %s" % (qnum, err[:200]))
        return None
    for item in data.get("Items", []):
        if (item.get("QuoteNumber") or "").strip() == qnum:
            return item
    return None


def main():
    url = os.environ.get("UNLEASHED_CONNECTOR_URL", "").strip()
    if not url:
        raise SystemExit("Missing UNLEASHED_CONNECTOR_URL environment variable.")

    surl, skey = read_supabase_creds()
    cost_lookup = {p["sku"]: p.get("cost", 0.0) for p in json.load(open(PRODUCTS_JSON))}
    print("Loaded %d product costs; syncing quotes dated on/after %s" % (len(cost_lookup), SYNC_FROM))

    rpc(url, "initialize", {
        "protocolVersion": "2025-03-26",
        "capabilities": {},
        "clientInfo": {"name": "qis-quote-sync", "version": "1.0"},
    })
    rpc(url, "notifications/initialized", {}, is_notification=True)

    quotes = fetch_quotes(url)
    print("Unleashed returned %d quotes" % len(quotes))

    existing = existing_quote_numbers(surl, skey)
    print("Supabase already has %d quote numbers" % len(existing))

    inserted, skipped, failed = 0, 0, 0
    no_line_quotes = []
    for q in quotes:
        qnum = (q.get("QuoteNumber") or "").strip()
        if not qnum:
            print("Skipped: quote has no quote number")
            skipped += 1
            continue
        if (q.get("QuoteStatus") or "").strip().lower() == "deleted":
            print("Skipped %s: status is Deleted" % qnum)
            skipped += 1
            continue
        if qnum in existing:
            print("Skipped %s: already in the tool" % qnum)
            skipped += 1
            continue
        qdate = parse_unleashed_date(q.get("QuoteDate"))
        if qdate and qdate < SYNC_FROM:
            print("Skipped %s: dated %s, before sync start %s" % (qnum, qdate, SYNC_FROM))
            skipped += 1
            continue

        detail = q if get_lines(q) else fetch_quote_detail(url, qnum)
        if detail is None or not get_lines(detail):
            print("Skipped %s: quote has no line items in Unleashed" % qnum)
            # Premise check: show what the response ACTUALLY contains
            print("  fields seen: %s" % ", ".join(sorted((detail or q).keys())[:25]))
            no_line_quotes.append(qnum)
            skipped += 1
            continue

        row = quote_to_row(detail, cost_lookup)
        if row is None:
            print("Skipped %s: could not build row from detail" % qnum)
            skipped += 1
            continue
        if inserted >= MAX_INSERTS_PER_RUN:
            print("Safety cap reached (%d inserts) - remaining quotes next run." % MAX_INSERTS_PER_RUN)
            break
        try:
            supabase_request(surl, skey, "POST", "/rest/v1/quotes", row)
            inserted += 1
            print("Inserted %s (%s, %s, GP %.1f%%)" % (
                row["quote_number"], row["business_name"], row["status"], row["gp_percent"]))
        except RuntimeError as e:
            failed += 1
            print("FAILED %s: %s" % (row["quote_number"], e))

    print("Done: %d inserted, %d skipped, %d failed." % (inserted, skipped, failed))
    if no_line_quotes:
        print("Note: %d quote(s) had no line items and were skipped: %s"
              % (len(no_line_quotes), ", ".join(no_line_quotes)))
    if failed:
        raise SystemExit("%d quote inserts failed - see log above." % failed)


if __name__ == "__main__":
    main()
