#!/usr/bin/env python3
"""Nightly sync: pull all products from Unleashed and regenerate qis_products.json.

Reads credentials from environment variables (set as GitHub Actions secrets):
  UNLEASHED_API_ID
  UNLEASHED_API_KEY

Output shape matches what the quoting tool reads:
  [{"sku": str, "desc": str, "cost": float, "sell": float}, ...]

Safety guards:
  - Aborts (non-zero exit) if the API returns suspiciously few products,
    so a bad response can never wipe the product file.
  - Skips obsolete products and products with no cost AND no sell price.
Uses Python standard library only - nothing to install.
"""
import base64
import hashlib
import hmac
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

BASE_URL = "https://api.unleashedsoftware.com"
OUTPUT_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "qis_products.json")
PAGE_SIZE = 1000
MIN_EXPECTED_PRODUCTS = 500  # abort if fewer than this come back (guard against bad API response)


def api_get(endpoint, api_id, api_key, params=None, page=None):
    """Signed GET request to the Unleashed API. Returns parsed JSON."""
    path = "/" + endpoint.strip("/")
    if page:
        path += "/Page/%d" % int(page)
    clean = {k: v for k, v in (params or {}).items() if v not in (None, "")}
    # Unleashed verifies the HMAC against the decoded query string, so characters
    # like commas must not be percent-encoded or the signature check fails (403).
    qs = urllib.parse.urlencode(clean, safe=",:", quote_via=urllib.parse.quote)
    sig = base64.b64encode(
        hmac.new(api_key.encode(), qs.encode(), hashlib.sha256).digest()
    ).decode()
    url = BASE_URL + path + ("?" + qs if qs else "")
    req = urllib.request.Request(url, headers={
        "api-auth-id": api_id,
        "api-auth-signature": sig,
        "Accept": "application/json",
        "Content-Type": "application/json",
    })
    last_err = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                return json.loads(resp.read().decode())
        except urllib.error.HTTPError as e:
            body = e.read().decode(errors="replace")
            raise SystemExit("Unleashed API error HTTP %d: %s" % (e.code, body[:500]))
        except Exception as e:  # transient network error - retry
            last_err = e
            time.sleep(5 * (attempt + 1))
    raise SystemExit("Request failed after retries: %s" % last_err)


def to_number(value):
    try:
        n = float(value)
        return round(n, 4)
    except (TypeError, ValueError):
        return 0.0


def main():
    api_id = os.environ.get("UNLEASHED_API_ID", "").strip()
    api_key = os.environ.get("UNLEASHED_API_KEY", "").strip()
    if not api_id or not api_key:
        raise SystemExit("Missing UNLEASHED_API_ID / UNLEASHED_API_KEY environment variables.")

    products = []
    page = 1
    while True:
        data = api_get("Products", api_id, api_key,
                       params={"pageSize": PAGE_SIZE}, page=page)
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
                sell = to_number(p.get("SellPriceTier1", {}).get("Value")
                                 if isinstance(p.get("SellPriceTier1"), dict)
                                 else p.get("SellPriceTier1"))
            if cost == 0.0 and sell == 0.0:
                continue  # matches original build: exclude products with no pricing at all
            products.append({"sku": sku, "desc": desc, "cost": cost, "sell": sell})

        pagination = data.get("Pagination", {})
        total_pages = int(pagination.get("NumberOfPages") or 1)
        print("Fetched page %d of %d (%d items)" % (page, total_pages, len(items)))
        if page >= total_pages:
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
