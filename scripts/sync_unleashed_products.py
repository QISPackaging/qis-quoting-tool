#!/usr/bin/env python3
"""Nightly sync via Liam's Unleashed MCP connector.

Pulls all products through the connector (the API keys stay inside the
connector - this script never sees them) and regenerates qis_products.json.

Reads one environment variable (set as a GitHub Actions secret):
  UNLEASHED_CONNECTOR_URL   e.g. https://qis-unleashed-connector.....workers.dev/mcp/<token>

Output shape matches what the quoting tool reads:
  [{"sku": str, "desc": str, "cost": float, "sell": float}, ...]

Safety guards:
  - Aborts (non-zero exit) if fewer than MIN_EXPECTED_PRODUCTS come back,
    so a bad response can never wipe the product file.
  - Skips obsolete products and products with no cost AND no sell price.
Uses Python standard library only - nothing to install.
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request

OUTPUT_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "qis_products.json")
PAGE_SIZE = 1000
MIN_EXPECTED_PRODUCTS = 500

_session_id = None
_msg_id = 0


def _post(url, payload, extra_headers=None):
    """POST a JSON-RPC message. Returns (parsed JSON or None, response headers)."""
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        # Cloudflare's bot protection (error 1010) bans Python's default
        # signature - identify as a regular client instead.
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 QIS-ProductSync/1.0",
    }
    if _session_id:
        headers["mcp-session-id"] = _session_id
    if extra_headers:
        headers.update(extra_headers)
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
    """Extract the last JSON 'data:' payload from an SSE response body."""
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
    result = rpc(url, "tools/call", {"name": name, "arguments": arguments})
    content = result.get("content", [])
    text = ""
    for block in content:
        if block.get("type") == "text":
            text += block.get("text", "")
    if result.get("isError"):
        raise SystemExit("Connector tool '%s' reported an error: %s" % (name, text[:500]))
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        raise SystemExit("Tool '%s' returned non-JSON: %s" % (name, text[:300]))


def to_number(value):
    try:
        return round(float(value), 4)
    except (TypeError, ValueError):
        return 0.0


def main():
    url = os.environ.get("UNLEASHED_CONNECTOR_URL", "").strip()
    if not url:
        raise SystemExit("Missing UNLEASHED_CONNECTOR_URL environment variable.")

    rpc(url, "initialize", {
        "protocolVersion": "2025-03-26",
        "capabilities": {},
        "clientInfo": {"name": "qis-product-sync", "version": "1.0"},
    })
    rpc(url, "notifications/initialized", {}, is_notification=True)

    products = []
    page = 1
    while True:
        data = call_tool(url, "list_products", {"pageSize": PAGE_SIZE, "page": page})
        items = data.get("Items", [])
        for p in items:
            if p.get("Obsolete"):
                continue
            sku = (p.get("ProductCode") or "").strip()
            desc = (p.get("ProductDescription") or "").strip()
            if not sku:
                continue
            cost = to_number(p.get("AverageLandPrice"))
            sell = to_number(p.get("DefaultSellPrice"))
            if sell == 0.0:
                tier = p.get("SellPriceTier1")
                sell = to_number(tier.get("Value") if isinstance(tier, dict) else tier)
            if cost == 0.0 and sell == 0.0:
                continue
            products.append({"sku": sku, "desc": desc, "cost": cost, "sell": sell})

        pagination = data.get("Pagination", {}) or {}
        total_pages = int(pagination.get("NumberOfPages") or 1)
        print("Fetched page %d of %d (%d items)" % (page, total_pages, len(items)))
        if page >= total_pages or not items:
            break
        page += 1

    if len(products) < MIN_EXPECTED_PRODUCTS:
        raise SystemExit(
            "Guard triggered: only %d products returned (expected at least %d). "
            "NOT overwriting qis_products.json." % (len(products), MIN_EXPECTED_PRODUCTS))

    products.sort(key=lambda x: x["sku"])
    out_path = os.path.normpath(OUTPUT_FILE)
    with open(out_path, "w") as f:
        json.dump(products, f, separators=(",", ":"))
    print("Wrote %d products to %s" % (len(products), out_path))


if __name__ == "__main__":
    main()
