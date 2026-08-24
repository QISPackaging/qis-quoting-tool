const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const products = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'qis_products.json'), 'utf8'));
const appPath = 'file://' + path.join(__dirname, '..', 'index.html');

function mockQuotesApi(page, state = { quotes: [] }) {
  const quotes = Array.isArray(state) ? state : state.quotes;

  return page.route('**/rest/v1/quotes*', async route => {
    const method = route.request().method();
    const url = new URL(route.request().url());

    if (method === 'GET') {
      const statusFilter = url.searchParams.get('status')?.replace('eq.', '');
      let filtered = statusFilter ? quotes.filter(q => q.status === statusFilter) : quotes;
      if (url.searchParams.get('deleted_at') === 'is.null') filtered = filtered.filter(q => !q.deleted_at);
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(filtered),
      });
    }

    if (method === 'POST') {
      const payload = JSON.parse(route.request().postData() || '{}');
      const stored = {
        id: Date.now(),
        created_at: new Date().toISOString(),
        ...payload,
      };
      quotes.push(stored);
      return route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify([stored]),
      });
    }

    if (method === 'PATCH') {
      const id = Number(url.searchParams.get('id')?.replace('eq.', ''));
      const payload = JSON.parse(route.request().postData() || '{}');
      const index = quotes.findIndex(item => item.id === id);
      if (index >= 0) quotes[index] = { ...quotes[index], ...payload };
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(index >= 0 ? [quotes[index]] : []),
      });
    }

    if (method === 'DELETE') {
      const id = Number(url.searchParams.get('id')?.replace('eq.', ''));
      const index = quotes.findIndex(item => item.id === id);
      if (index >= 0) quotes.splice(index, 1);
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
    }

    return route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Unhandled mock request' }),
    });
  });
}

test.beforeEach(async ({ page }) => {
  await page.route('**/qis_products.json', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(products),
    })
  );
});

test('saves a quote and shows it in the saved quotes list', async ({ page }) => {
  const state = { quotes: [] };
  await mockQuotesApi(page, state);

  await page.goto(appPath);
  await page.locator('#business-name').fill('Acme Packaging');
  await page.locator('#customer').fill('Sam Patel');
  await page.locator('#rep').selectOption('Jack');
  await page.locator('#status').selectOption('pending');
  await page.locator('#quote-number').fill('SQ-00000001');

  await page.locator('#line-items-body input[data-field="sku"]').first().fill('TESTSKU');
  await page.locator('#line-items-body input[data-field="desc"]').first().fill('Test carton');
  await page.locator('#line-items-body input[data-field="qty"]').first().fill('2');
  await page.locator('#line-items-body input[data-field="cost"]').first().fill('100');
  await page.locator('#line-items-body input[data-field="sell"]').first().fill('150');

  await page.locator('#save-btn').click();

  await expect(page.locator('#toast')).toContainText('Quote saved successfully');

  await page.locator('button.tab', { hasText: 'Saved quotes' }).click();
  await expect(page.locator('table.quotes-table')).toContainText('Acme Packaging');
  expect(state.quotes.length).toBe(1);
});

test('persists internal notes when saving and editing a quote', async ({ page }) => {
  const state = { quotes: [] };
  await mockQuotesApi(page, state);

  await page.goto(appPath);
  await page.locator('#business-name').fill('Internal Notes Co');
  await page.locator('#customer').fill('Morgan');
  await page.locator('#rep').selectOption('Jack');
  await page.locator('#status').selectOption('pending');
  await page.locator('#quote-number').fill('SQ-00000002');
  await page.locator('#internal-notes').fill('This quote needs finance approval');

  await page.locator('#line-items-body input[data-field="sku"]').first().fill('TESTSKU');
  await page.locator('#line-items-body input[data-field="desc"]').first().fill('Test carton');
  await page.locator('#line-items-body input[data-field="qty"]').first().fill('2');
  await page.locator('#line-items-body input[data-field="cost"]').first().fill('100');
  await page.locator('#line-items-body input[data-field="sell"]').first().fill('150');

  await page.locator('#save-btn').click();
  await expect(page.locator('#toast')).toContainText('Quote saved successfully');

  await page.locator('button.tab', { hasText: 'Saved quotes' }).click();
  await page.locator('table.quotes-table tbody tr', { hasText: 'Internal Notes Co' }).locator('button', { hasText: 'Edit' }).click();

  await expect(page.locator('#internal-notes')).toHaveValue('This quote needs finance approval');
});

test('saved quotes table fits within the page width without horizontal scrolling', async ({ page }) => {
  const initialQuotes = [
    {
      id: 501,
      business_name: 'Wide Table Co',
      customer: 'A long contact name for layout testing',
      rep: 'Jack',
      quote_number: 'SQ-00000333',
      status: 'pending',
      quote_date: '2026-06-10',
      freight: 0,
      freight_in_gp: false,
      sell_price: 200,
      gp_percent: 40,
      line_items: '[]',
      followups: '[]',
      created_at: '2026-06-10T00:00:00Z',
    },
  ];
  await mockQuotesApi(page, { quotes: initialQuotes });

  await page.goto(appPath);
  await page.locator('button.tab', { hasText: 'Saved quotes' }).click();
  const fits = await page.locator('.quotes-table').evaluate(table => {
    const wrapper = table.parentElement;
    return wrapper.scrollWidth <= wrapper.clientWidth;
  });
  expect(fits).toBe(true);
});

test('restyle: active tab gets the gold underline and header brand renders', async ({ page }) => {
  await mockQuotesApi(page);
  await page.goto(appPath);

  await expect(page.locator('.app-header .brand img[alt="QIS Packaging"]')).toHaveAttribute('src', 'qis-logo.png');
  const active = page.locator('.tab.active');
  await expect(active).toHaveText('Calculator');
  const borderColor = await active.evaluate(el => getComputedStyle(el).borderBottomColor);
  // --accent #B98A3C === rgb(185, 138, 60)
  expect(borderColor).toBe('rgb(185, 138, 60)');

  // Only one tab set exists (no duplicate that would break locators).
  await expect(page.locator('button.tab', { hasText: 'Saved quotes' })).toHaveCount(1);
});

test('deletes a quote after confirmation from the saved quotes list', async ({ page }) => {
  const state = {
    quotes: [
      {
        id: 201,
        business_name: 'Delete Co',
        customer: 'Jordan',
        rep: 'Jack',
        quote_number: 'SQ-00000444',
        status: 'pending',
        quote_date: '2026-06-10',
        freight: 0,
        freight_in_gp: false,
        sell_price: 250,
        gp_percent: 25,
        line_items: '[]',
        followups: '[]',
        created_at: '2026-06-10T00:00:00Z',
      },
    ],
  };
  await mockQuotesApi(page, state);

  await page.goto(appPath);
  await page.locator('button.tab', { hasText: 'Saved quotes' }).click();
  await page.locator('table.quotes-table tbody tr', { hasText: 'Delete Co' }).locator('button', { hasText: 'Delete' }).click();

  await expect(page.locator('#remove-overlay')).toHaveClass(/show/);
  await expect(page.locator('#remove-overlay')).toContainText('Delete quote SQ-00000444? It will not re-import.');
  await page.locator('#remove-confirm').click();

  await expect(page.locator('#toast')).toContainText('deleted');
  await expect(page.locator('#quotes-container')).toContainText('No quotes found');
  // Soft delete: the record stays in the database with deleted_at stamped...
  expect(state.quotes.length).toBe(1);
  expect(state.quotes[0].deleted_at).toBeTruthy();
  // ...so the sync's existing-quote-numbers check (which does NOT filter deleted)
  // still sees SQ-00000444 and will not re-import it.
  const existing = new Set(state.quotes.map(q => q.quote_number));
  expect(existing.has('SQ-00000444')).toBe(true);
  // And the list keeps excluding it after a reload (stays gone post-re-sync).
  await page.locator('button.tab', { hasText: /^Calculator$/ }).click();
  await page.locator('button.tab', { hasText: 'Saved quotes' }).click();
  await expect(page.locator('#quotes-container')).toContainText('No quotes found');
});

test('edits and duplicates an existing quote', async ({ page }) => {
  const initialQuotes = [
    {
      id: 101,
      business_name: 'Existing Co',
      customer: 'Taylor',
      rep: 'Liam',
      quote_number: 'SQ-00000099',
      status: 'pending',
      quote_date: '2026-06-10',
      freight: 0,
      freight_in_gp: false,
      sell_price: 150,
      gp_percent: 33.3,
      line_items: '[{"sku":"TESTSKU","desc":"Test carton","qty":2,"cost":100,"sell":150}]',
      followups: '[]',
      created_at: '2026-06-10T00:00:00Z',
    },
  ];
  await mockQuotesApi(page, { quotes: initialQuotes });

  await page.goto(appPath);
  await page.locator('button.tab', { hasText: 'Saved quotes' }).click();
  await page.locator('table.quotes-table tbody tr', { hasText: 'Existing Co' }).locator('button', { hasText: 'Edit' }).click();

  await expect(page.locator('#business-name')).toHaveValue('Existing Co');
  await page.locator('#business-name').fill('Updated Co');
  await page.locator('#save-btn').click();

  await expect(page.locator('#toast')).toContainText('Quote updated successfully');

  await page.locator('button.tab', { hasText: 'Saved quotes' }).click();
  await page.locator('table.quotes-table tbody tr', { hasText: 'Updated Co' }).locator('button', { hasText: 'Duplicate' }).click();

  await expect(page.locator('#toast')).toContainText('Quote duplicated');
  await expect(page.locator('#quote-number')).toHaveValue('');
});

test('supports product search auto-fill for line items', async ({ page }) => {
  await mockQuotesApi(page);

  await page.goto(appPath);
  await page.locator('#line-items-body input[data-field="sku"]').first().fill('1000TUBE100UM');
  await expect(page.locator('.product-dropdown')).toHaveClass(/show/);
  await page.locator('.product-dropdown .pd-item').first().click();

  await expect(page.locator('#line-items-body input[data-field="sku"]').first()).toHaveValue('1000TUBE100UM');
  await expect(page.locator('#line-items-body input[data-field="desc"]').first()).toHaveValue(/1000mm Wide Tube/);
  await expect(page.locator('#line-items-body input[data-field="cost"]').first()).not.toHaveValue('');
  await expect(page.locator('#line-items-body input[data-field="sell"]').first()).not.toHaveValue('');
});

test('calculates GP and totals correctly for line items', async ({ page }) => {
  await mockQuotesApi(page);

  await page.goto(appPath);
  await page.locator('#line-items-body input[data-field="qty"]').first().fill('2');
  await page.locator('#line-items-body input[data-field="cost"]').first().fill('100');
  await page.locator('#line-items-body input[data-field="sell"]').first().fill('150');

  await expect(page.locator('#sum-sell')).toHaveText('$300.00');
  await expect(page.locator('#sum-gp')).toHaveText('$100.00');
  await expect(page.locator('#sum-gp-pct')).toHaveText('33.3%');
});

test('loads the landed cost calculator and computes landed cost values', async ({ page }) => {
  await mockQuotesApi(page);

  await page.goto(appPath);
  await page.locator('button.tab', { hasText: 'Landed Cost Calculator' }).click();

  await page.locator('#landed-ship-mode').selectOption('20ft FCL');
  await page.locator('#landed-origin-port').selectOption('Colombo');
  await page.locator('#landed-exchange-rate').fill('0.65');
  await page.locator('#landed-tt-balance-fee').fill('15');

  await expect(page.locator('#landed-ocean-freight')).toHaveValue('2300');
  await expect(page.locator('#landed-carrier')).toHaveValue('OOCL');

  await page.locator('#landed-product-body input[data-field="sku"]').first().fill('SKU-1');
  await page.locator('#landed-product-body input[data-field="desc"]').first().fill('Test bag');
  await page.locator('#landed-product-body input[data-field="usd-price"]').first().fill('4.50');
  await page.locator('#landed-product-body input[data-field="qty-per-carton"]').first().fill('50');
  await page.locator('#landed-product-body input[data-field="cbm-per-carton"]').first().fill('0.5');
  await page.locator('#landed-product-body input[data-field="cartons"]').first().fill('2');

  await expect(page.locator('#landed-product-body input[data-field="aud-price-per-carton"]')).toHaveValue(/346.15|346.2/);
  await expect(page.locator('#landed-product-body input[data-field="aud-landed-cost-per-bag"]')).not.toHaveValue('');
});

test('landed cost: rate card (Aug 2026) — ocean freight, carrier, and dropped ports', async ({ page }) => {
  await mockQuotesApi(page);
  await page.goto(appPath);
  await page.locator('button.tab', { hasText: 'Landed Cost Calculator' }).click();
  await page.locator('#landed-ship-mode').selectOption('20ft FCL');

  // Dual-carrier lane resolves to the named COSCO rate.
  await page.locator('#landed-origin-port').selectOption('Shanghai');
  await expect(page.locator('#landed-ocean-freight')).toHaveValue('2550');
  await expect(page.locator('#landed-carrier')).toHaveValue('COSCO');

  // 40ft rate for the same lane.
  await page.locator('#landed-ship-mode').selectOption('40ft FCL');
  await expect(page.locator('#landed-ocean-freight')).toHaveValue('5100');

  // Default exchange rate matches the card.
  await expect(page.locator('#landed-exchange-rate')).toHaveValue('0.6814');

  // Off-card ports are removed; current card lanes remain selectable.
  const ports = await page.locator('#landed-origin-port option').allTextContents();
  for (const gone of ['Jakarta', 'Surabaya', 'Nhava Sheva', 'Port Kelang', 'Shenzhen', 'Jiangmen']) {
    expect(ports).not.toContain(gone);
  }
  for (const kept of ['Colombo', 'Qingdao', 'Yantian', 'New Delhi', 'Keelung']) {
    expect(ports).toContain(kept);
  }
});

test('sends landed cost lines into the calculator as cost prices', async ({ page }) => {
  await mockQuotesApi(page);

  await page.goto(appPath);
  await page.locator('button.tab', { hasText: 'Landed Cost Calculator' }).click();

  await page.locator('#landed-ship-mode').selectOption('20ft FCL');
  await page.locator('#landed-origin-port').selectOption('Colombo');
  await page.locator('#landed-exchange-rate').fill('0.65');
  await page.locator('#landed-tt-balance-fee').fill('15');

  await page.locator('#landed-product-body input[data-field="sku"]').first().fill('SKU-1');
  await page.locator('#landed-product-body input[data-field="desc"]').first().fill('Test bag');
  await page.locator('#landed-product-body input[data-field="usd-price"]').first().fill('4.50');
  await page.locator('#landed-product-body input[data-field="qty-per-carton"]').first().fill('50');
  await page.locator('#landed-product-body input[data-field="cbm-per-carton"]').first().fill('0.5');
  await page.locator('#landed-product-body input[data-field="cartons"]').first().fill('2');

  await page.locator('#send-to-quote-btn').click();

  await expect(page.locator('button.tab').filter({ hasText: /^Calculator$/ })).toHaveClass(/active/);
  await expect(page.locator('#line-items-body input[data-field="sku"]').first()).toHaveValue('SKU-1');
  await expect(page.locator('#line-items-body input[data-field="desc"]').first()).toHaveValue('Test bag');
  await expect(page.locator('#line-items-body input[data-field="cost"]').first()).not.toHaveValue('');
});

test('landed cost: per-unit costs show 4 decimals, order money stays 2 decimals', async ({ page }) => {
  await mockQuotesApi(page);
  await page.goto(appPath);
  await page.locator('button.tab', { hasText: 'Landed Cost Calculator' }).click();

  await page.locator('#landed-ship-mode').selectOption('20ft FCL');
  await page.locator('#landed-origin-port').selectOption('Colombo');
  await page.locator('#landed-exchange-rate').fill('0.65');

  await page.locator('#landed-product-body input[data-field="usd-price"]').first().fill('4.50');
  await page.locator('#landed-product-body input[data-field="qty-per-carton"]').first().fill('50');
  await page.locator('#landed-product-body input[data-field="cbm-per-carton"]').first().fill('0.5');
  await page.locator('#landed-product-body input[data-field="cartons"]').first().fill('2');

  // Per-unit fields: exactly 4 decimal places.
  for (const field of ['aud-price-per-carton', 'aud-landed-cost-per-bag', 'aud-landed-cost-per-bag-solo']) {
    const val = await page.locator(`#landed-product-body input[data-field="${field}"]`).first().inputValue();
    expect(val).toMatch(/^\$[\d,]+\.\d{4}$/);
  }

  // Whole-order money: exactly 2 decimal places.
  const rowTotal = await page.locator('#landed-product-body input[data-field="aud-total-landed"]').first().inputValue();
  expect(rowTotal).toMatch(/^\$[\d,]+\.\d{2}$/);
  const grand = (await page.locator('#landed-total-landed').textContent()).trim();
  expect(grand).toMatch(/^\$[\d,]+\.\d{2}$/);

  // Send to Quote passes the 4-decimal landed/bag value into the cost field.
  const bagVal = parseFloat((await page.locator('#landed-product-body input[data-field="aud-landed-cost-per-bag"]').first().inputValue()).replace(/[^0-9.]/g, ''));
  await page.locator('#send-to-quote-btn').click();
  const cost = parseFloat(await page.locator('#line-items-body input[data-field="cost"]').first().inputValue());
  expect(Math.abs(cost - bagVal)).toBeLessThan(0.00005);
});

test('landed cost: order qty computes cartons (rounding up) and marks the rounded row', async ({ page }) => {
  await mockQuotesApi(page);
  await page.goto(appPath);
  await page.locator('button.tab', { hasText: 'Landed Cost Calculator' }).click();

  const qpc = page.locator('#landed-product-body input[data-field="qty-per-carton"]').first();
  const orderQty = page.locator('#landed-product-body input[data-field="order-qty"]').first();
  const cartons = page.locator('#landed-product-body input[data-field="cartons"]').first();

  await qpc.fill('50');
  await orderQty.fill('1000');
  // Exact multiple: 1000 / 50 = 20 cartons, no rounding highlight.
  await expect(cartons).toHaveValue('20');
  await expect(cartons).not.toHaveClass(/rounded-up/);

  // Non-multiple: 1020 / 50 = 20.4 -> rounds up to 21, highlight + tooltip appear.
  await orderQty.fill('1020');
  await expect(cartons).toHaveValue('21');
  await expect(cartons).toHaveClass(/rounded-up/);
  await expect(cartons).toHaveAttribute('title', /actual pieces shipped: 1050/);
});

test('landed cost: typing cartons reverse-fills order qty', async ({ page }) => {
  await mockQuotesApi(page);
  await page.goto(appPath);
  await page.locator('button.tab', { hasText: 'Landed Cost Calculator' }).click();

  const qpc = page.locator('#landed-product-body input[data-field="qty-per-carton"]').first();
  const orderQty = page.locator('#landed-product-body input[data-field="order-qty"]').first();
  const cartons = page.locator('#landed-product-body input[data-field="cartons"]').first();

  await qpc.fill('40');
  await cartons.fill('3');
  await expect(orderQty).toHaveValue('120');
  await expect(cartons).not.toHaveClass(/rounded-up/);
});

test('landed cost: per-row total landed and grand total are correct', async ({ page }) => {
  await mockQuotesApi(page);
  await page.goto(appPath);
  await page.locator('button.tab', { hasText: 'Landed Cost Calculator' }).click();

  await page.locator('#landed-ship-mode').selectOption('20ft FCL');
  await page.locator('#landed-origin-port').selectOption('Colombo');
  await page.locator('#landed-exchange-rate').fill('0.65');

  const parseMoney = s => parseFloat(String(s).replace(/[^0-9.-]/g, '')) || 0;

  // Row 1
  await page.locator('#landed-product-body input[data-field="sku"]').first().fill('SKU-1');
  await page.locator('#landed-product-body input[data-field="usd-price"]').first().fill('4.50');
  await page.locator('#landed-product-body input[data-field="qty-per-carton"]').first().fill('50');
  await page.locator('#landed-product-body input[data-field="cbm-per-carton"]').first().fill('0.5');
  await page.locator('#landed-product-body input[data-field="cartons"]').first().fill('2');

  // Add a second product row.
  await page.locator('#add-landed-btn').click();
  await page.locator('#landed-product-body input[data-field="usd-price"]').nth(1).fill('3.00');
  await page.locator('#landed-product-body input[data-field="qty-per-carton"]').nth(1).fill('20');
  await page.locator('#landed-product-body input[data-field="cbm-per-carton"]').nth(1).fill('0.3');
  await page.locator('#landed-product-body input[data-field="cartons"]').nth(1).fill('5');

  // Total landed per row must equal landed/bag × qty/carton × cartons.
  const rowTotal = async i => {
    const perBag = parseMoney(await page.locator('#landed-product-body input[data-field="aud-landed-cost-per-bag"]').nth(i).inputValue());
    const qtyPerCarton = parseFloat(await page.locator('#landed-product-body input[data-field="qty-per-carton"]').nth(i).inputValue()) || 0;
    const cartons = parseFloat(await page.locator('#landed-product-body input[data-field="cartons"]').nth(i).inputValue()) || 0;
    const shown = parseMoney(await page.locator('#landed-product-body input[data-field="aud-total-landed"]').nth(i).inputValue());
    expect(Math.abs(shown - perBag * qtyPerCarton * cartons)).toBeLessThan(0.02);
    return shown;
  };
  const t0 = await rowTotal(0);
  const t1 = await rowTotal(1);

  // Grand total equals the sum of row totals.
  const grand = parseMoney(await page.locator('#landed-total-landed').textContent());
  expect(Math.abs(grand - (t0 + t1))).toBeLessThan(0.02);
});

test('landed cost: per-row Total CBM column equals CBM/carton × cartons and totals to the section figure', async ({ page }) => {
  await mockQuotesApi(page);
  await page.goto(appPath);
  await page.locator('button.tab', { hasText: 'Landed Cost Calculator' }).click();

  await page.locator('#landed-product-body input[data-field="cbm-per-carton"]').first().fill('0.5');
  await page.locator('#landed-product-body input[data-field="cartons"]').first().fill('3');

  await page.locator('#add-landed-btn').click();
  await page.locator('#landed-product-body input[data-field="cbm-per-carton"]').nth(1).fill('0.2469');
  await page.locator('#landed-product-body input[data-field="cartons"]').nth(1).fill('7');

  const rowCbm0 = parseFloat(await page.locator('#landed-product-body input[data-field="total-cbm"]').first().inputValue());
  const rowCbm1 = parseFloat(await page.locator('#landed-product-body input[data-field="total-cbm"]').nth(1).inputValue());
  expect(rowCbm0).toBeCloseTo(1.5, 4);
  expect(rowCbm1).toBeCloseTo(0.2469 * 7, 4);

  // 4 decimal places displayed.
  expect(await page.locator('#landed-product-body input[data-field="total-cbm"]').nth(1).inputValue()).toMatch(/^\d+\.\d{4}$/);

  // Totals-section Total CBM equals the sum of the per-row column.
  const totalCbm = parseFloat((await page.locator('#landed-total-cbm').textContent()).trim());
  expect(totalCbm).toBeCloseTo(rowCbm0 + rowCbm1, 4);
});

test('landed cost: Cartons and Total landed show full values without truncation', async ({ page }) => {
  await mockQuotesApi(page);
  await page.goto(appPath);
  await page.locator('button.tab', { hasText: 'Landed Cost Calculator' }).click();

  await page.locator('#landed-ship-mode').selectOption('20ft FCL');
  await page.locator('#landed-origin-port').selectOption('Colombo');
  await fillLandedRow(page, 0, { 'usd-price': '9.99', 'qty-per-carton': '100', 'cbm-per-carton': '0.5', 'cartons': '1250' });
  await page.locator('#landed-total-charge').fill('120000');

  const noClip = async loc => {
    const el = page.locator(loc).first();
    const s = await el.evaluate(e => e.scrollWidth);
    const c = await el.evaluate(e => e.clientWidth);
    expect(s).toBeLessThanOrEqual(c + 1);
  };
  // Cartons shows 1250 in full.
  expect(await page.locator('#landed-product-body input[data-field="cartons"]').first().inputValue()).toBe('1250');
  await noClip('#landed-product-body input[data-field="cartons"]');
  // Total landed shows a large value in full.
  const total = await page.locator('#landed-product-body input[data-field="aud-total-landed"]').first().inputValue();
  expect(total).toMatch(/^\$[\d,]+\.\d{2}$/);
  await noClip('#landed-product-body input[data-field="aud-total-landed"]');
});

test('landed cost: workings panel renders live numbers matching displayed fields and hides on print', async ({ page }) => {
  await mockQuotesApi(page);
  await page.goto(appPath);
  await page.locator('button.tab', { hasText: 'Landed Cost Calculator' }).click();

  await page.locator('#landed-ship-mode').selectOption('20ft FCL');
  await page.locator('#landed-origin-port').selectOption('Colombo');
  await page.locator('#landed-exchange-rate').fill('0.65');
  await page.locator('#landed-total-charge').fill('4500');
  await page.locator('#landed-product-body input[data-field="usd-price"]').first().fill('4.50');
  await page.locator('#landed-product-body input[data-field="qty-per-carton"]').first().fill('50');
  await page.locator('#landed-product-body input[data-field="cbm-per-carton"]').first().fill('0.5');
  await page.locator('#landed-product-body input[data-field="cartons"]').first().fill('2');

  // Workings hidden until the feature is toggled on.
  const workingsRow = page.locator('.landed-workings-row').first();
  await expect(workingsRow).toBeHidden();

  await page.locator('#toggle-workings-btn').click();
  await expect(page.locator('#toggle-workings-btn')).toHaveText('Hide workings');

  // Expand this row's panel.
  await workingsRow.locator('.workings-toggle').click();
  const panel = workingsRow.locator('.workings-panel');
  await expect(panel).toBeVisible();

  // Numbers in the panel match the row's displayed calculated fields exactly.
  const landedBag = await page.locator('#landed-product-body input[data-field="aud-landed-cost-per-bag"]').first().inputValue();
  const totalLanded = await page.locator('#landed-product-body input[data-field="aud-total-landed"]').first().inputValue();
  const text = await panel.textContent();
  expect(text).toContain(landedBag);
  expect(text).toContain(totalLanded);
  // The removed columns' figures still live in the workings as calculation lines.
  expect(text).toContain('Freight/carton:');
  expect(text).toContain('Landed/carton:');
  // Divisor line names the fixed container capacity for FCL.
  expect(text).toContain('Fixed container capacity: 30 CBM (20ft FCL)');

  // Re-editing updates the workings numbers (not hardcoded).
  await page.locator('#landed-product-body input[data-field="usd-price"]').first().fill('9.00');
  const newLandedBag = await page.locator('#landed-product-body input[data-field="aud-landed-cost-per-bag"]').first().inputValue();
  expect(await panel.textContent()).toContain(newLandedBag);

  // Hidden entirely on print.
  await page.emulateMedia({ media: 'print' });
  await expect(workingsRow).toBeHidden();
  await expect(panel).toBeHidden();
  await page.emulateMedia({ media: 'screen' });
});

const pm = s => parseFloat(String(s).replace(/[^0-9.-]/g, '')) || 0;

async function fillLandedRow(page, i, vals) {
  for (const [field, value] of Object.entries(vals)) {
    await page.locator(`#landed-product-body input[data-field="${field}"]`).nth(i).fill(String(value));
  }
}

test('landed cost: order qty field shows 7 digits without cutting off', async ({ page }) => {
  await mockQuotesApi(page);
  await page.goto(appPath);
  await page.locator('button.tab', { hasText: 'Landed Cost Calculator' }).click();

  const orderQty = page.locator('#landed-product-body input[data-field="order-qty"]').first();
  await orderQty.fill('1000000');
  expect(await orderQty.inputValue()).toBe('1000000');
  // The full value fits inside the input (no clipping).
  const scrollW = await orderQty.evaluate(el => el.scrollWidth);
  const clientW = await orderQty.evaluate(el => el.clientWidth);
  expect(scrollW).toBeLessThanOrEqual(clientW + 1);
});

test('landed cost: FCL solo landed/bag equals full freight ÷ item cartons', async ({ page }) => {
  await mockQuotesApi(page);
  await page.goto(appPath);
  await page.locator('button.tab', { hasText: 'Landed Cost Calculator' }).click();

  await page.locator('#landed-ship-mode').selectOption('20ft FCL');
  await page.locator('#landed-origin-port').selectOption('Colombo');
  await page.locator('#landed-exchange-rate').fill('0.65');
  await fillLandedRow(page, 0, { 'usd-price': '4.50', 'qty-per-carton': '50', 'cbm-per-carton': '0.5', 'cartons': '4' });
  // Manual override of total freight — used as the solo total too.
  await page.locator('#landed-total-charge').fill('8000');

  const audPrice = pm(await page.locator('#landed-product-body input[data-field="aud-price-per-carton"]').first().inputValue());
  const solo = pm(await page.locator('#landed-product-body input[data-field="aud-landed-cost-per-bag-solo"]').first().inputValue());
  // Solo freight/carton = 8000 / 4 = 2000; no duty; ÷ 50 bags.
  const expected = (audPrice + 8000 / 4) / 50;
  expect(Math.abs(solo - expected)).toBeLessThan(0.001);
});

test('landed cost: LCL freight total includes ocean freight and PSS, both overridable', async ({ page }) => {
  await mockQuotesApi(page);
  await page.goto(appPath);
  await page.locator('button.tab', { hasText: 'Landed Cost Calculator' }).click();

  await page.locator('#landed-ship-mode').selectOption('LCL');
  await page.locator('#landed-origin-port').selectOption('Colombo'); // Aug 2026 card: perCbm 111, PSS inclusive
  await page.locator('#landed-exchange-rate').fill('0.6814');
  // totalCbm = 0.5 × 4 = 2 CBM (above the 1 CBM minimum).
  await fillLandedRow(page, 0, { 'usd-price': '5', 'qty-per-carton': '50', 'cbm-per-carton': '0.5', 'cartons': '4' });

  const ocean = page.locator('#freight-breakdown-body input[data-breakdown-key="oceanFreight"]');
  const pss = page.locator('#freight-breakdown-body input[data-breakdown-key="pss"]');
  await expect(ocean).toHaveCount(1);
  await expect(pss).toHaveCount(1);
  // Ocean = 111 × 2 ÷ 0.6814 = 325.80 ; PSS now inclusive in the ocean rate = $0.
  expect(pm(await ocean.inputValue())).toBeCloseTo(325.80, 1);
  expect(pm(await pss.inputValue())).toBe(0);
  await expect(page.locator('#freight-breakdown-body .breakdown-row', { hasText: 'PSS' })).toContainText('inclusive in ocean rate');

  // Exact total = breakdown + Westpac TT deposit ($30). Fuel levy now 35%:
  // 325.80+0+170+40+50+55+35+85+80+45+90+31.50+18.50+6.48 + 30 = 1062.28
  expect(await page.locator('#landed-total-charge').inputValue()).toBe('1062.28');

  // Breakdown lines render in the rate-card order.
  const labels = await page.locator('#freight-breakdown-body .breakdown-row > span').allTextContents();
  const expectedOrder = [
    'Ocean Freight', 'PSS', 'Port Service Charges', 'Terminal Handling Charge',
    'Port Infrastructure', 'Delivery Order Charge', 'EDI Fee', 'Cargo Reporting',
    'Customs Clearance', 'Quarantine Registration Fee', 'Delivery — Archerfield',
    'Domestic Fuel Levy', 'Temporary Terminal F/C', 'Temporary Terminal Fuel Levy'
  ];
  expect(labels.length).toBe(expectedOrder.length);
  labels.forEach((label, i) => expect(label.startsWith(expectedOrder[i])).toBeTruthy());

  // Overriding the ocean line flows through to the total freight figure.
  const before = pm(await page.locator('#landed-total-charge').inputValue());
  await page.locator('#breakdown-toggle-btn').click(); // reveal the breakdown inputs
  await ocean.fill('9999');
  await ocean.dispatchEvent('input');
  const after = pm(await page.locator('#landed-total-charge').inputValue());
  expect(after).toBeGreaterThan(before + 9000);
});

test('landed cost: Aug 2026 LCL card — Qingdao 10 CBM ocean, zero PSS, 35% fuel levy on both lines', async ({ page }) => {
  await mockQuotesApi(page);
  await page.goto(appPath);
  await page.locator('button.tab', { hasText: 'Landed Cost Calculator' }).click();

  await page.locator('#landed-ship-mode').selectOption('LCL');
  await page.locator('#landed-origin-port').selectOption('Qingdao'); // perCbm 66
  await page.locator('#landed-exchange-rate').fill('0.6814');
  // 10 CBM total.
  await fillLandedRow(page, 0, { 'usd-price': '5', 'qty-per-carton': '50', 'cbm-per-carton': '1', 'cartons': '10' });

  const val = async key => pm(await page.locator(`#freight-breakdown-body input[data-breakdown-key="${key}"]`).inputValue());
  // Ocean = 66 × 10 ÷ 0.6814 ≈ 968.60
  expect(await val('oceanFreight')).toBeCloseTo(968.59, 0);
  expect(await val('pss')).toBe(0);
  // Delivery = max(90, 30×10) = 300; fuel levy 35% → 105.
  expect(await val('delivery')).toBeCloseTo(300, 2);
  expect(await val('deliveryFuel')).toBeCloseTo(105, 2);
  // Temporary terminal = max(18.5, 5×10) = 50; fuel levy 35% → 17.50.
  expect(await val('temporaryTerminal')).toBeCloseTo(50, 2);
  expect(await val('temporaryFuel')).toBeCloseTo(17.5, 2);
  // Labels state the current levy percentage.
  await expect(page.locator('#freight-breakdown-body .breakdown-row', { hasText: 'Domestic Fuel Levy' })).toContainText('35% of Delivery');
  await expect(page.locator('#freight-breakdown-body .breakdown-row', { hasText: 'Temporary Terminal Fuel Levy' })).toContainText('35%');
});

test('landed cost: single-product LCL solo includes the item\'s own ocean freight', async ({ page }) => {
  await mockQuotesApi(page);
  await page.goto(appPath);
  await page.locator('button.tab', { hasText: 'Landed Cost Calculator' }).click();

  await page.locator('#landed-ship-mode').selectOption('LCL');
  await page.locator('#landed-origin-port').selectOption('Colombo');
  await page.locator('#landed-exchange-rate').fill('0.6814');
  await fillLandedRow(page, 0, { 'usd-price': '5', 'qty-per-carton': '50', 'cbm-per-carton': '0.5', 'cartons': '4' });

  const audPrice = pm(await page.locator('#landed-product-body input[data-field="aud-price-per-carton"]').first().inputValue());
  const solo = pm(await page.locator('#landed-product-body input[data-field="aud-landed-cost-per-bag-solo"]').first().inputValue());
  const bundled = pm(await page.locator('#landed-product-body input[data-field="aud-landed-cost-per-bag"]').first().inputValue());
  // Single item: solo == bundled, and both exceed the freight-free price-per-bag (freight, incl ocean, is included).
  expect(Math.abs(solo - bundled)).toBeLessThan(0.001);
  expect(solo).toBeGreaterThan(audPrice / 50 + 1);
});

test('landed cost: LCL solo exceeds bundled per-bag for a small item dominated by fixed charges', async ({ page }) => {
  await mockQuotesApi(page);
  await page.goto(appPath);
  await page.locator('button.tab', { hasText: 'Landed Cost Calculator' }).click();

  await page.locator('#landed-ship-mode').selectOption('LCL');
  await page.locator('#landed-origin-port').selectOption('Colombo');
  await page.locator('#landed-exchange-rate').fill('0.65');

  // Large item soaks up most CBM.
  await fillLandedRow(page, 0, { 'usd-price': '5', 'qty-per-carton': '20', 'cbm-per-carton': '1', 'cartons': '20' });
  // Small item: tiny CBM, few cartons — bundled freight share is small.
  await page.locator('#add-landed-btn').click();
  await fillLandedRow(page, 1, { 'usd-price': '5', 'qty-per-carton': '20', 'cbm-per-carton': '0.01', 'cartons': '1' });

  const bundledSmall = pm(await page.locator('#landed-product-body input[data-field="aud-landed-cost-per-bag"]').nth(1).inputValue());
  const soloSmall = pm(await page.locator('#landed-product-body input[data-field="aud-landed-cost-per-bag-solo"]').nth(1).inputValue());
  expect(soloSmall).toBeGreaterThan(bundledSmall);
});

test('landed cost: single-product LCL shipment shows solo consistent with the bundled figure', async ({ page }) => {
  await mockQuotesApi(page);
  await page.goto(appPath);
  await page.locator('button.tab', { hasText: 'Landed Cost Calculator' }).click();

  await page.locator('#landed-ship-mode').selectOption('LCL');
  await page.locator('#landed-origin-port').selectOption('Colombo');
  await page.locator('#landed-exchange-rate').fill('0.65');
  await fillLandedRow(page, 0, { 'usd-price': '5', 'qty-per-carton': '10', 'cbm-per-carton': '0.5', 'cartons': '4', 'duty-pct': '10' });

  const bundled = pm(await page.locator('#landed-product-body input[data-field="aud-landed-cost-per-bag"]').first().inputValue());
  const solo = pm(await page.locator('#landed-product-body input[data-field="aud-landed-cost-per-bag-solo"]').first().inputValue());
  // Only item in the shipment: solo must equal bundled (duty included in both).
  expect(Math.abs(solo - bundled)).toBeLessThan(0.001);
});

test('landed cost: dedicated print shows the full-width table; workings print only when toggle is on', async ({ page }) => {
  await mockQuotesApi(page);
  await page.goto(appPath);
  await page.evaluate(() => { window.print = () => {}; });
  await page.locator('button.tab', { hasText: 'Landed Cost Calculator' }).click();

  await page.locator('#landed-ship-mode').selectOption('20ft FCL');
  await page.locator('#landed-origin-port').selectOption('Colombo');
  await fillLandedRow(page, 0, { 'sku': 'SKU-1', 'usd-price': '4.50', 'qty-per-carton': '50', 'cbm-per-carton': '0.5', 'cartons': '2' });

  // Trigger the real landed print path (window.print stubbed) — adds print-landed.
  await page.locator('button:has-text("Print / Export")').click();
  await page.emulateMedia({ media: 'print' });

  // Table fits its wrapper width (no overflow / horizontal scrollbar).
  const table = page.locator('#landed-table');
  const tableBox = await table.boundingBox();
  const wrapBox = await table.locator('xpath=ancestor::div[contains(@class,"line-wrap")]').boundingBox();
  expect(tableBox.width).toBeLessThanOrEqual(wrapBox.width + 1);

  // Key columns are visible on print (solo + total landed).
  await expect(page.locator('#landed-table th', { hasText: 'Landed/bag (solo)' })).toBeVisible();
  await expect(page.locator('#landed-table th', { hasText: 'Total landed (AUD)' })).toBeVisible();
  // The two intermediate-workings columns are gone from the table.
  await expect(page.locator('#landed-table th', { hasText: 'AUD freight & customs/carton' })).toHaveCount(0);
  await expect(page.locator('#landed-table th', { hasText: 'AUD landed/carton' })).toHaveCount(0);

  // Shipment charges summary prints with charge lines and a dollar total (widgets hidden, values shown).
  const charges = page.locator('#landed-charges-print');
  await expect(charges).toBeVisible();
  await expect(charges).toContainText('Cargo reporting');
  await expect(charges).toContainText('Customs clearance');
  await expect(charges).toContainText('Total freight & charges');
  await expect(charges.locator('.lcp-total')).toContainText('$');
  await expect(charges.locator('.lcp-row').first()).toBeVisible();
  // The config form widgets themselves stay hidden on print.
  await expect(page.locator('#landed-config-section')).toBeHidden();

  // In-table workings rows never print; the page-2 container is the only workings output.
  await expect(page.locator('.landed-workings-row').first()).toBeHidden();
  // Workings toggle OFF → page-2 container is empty and hidden.
  await expect(page.locator('#landed-workings-print')).toBeHidden();
  await expect(page.locator('#landed-workings-print .lwp-block')).toHaveCount(0);

  // Turn Show workings ON and print again — workings populate the page-2 container.
  await page.emulateMedia({ media: 'screen' });
  await page.locator('#toggle-workings-btn').click();
  await page.locator('button:has-text("Print / Export")').click();
  await page.emulateMedia({ media: 'print' });
  await expect(page.locator('#landed-workings-print')).toBeVisible();
  await expect(page.locator('#landed-workings-print .lwp-block').first()).toBeVisible();
  // Its break-before:page puts workings on their own page (page 2).
  const breakBefore = await page.locator('#landed-workings-print').evaluate(el => getComputedStyle(el).breakBefore);
  expect(breakBefore).toBe('page');
  // In-table workings rows remain hidden on print.
  await expect(page.locator('.landed-workings-row').first()).toBeHidden();

  await page.emulateMedia({ media: 'screen' });
});

test('Calculator tab print is unaffected by the landed print styles', async ({ page }) => {
  await mockQuotesApi(page);
  await page.goto(appPath);

  await page.locator('#line-items-body input[data-field="cost"]').nth(0).fill('10');
  await page.locator('#line-items-body input[data-field="sell"]').nth(0).fill('20');

  // No print-landed class present → portrait calculator print behaviour intact.
  await page.emulateMedia({ media: 'print' });
  expect(await page.evaluate(() => document.body.classList.contains('print-landed'))).toBe(false);
  await expect(page.locator('#print-header')).toBeVisible();
  await expect(page.locator('#line-items-body input[data-field="sell"]').first()).toBeVisible();
  await page.emulateMedia({ media: 'screen' });
});

test('updates a quote status from the saved quotes list', async ({ page }) => {
  const initialQuotes = [
    {
      id: 201,
      business_name: 'Status Co',
      customer: 'Jordan',
      rep: 'Will',
      quote_number: 'SQ-00000111',
      status: 'pending',
      quote_date: '2026-06-10',
      freight: 0,
      freight_in_gp: false,
      sell_price: 100,
      gp_percent: 20,
      line_items: '[]',
      followups: '[]',
      created_at: '2026-06-10T00:00:00Z',
    },
  ];
  await mockQuotesApi(page, { quotes: initialQuotes });

  await page.goto(appPath);
  await page.locator('button.tab', { hasText: 'Saved quotes' }).click();
  await page.locator('table.quotes-table tbody tr', { hasText: 'Status Co' }).locator('button', { hasText: 'Status' }).click();
  await page.locator('#status-dialog-select').selectOption('won');
  await page.locator('#status-confirm').click();

  await expect(page.locator('#toast')).toContainText('Status updated to won');
});

test('drags a line item to reorder it and preserves the order on save', async ({ page }) => {
  const state = { quotes: [] };
  await mockQuotesApi(page, state);

  await page.goto(appPath);
  await page.locator('#business-name').fill('Reorder Co');
  await page.locator('#rep').selectOption('Jack');
  await page.locator('#status').selectOption('pending');

  await page.locator('#line-items-body input[data-field="sku"]').nth(0).fill('FIRST');
  await page.locator('#add-line-btn').click();
  await page.locator('#line-items-body input[data-field="sku"]').nth(1).fill('SECOND');

  const rows = page.locator('#line-items-body tr:not(.line-slider-row)');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0).locator('.drag-handle')).toBeVisible();

  const firstHandle = rows.nth(0).locator('.drag-handle-cell');
  const secondRow = rows.nth(1);
  const firstBox = await firstHandle.boundingBox();
  const secondBox = await secondRow.boundingBox();

  await page.mouse.move(firstBox.x + firstBox.width / 2, firstBox.y + firstBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(secondBox.x + secondBox.width / 2, secondBox.y + secondBox.height / 2, { steps: 5 });
  await rows.nth(1).dispatchEvent('drop');
  await page.mouse.up();

  await expect(page.locator('#line-items-body input[data-field="sku"]').nth(0)).toHaveValue('SECOND');
  await expect(page.locator('#line-items-body input[data-field="sku"]').nth(1)).toHaveValue('FIRST');

  await page.locator('#save-btn').click();
  await expect(page.locator('#toast')).toContainText('Quote saved successfully');

  const savedLines = JSON.parse(state.quotes[0].line_items);
  expect(savedLines[0].sku).toBe('SECOND');
  expect(savedLines[1].sku).toBe('FIRST');
});

test('scrolls to the top and shows a toast when a required field is missing', async ({ page }) => {
  await mockQuotesApi(page);

  await page.goto(appPath);
  await page.evaluate(() => window.scrollTo(0, 800));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);

  await page.locator('#line-items-body input[data-field="sku"]').first().fill('NOFIELDS');
  await page.locator('#save-btn').click();

  await expect(page.locator('#toast')).toContainText('Please enter a business name before saving');
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
});

test('scrolls to the top when a quote is saved successfully', async ({ page }) => {
  await mockQuotesApi(page);

  await page.goto(appPath);
  await page.locator('#business-name').fill('Scroll Co');
  await page.locator('#rep').selectOption('Jack');
  await page.locator('#status').selectOption('pending');
  await page.locator('#line-items-body input[data-field="sku"]').first().fill('SCROLLSKU');
  await page.locator('#line-items-body input[data-field="qty"]').first().fill('1');
  await page.locator('#line-items-body input[data-field="cost"]').first().fill('10');
  await page.locator('#line-items-body input[data-field="sell"]').first().fill('20');

  await page.evaluate(() => window.scrollTo(0, 800));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);

  await page.locator('#save-btn').click();
  await expect(page.locator('#toast')).toContainText('Quote saved successfully');
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
});

test.describe('mobile viewport (375px)', () => {
  test.use({ viewport: { width: 375, height: 800 } });

  test('renders line items as labeled cards instead of a table header', async ({ page }) => {
    await mockQuotesApi(page);
    await page.goto(appPath);

    const lineItemsTable = page.locator('#line-items-body').locator('xpath=ancestor::table[1]');
    await expect(lineItemsTable.locator('thead')).not.toBeVisible();

    const firstRow = page.locator('#line-items-body tr:not(.line-slider-row)').first();
    const skuCell = firstRow.locator('td').filter({ has: page.locator('input[data-field="sku"]') });
    await expect(skuCell).toHaveAttribute('data-label', 'SKU');

    const qtyCell = firstRow.locator('td').filter({ has: page.locator('input[data-field="qty"]') });
    await expect(qtyCell).toHaveAttribute('data-label', 'Qty');
    const costCell = firstRow.locator('td').filter({ has: page.locator('input[data-field="cost"]') });
    await expect(costCell).toHaveAttribute('data-label', 'Cost ($)');
    const sellCell = firstRow.locator('td').filter({ has: page.locator('input[data-field="sell"]') });
    await expect(sellCell).toHaveAttribute('data-label', 'Sell ($)');
  });

  test('touch targets meet the 44px minimum height', async ({ page }) => {
    await mockQuotesApi(page);
    await page.goto(appPath);

    const skuInput = page.locator('#line-items-body input[data-field="sku"]').first();
    const skuBox = await skuInput.boundingBox();
    expect(skuBox.height).toBeGreaterThanOrEqual(44);

    const saveBtn = page.locator('#save-btn');
    const saveBox = await saveBtn.boundingBox();
    expect(saveBox.height).toBeGreaterThanOrEqual(44);

    const tab = page.locator('button.tab', { hasText: 'Saved quotes' });
    const tabBox = await tab.boundingBox();
    expect(tabBox.height).toBeGreaterThanOrEqual(44);
  });

  test('product search dropdown stays within the viewport', async ({ page }) => {
    await mockQuotesApi(page);
    await page.goto(appPath);

    const skuInput = page.locator('#line-items-body input[data-field="sku"]').first();
    await skuInput.fill('1000TUBE');

    const dd = page.locator('.product-dropdown.show').first();
    await expect(dd).toBeVisible();
    const box = await dd.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(375 + 1);
  });

  test('tab bar scrolls horizontally without wrapping', async ({ page }) => {
    await mockQuotesApi(page);
    await page.goto(appPath);

    const tabs = page.locator('.tabs');
    const overflowX = await tabs.evaluate(el => getComputedStyle(el).overflowX);
    expect(overflowX).toBe('auto');

    const tabTops = await page.locator('.tabs .tab').evaluateAll(
      els => els.map(el => el.getBoundingClientRect().top)
    );
    const uniqueTops = new Set(tabTops.map(t => Math.round(t)));
    expect(uniqueTops.size).toBe(1);
  });

  test('page does not scroll horizontally on mobile', async ({ page }) => {
    await mockQuotesApi(page);
    await page.goto(appPath);

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });
});

test('auto-formats the quote number to SQ-XXXXXXXX on blur', async ({ page }) => {
  await mockQuotesApi(page);
  await page.goto(appPath);

  await page.locator('#quote-number').fill('474');
  await page.locator('#business-name').click();
  await expect(page.locator('#quote-number')).toHaveValue('SQ-00000474');
});

test('clear filters button resets saved quotes filters to defaults', async ({ page }) => {
  const initialQuotes = [
    { id: 601, business_name: 'Alpha Co', customer: 'A', rep: 'Jack', quote_number: 'SQ-00000601', status: 'won', quote_date: '2026-06-01', freight: 0, freight_in_gp: false, sell_price: 500, gp_percent: 40, line_items: '[]', followups: '[]', created_at: '2026-06-01T00:00:00Z' },
    { id: 602, business_name: 'Beta Co', customer: 'B', rep: 'Sam', quote_number: 'SQ-00000602', status: 'lost', quote_date: '2026-06-02', freight: 0, freight_in_gp: false, sell_price: 300, gp_percent: 10, line_items: '[]', followups: '[]', created_at: '2026-06-02T00:00:00Z' },
  ];
  await mockQuotesApi(page, { quotes: initialQuotes });

  await page.goto(appPath);
  await page.locator('button.tab', { hasText: 'Saved quotes' }).click();
  await page.locator('#filter-status').selectOption('won');
  await page.locator('#filter-customer').fill('Alpha');
  await expect(page.locator('table.quotes-table')).not.toContainText('Beta Co');

  await page.locator('#clear-filters-btn').click();
  await expect(page.locator('#filter-status')).toHaveValue('');
  await expect(page.locator('#filter-customer')).toHaveValue('');
  await expect(page.locator('table.quotes-table')).toContainText('Alpha Co');
  await expect(page.locator('table.quotes-table')).toContainText('Beta Co');
});

test('sorts saved quotes by column with click-to-reverse and arrow indicator', async ({ page }) => {
  const initialQuotes = [
    { id: 701, business_name: 'Zeta Co', customer: 'Z', rep: 'Jack', quote_number: 'SQ-00000701', status: 'pending', quote_date: '2026-06-01', freight: 0, freight_in_gp: false, sell_price: 100, gp_percent: 10, line_items: '[]', followups: '[]', created_at: '2026-06-01T00:00:00Z' },
    { id: 702, business_name: 'Alpha Co', customer: 'A', rep: 'Jack', quote_number: 'SQ-00000702', status: 'pending', quote_date: '2026-06-02', freight: 0, freight_in_gp: false, sell_price: 300, gp_percent: 30, line_items: '[]', followups: '[]', created_at: '2026-06-02T00:00:00Z' },
  ];
  await mockQuotesApi(page, { quotes: initialQuotes });

  await page.goto(appPath);
  await page.locator('button.tab', { hasText: 'Saved quotes' }).click();

  const businessHeader = page.locator('table.quotes-table th', { hasText: 'Business' });
  await businessHeader.click();
  await expect(businessHeader).toContainText('▲');
  let firstRowText = await page.locator('table.quotes-table tbody tr').first().textContent();
  expect(firstRowText).toContain('Alpha Co');

  await businessHeader.click();
  await expect(businessHeader).toContainText('▼');
  firstRowText = await page.locator('table.quotes-table tbody tr').first().textContent();
  expect(firstRowText).toContain('Zeta Co');
});

test('shows quote count below the filter row', async ({ page }) => {
  const initialQuotes = [
    { id: 801, business_name: 'Gamma Co', customer: 'G', rep: 'Jack', quote_number: 'SQ-00000801', status: 'pending', quote_date: '2026-06-01', freight: 0, freight_in_gp: false, sell_price: 100, gp_percent: 10, line_items: '[]', followups: '[]', created_at: '2026-06-01T00:00:00Z' },
    { id: 802, business_name: 'Delta Co', customer: 'D', rep: 'Jack', quote_number: 'SQ-00000802', status: 'won', quote_date: '2026-06-02', freight: 0, freight_in_gp: false, sell_price: 300, gp_percent: 30, line_items: '[]', followups: '[]', created_at: '2026-06-02T00:00:00Z' },
  ];
  await mockQuotesApi(page, { quotes: initialQuotes });

  await page.goto(appPath);
  await page.locator('button.tab', { hasText: 'Saved quotes' }).click();
  await expect(page.locator('#quotes-count')).toContainText('Showing 2 quotes');

  await page.locator('#filter-status').selectOption('won');
  await expect(page.locator('#quotes-count')).toContainText('Showing 1 quote');
});

test('saved quotes source filter, Unleashed badge, full quote number, and missing-cost dot', async ({ page }) => {
  const initialQuotes = [
    { id: 901, business_name: 'Tool Co', customer: 'T', rep: 'Jack', quote_number: 'SQ-00000578', source: 'tool', status: 'pending', quote_date: '2026-06-01', freight: 0, freight_in_gp: false, sell_price: 100, gp_percent: 50, line_items: JSON.stringify([{ sku: 'A1', desc: 'Widget', qty: 1, cost: 5, sell: 10 }]), followups: '[]', created_at: '2026-06-03T00:00:00Z' },
    { id: 902, business_name: 'Unl Co', customer: 'U', rep: 'Jack', quote_number: 'SQ-00000902', source: 'unleashed', status: 'pending', quote_date: '2026-06-02', freight: 0, freight_in_gp: false, sell_price: 200, gp_percent: 40, line_items: JSON.stringify([{ sku: 'B2', desc: 'Gadget', qty: 2, cost: 0, sell: 20 }]), followups: '[]', created_at: '2026-06-02T00:00:00Z' },
    { id: 903, business_name: 'Legacy Co', customer: 'L', rep: 'Sam', quote_number: 'SQ-00000903', source: null, status: 'pending', quote_date: '2026-06-01', freight: 0, freight_in_gp: false, sell_price: 300, gp_percent: 60, line_items: JSON.stringify([{ sku: 'C3', desc: 'Thing', qty: 1, cost: 7, sell: 15 }]), followups: '[]', created_at: '2026-06-01T00:00:00Z' },
  ];
  await mockQuotesApi(page, { quotes: initialQuotes });

  await page.goto(appPath);
  await page.locator('button.tab', { hasText: 'Saved quotes' }).click();
  await expect(page.locator('#quotes-count')).toContainText('Showing 3 quotes');

  const rows = page.locator('.quotes-table tbody tr');

  // Full quote number is visible (11 chars, no ellipsis/truncation).
  const firstQnCell = page.locator('.quotes-table tbody tr', { hasText: 'SQ-00000578' }).locator('td').first();
  await expect(firstQnCell).toContainText('SQ-00000578');
  const scrollW = await firstQnCell.evaluate(el => el.scrollWidth);
  const clientW = await firstQnCell.evaluate(el => el.clientWidth);
  expect(scrollW).toBeLessThanOrEqual(clientW + 1);

  // Badge only on the Unleashed row.
  await expect(page.locator('.quotes-table tbody tr', { hasText: 'SQ-00000902' }).locator('.source-badge')).toHaveCount(1);
  await expect(page.locator('.quotes-table tbody tr', { hasText: 'SQ-00000578' }).locator('.source-badge')).toHaveCount(0);
  await expect(page.locator('.quotes-table tbody tr', { hasText: 'SQ-00000903' }).locator('.source-badge')).toHaveCount(0);

  // Missing-cost amber dot only on the zero-cost (Unleashed) row.
  await expect(page.locator('.quotes-table tbody tr', { hasText: 'SQ-00000902' }).locator('.missing-cost-dot')).toHaveCount(1);
  await expect(page.locator('.quotes-table tbody tr', { hasText: 'SQ-00000578' }).locator('.missing-cost-dot')).toHaveCount(0);
  await expect(page.locator('.quotes-table tbody tr', { hasText: 'SQ-00000903' }).locator('.missing-cost-dot')).toHaveCount(0);

  // Quick quotes toggle — tool quotes, including null-source legacy rows.
  await page.locator('#filter-src-tool').click();
  await expect(page.locator('#filter-src-tool')).toHaveClass(/on/);
  await expect(page.locator('#quotes-count')).toContainText('Showing 2 quotes');
  await expect(page.locator('.quotes-table tbody tr', { hasText: 'SQ-00000902' })).toHaveCount(0);

  // Switch to the Unleashed toggle only.
  await page.locator('#filter-src-tool').click(); // off
  await page.locator('#filter-src-unleashed').click(); // on
  await expect(page.locator('#filter-src-unleashed')).toHaveClass(/on/);
  await expect(page.locator('#quotes-count')).toContainText('Showing 1 quote');
  await expect(page.locator('.quotes-table tbody tr', { hasText: 'SQ-00000902' })).toHaveCount(1);

  // Both toggles on = show all.
  await page.locator('#filter-src-tool').click();
  await expect(page.locator('#quotes-count')).toContainText('Showing 3 quotes');

  // Clear filters resets both toggles off.
  await page.locator('#clear-filters-btn').click();
  await expect(page.locator('#filter-src-tool')).not.toHaveClass(/on/);
  await expect(page.locator('#filter-src-unleashed')).not.toHaveClass(/on/);
  await expect(page.locator('#quotes-count')).toContainText('Showing 3 quotes');
});

test('saved quotes: search matches quote number with or without the SQ- prefix', async ({ page }) => {
  const initialQuotes = [
    { id: 911, business_name: 'Acme Traders', customer: 'Casey', rep: 'Jack', quote_number: 'SQ-00000716', status: 'pending', quote_date: '2026-06-01', freight: 0, freight_in_gp: false, sell_price: 100, gp_percent: 50, line_items: '[]', followups: '[]', created_at: '2026-06-03T00:00:00Z' },
    { id: 912, business_name: 'Sandy Bay Packaging', customer: 'Drew', rep: 'Sam', quote_number: 'SQ-00000842', status: 'pending', quote_date: '2026-06-02', freight: 0, freight_in_gp: false, sell_price: 200, gp_percent: 40, line_items: '[]', followups: '[]', created_at: '2026-06-02T00:00:00Z' },
  ];
  await mockQuotesApi(page, { quotes: initialQuotes });

  await page.goto(appPath);
  await page.locator('button.tab', { hasText: 'Saved quotes' }).click();
  await expect(page.locator('#quotes-count')).toContainText('Showing 2 quotes');

  const search = page.locator('#filter-customer');
  // Full quote number with prefix.
  await search.fill('SQ-00000716');
  await expect(page.locator('#quotes-count')).toContainText('Showing 1 quote');
  await expect(page.locator('.quotes-table')).toContainText('Acme Traders');
  // Without the prefix.
  await search.fill('00000716');
  await expect(page.locator('#quotes-count')).toContainText('Showing 1 quote');
  await expect(page.locator('.quotes-table')).toContainText('Acme Traders');
  // Business name still matches.
  await search.fill('sandy');
  await expect(page.locator('#quotes-count')).toContainText('Showing 1 quote');
  await expect(page.locator('.quotes-table')).toContainText('Sandy Bay Packaging');
  // Contact name still matches.
  await search.fill('casey');
  await expect(page.locator('#quotes-count')).toContainText('Showing 1 quote');
  await expect(page.locator('.quotes-table')).toContainText('Acme Traders');
});

test('saved quotes: date column sorts newest first by default and click toggles to oldest', async ({ page }) => {
  const initialQuotes = [
    { id: 921, business_name: 'Old Co', customer: 'O', rep: 'Jack', quote_number: 'SQ-00000100', status: 'pending', quote_date: '2026-01-05', freight: 0, freight_in_gp: false, sell_price: 100, gp_percent: 50, line_items: '[]', followups: '[]', created_at: '2026-01-05T00:00:00Z' },
    { id: 922, business_name: 'New Co', customer: 'N', rep: 'Jack', quote_number: 'SQ-00000200', status: 'pending', quote_date: '2026-06-20', freight: 0, freight_in_gp: false, sell_price: 200, gp_percent: 40, line_items: '[]', followups: '[]', created_at: '2026-06-20T00:00:00Z' },
  ];
  await mockQuotesApi(page, { quotes: initialQuotes });

  await page.goto(appPath);
  await page.locator('button.tab', { hasText: 'Saved quotes' }).click();

  // Default: newest first.
  await expect(page.locator('.quotes-table tbody tr').first()).toContainText('New Co');
  // Click the Date header → oldest first.
  await page.locator('.quotes-table th', { hasText: 'Date' }).click();
  await expect(page.locator('.quotes-table tbody tr').first()).toContainText('Old Co');
  // Click again → newest first.
  await page.locator('.quotes-table th', { hasText: 'Date' }).click();
  await expect(page.locator('.quotes-table tbody tr').first()).toContainText('New Co');
});

test('removed tabs (Reporting, Follow-up log) no longer render', async ({ page }) => {
  await mockQuotesApi(page);
  await page.goto(appPath);

  const tabs = await page.locator('button.tab').allTextContents();
  expect(tabs).toEqual(['Calculator', 'Landed Cost Calculator', 'Saved quotes']);
  await expect(page.locator('#tab-reporting')).toHaveCount(0);
  await expect(page.locator('#followup-log')).toHaveCount(0);
  await expect(page.locator('#fu-date')).toHaveCount(0);
  // Internal notes stays on the quote form.
  await expect(page.locator('#internal-notes')).toHaveCount(1);
});

test('Ctrl+S saves the quote only while on the Calculator tab', async ({ page }) => {
  const state = { quotes: [] };
  await mockQuotesApi(page, state);

  await page.goto(appPath);
  await page.locator('button.tab', { hasText: 'Saved quotes' }).click();
  await page.keyboard.press('Control+s');
  await page.waitForTimeout(200);
  expect(state.quotes.length).toBe(0);

  await page.locator('button.tab', { hasText: /^Calculator$/ }).click();
  await page.locator('#business-name').fill('Shortcut Co');
  await page.locator('#customer').fill('Sam Patel');
  await page.locator('#rep').selectOption('Jack');
  await page.locator('#status').selectOption('pending');
  await page.locator('#quote-number').fill('SQ-00000900');
  await page.locator('#line-items-body input[data-field="sku"]').first().fill('TESTSKU');
  await page.locator('#line-items-body input[data-field="desc"]').first().fill('Test carton');
  await page.locator('#line-items-body input[data-field="qty"]').first().fill('2');
  await page.locator('#line-items-body input[data-field="cost"]').first().fill('100');
  await page.locator('#line-items-body input[data-field="sell"]').first().fill('150');

  await page.keyboard.press('Control+s');
  await expect(page.locator('#toast')).toContainText('Quote saved successfully');
  expect(state.quotes.length).toBe(1);
});

test('copies the quote summary to the clipboard', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await mockQuotesApi(page);
  await page.goto(appPath);

  await page.locator('#business-name').fill('Clipboard Co');
  await page.locator('#quote-number').fill('SQ-00001000');
  await page.locator('#line-items-body input[data-field="sku"]').first().fill('TESTSKU');
  await page.locator('#line-items-body input[data-field="desc"]').first().fill('Test carton');
  await page.locator('#line-items-body input[data-field="qty"]').first().fill('2');
  await page.locator('#line-items-body input[data-field="cost"]').first().fill('100');
  await page.locator('#line-items-body input[data-field="sell"]').first().fill('150');

  await page.locator('#copy-summary-btn').click();
  await expect(page.locator('#toast')).toContainText('copied to clipboard');

  const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboardText).toContain('Clipboard Co');
  expect(clipboardText).toContain('SQ-00001000');
});

test('shows "(inc GST)" label on the Freight column header in saved quotes', async ({ page }) => {
  const initialQuotes = [
    { id: 901, business_name: 'Freight Co', customer: 'F', rep: 'Jack', quote_number: 'SQ-00000901', status: 'pending', quote_date: '2026-06-01', freight: 0, freight_in_gp: false, sell_price: 100, gp_percent: 10, line_items: '[]', followups: '[]', created_at: '2026-06-01T00:00:00Z' },
  ];
  await mockQuotesApi(page, { quotes: initialQuotes });
  await page.goto(appPath);
  await page.locator('button.tab', { hasText: 'Saved quotes' }).click();
  await expect(page.locator('table.quotes-table th', { hasText: 'Freight' })).toBeVisible();
});

test('shows an empty state on the Landed Cost Calculator when no products are present', async ({ page }) => {
  await mockQuotesApi(page);
  await page.goto(appPath);
  await page.locator('button.tab', { hasText: 'Landed Cost Calculator' }).click();

  await expect(page.locator('#landed-empty-state')).toBeHidden();

  const count = await page.locator('#landed-product-body button.remove-btn').count();
  for (let i = 0; i < count; i++) {
    await page.locator('#landed-product-body tr').first().locator('button.remove-btn').click();
  }

  await expect(page.locator('#landed-empty-state')).toBeVisible();
  await expect(page.locator('#landed-empty-state')).toContainText('Add a product to get started');
});

test('re-fills date lost / date won to today when cleared and status re-triggered', async ({ page }) => {
  await mockQuotesApi(page);
  await page.goto(appPath);

  const today = new Date().toISOString().substring(0, 10);

  await page.locator('#status').selectOption('lost');
  await expect(page.locator('#date-outcome')).toHaveValue(today);
  await page.locator('#date-outcome').fill('');
  await page.locator('#status').selectOption('pending');
  await page.locator('#status').selectOption('lost');
  await expect(page.locator('#date-outcome')).toHaveValue(today);

  await page.locator('#status').selectOption('won');
  await expect(page.locator('#date-won')).toHaveValue(today);
  await page.locator('#date-won').fill('');
  await page.locator('#status').selectOption('pending');
  await page.locator('#status').selectOption('won');
  await expect(page.locator('#date-won')).toHaveValue(today);
});

test('hides internal fields and shows print header when printing', async ({ page }) => {
  await mockQuotesApi(page);
  await page.goto(appPath);

  await page.locator('#business-name').fill('Print Co');
  await page.locator('#quote-number').fill('SQ-00001100');

  await page.emulateMedia({ media: 'print' });

  await expect(page.locator('#print-header')).toBeVisible();
  await expect(page.locator('#tab-calculator .action-row')).toBeHidden();
  await expect(page.locator('#sum-card2')).toBeHidden();
  await expect(page.locator('#sum-card3')).toBeHidden();
  await expect(page.locator('#sum-card1')).toBeVisible();
  await expect(page.locator('#quote-totals')).toBeVisible();
});

test('hides placeholder text on print, leaving blank fields empty', async ({ page }) => {
  await mockQuotesApi(page);
  await page.goto(appPath);

  const businessInput = page.locator('#business-name');
  await expect(businessInput).toHaveAttribute('placeholder', /Bris Port Logistics/);

  await page.emulateMedia({ media: 'print' });

  const placeholderColor = await businessInput.evaluate(el => getComputedStyle(el, '::placeholder').color);
  expect(placeholderColor).toBe('rgba(0, 0, 0, 0)');
  expect(await businessInput.inputValue()).toBe('');
});

test('hides line items with no qty and no sell price entirely on print', async ({ page }) => {
  await mockQuotesApi(page);
  await page.goto(appPath);

  const firstRow = page.locator('#line-items-body tr:not(.line-slider-row)').first();
  await firstRow.locator('input[data-field="qty"]').fill('5');
  await firstRow.locator('input[data-field="sell"]').fill('10');
  await page.locator('#add-line-btn').click();

  const rows = page.locator('#line-items-body tr:not(.line-slider-row)');
  const blankRow = rows.nth(1);

  await page.emulateMedia({ media: 'print' });

  await expect(firstRow).toBeVisible();
  await expect(blankRow).toBeHidden();
});

test('prints line items as a table with columns instead of stacked mobile cards', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await mockQuotesApi(page);
  await page.goto(appPath);

  const firstRow = page.locator('#line-items-body tr:not(.line-slider-row)').first();
  await firstRow.locator('input[data-field="qty"]').fill('5');
  await firstRow.locator('input[data-field="sell"]').fill('10');

  await page.emulateMedia({ media: 'print' });

  const table = page.locator('.line-table').first();
  await expect(table.locator('thead')).toBeVisible();
  await expect(table).toHaveCSS('display', 'table');
  await expect(firstRow).toHaveCSS('display', 'table-row');

  const firstCell = firstRow.locator('td:not(.no-print)').first();
  await expect(firstCell).toHaveCSS('display', 'table-cell');
});

test('clears all line items after confirmation and leaves one fresh blank line', async ({ page }) => {
  await mockQuotesApi(page);
  await page.goto(appPath);

  await page.locator('#line-items-body input[data-field="sku"]').nth(0).fill('FIRST');
  await page.locator('#add-line-btn').click();
  await page.locator('#line-items-body input[data-field="sku"]').nth(1).fill('SECOND');
  // Dismiss the product-search dropdown so it doesn't overlay the Clear-all button.
  await page.locator('#line-items-body input[data-field="sku"]').nth(1).blur();

  await expect(page.locator('#line-items-body tr:not(.line-slider-row)')).toHaveCount(2);

  await page.locator('#clear-lines-btn').click();

  await expect(page.locator('#remove-overlay')).toHaveClass(/show/);
  await expect(page.locator('#remove-overlay')).toContainText('Are you sure you want to clear all lines? This cannot be undone.');
  await page.locator('#remove-confirm').click();

  const rows = page.locator('#line-items-body tr:not(.line-slider-row)');
  await expect(rows).toHaveCount(1);
  await expect(rows.first().locator('input[data-field="sku"]')).toHaveValue('');
});

test('expiry date defaults to 30 days after quote date and tracks it until manually overridden', async ({ page }) => {
  await mockQuotesApi(page);
  await page.goto(appPath);

  const quoteDate = page.locator('#quote-date');
  const expiryDate = page.locator('#expiry-date');

  // Default expiry is 30 days after the quote date.
  const addDays = (iso, n) => {
    const p = iso.split('-').map(Number);
    const d = new Date(p[0], p[1] - 1, p[2]);
    d.setDate(d.getDate() + n);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const startQuote = await quoteDate.inputValue();
  expect(await expiryDate.inputValue()).toBe(addDays(startQuote, 30));

  // Changing the quote date auto-updates expiry (not manually overridden yet).
  await quoteDate.fill('2026-03-01');
  await quoteDate.dispatchEvent('change');
  expect(await expiryDate.inputValue()).toBe('2026-03-31');

  // Manual override sticks and stops tracking the quote date.
  await expiryDate.fill('2026-05-15');
  await quoteDate.fill('2026-04-01');
  await quoteDate.dispatchEvent('change');
  expect(await expiryDate.inputValue()).toBe('2026-05-15');
});

test('template and compare-suppliers UI are hidden but present in the DOM', async ({ page }) => {
  await mockQuotesApi(page);
  await page.goto(appPath);

  await expect(page.locator('#save-template-btn')).toBeHidden();
  await expect(page.locator('#load-template-btn')).toBeHidden();
  await expect(page.locator('#save-template-btn')).toHaveCount(1);

  await page.locator('button:has-text("Landed Cost Calculator")').click();
  await expect(page.locator('button:has-text("Compare suppliers / shipments")')).toBeHidden();
});

test('duplicates a line item directly below the original with a copy of its values and a unique id', async ({ page }) => {
  await mockQuotesApi(page);
  await page.goto(appPath);

  const firstRow = page.locator('#line-items-body tr:not(.line-slider-row)').first();
  await firstRow.locator('input[data-field="sku"]').fill('WIDGET-1');
  await firstRow.locator('input[data-field="desc"]').fill('Blue widget');
  await firstRow.locator('input[data-field="qty"]').fill('10');
  await firstRow.locator('input[data-field="cost"]').fill('5');
  await firstRow.locator('input[data-field="sell"]').fill('12');

  const originalId = await firstRow.getAttribute('data-line-id');

  await firstRow.locator('.dup-btn').click();

  const rows = page.locator('#line-items-body tr:not(.line-slider-row)');
  await expect(rows).toHaveCount(2);

  // Copy sits directly below the original and carries the same field values.
  const copyRow = rows.nth(1);
  await expect(copyRow.locator('input[data-field="sku"]')).toHaveValue('WIDGET-1');
  await expect(copyRow.locator('input[data-field="desc"]')).toHaveValue('Blue widget');
  await expect(copyRow.locator('input[data-field="qty"]')).toHaveValue('10');
  await expect(copyRow.locator('input[data-field="cost"]')).toHaveValue('5');
  await expect(copyRow.locator('input[data-field="sell"]')).toHaveValue('12');

  // The duplicate has its own unique id.
  const copyId = await copyRow.getAttribute('data-line-id');
  expect(copyId).not.toBe(originalId);

  // Adjusting the copy's qty does not affect the original (a different tier).
  await copyRow.locator('input[data-field="qty"]').fill('50');
  await expect(rows.nth(0).locator('input[data-field="qty"]')).toHaveValue('10');
});

test('Print — Customer hides GP fields, cost prices, and the internal banner', async ({ page }) => {
  await mockQuotesApi(page);
  await page.goto(appPath);

  await page.locator('#line-items-body input[data-field="cost"]').nth(0).fill('10');
  await page.locator('#line-items-body input[data-field="sell"]').nth(0).fill('20');

  await page.emulateMedia({ media: 'print' });

  await expect(page.locator('body')).not.toHaveClass(/print-internal/);
  await expect(page.locator('#internal-print-banner')).toBeHidden();
  await expect(page.locator('#gp-internal-summary')).toBeHidden();
  await expect(page.locator('.line-table thead th.gp-field').first()).toBeHidden();
  await expect(page.locator('#sum-card2')).toBeHidden();
  await expect(page.locator('#sum-card3')).toBeHidden();
});

test('Print — Internal shows GP fields, cost prices, GP summary, and the internal banner', async ({ page }) => {
  await mockQuotesApi(page);
  await page.goto(appPath);

  await page.locator('#line-items-body input[data-field="cost"]').nth(0).fill('10');
  await page.locator('#line-items-body input[data-field="sell"]').nth(0).fill('20');

  await page.locator('#print-internal-btn').click();
  await page.emulateMedia({ media: 'print' });

  await expect(page.locator('body')).toHaveClass(/print-internal/);
  await expect(page.locator('#internal-print-banner')).toBeVisible();
  await expect(page.locator('#internal-print-banner')).toContainText('INTERNAL — NOT FOR CUSTOMER');
  await expect(page.locator('#gp-internal-summary')).toBeVisible();
  await expect(page.locator('.line-table thead th.gp-field').first()).toBeVisible();
  await expect(page.locator('#sum-card2')).toBeVisible();
  await expect(page.locator('#sum-card3')).toBeVisible();
});

test('line item row is not draggable until the drag handle is grabbed', async ({ page }) => {
  await mockQuotesApi(page);
  await page.goto(appPath);

  const firstRow = page.locator('#line-items-body tr:not(.line-slider-row)').first();
  await expect(firstRow).toHaveJSProperty('draggable', false);

  const handleCell = firstRow.locator('.drag-handle-cell');
  const box = await handleCell.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await expect(firstRow).toHaveJSProperty('draggable', true);
  await page.mouse.up();
  await expect(firstRow).toHaveJSProperty('draggable', false);
});

test('SKU and description fields behave as plain inputs with no expand-on-focus', async ({ page }) => {
  await mockQuotesApi(page);
  await page.goto(appPath);

  const descInput = page.locator('#line-items-body input[data-field="desc"]').first();
  await descInput.fill('A long product description that does not fit in the column width');

  const unfocusedWidth = (await descInput.boundingBox()).width;
  const unfocusedY = (await descInput.boundingBox()).y;
  await descInput.click();
  const focusedBox = await descInput.boundingBox();
  expect(focusedBox.width).toBe(unfocusedWidth);
  expect(focusedBox.y).toBe(unfocusedY);

  // Triple-click should select text within the field rather than starting a drag
  await descInput.click({ clickCount: 3 });
  const selected = await descInput.evaluate(el => el.value.substring(el.selectionStart, el.selectionEnd));
  expect(selected.length).toBeGreaterThan(0);
});

test('dragging the description resize handle widens description without changing SKU width', async ({ page }) => {
  await mockQuotesApi(page);
  await page.goto(appPath);

  const skuTh = page.locator('#col-th-sku');
  const descTh = page.locator('#col-th-desc');
  const startSkuWidth = (await skuTh.boundingBox()).width;
  const startDescWidth = (await descTh.boundingBox()).width;

  const handle = page.locator('.col-resize-handle[data-col="col-th-desc"]');
  const box = await handle.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2);
  await page.mouse.up();

  const endSkuWidth = (await skuTh.boundingBox()).width;
  const endDescWidth = (await descTh.boundingBox()).width;

  expect(endDescWidth).toBeGreaterThan(startDescWidth + 40);
  expect(Math.abs(endSkuWidth - startSkuWidth)).toBeLessThan(1);
});

test('dragging the SKU resize handle widens SKU without changing description width', async ({ page }) => {
  await mockQuotesApi(page);
  await page.goto(appPath);

  const skuTh = page.locator('#col-th-sku');
  const descTh = page.locator('#col-th-desc');
  const startSkuWidth = (await skuTh.boundingBox()).width;
  const startDescWidth = (await descTh.boundingBox()).width;

  const handle = page.locator('.col-resize-handle[data-col="col-th-sku"]');
  const box = await handle.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2);
  await page.mouse.up();

  const endSkuWidth = (await skuTh.boundingBox()).width;
  const endDescWidth = (await descTh.boundingBox()).width;
  expect(endSkuWidth).toBeGreaterThan(startSkuWidth + 40);
  expect(Math.abs(endDescWidth - startDescWidth)).toBeLessThan(1);
});

test('shrinking the SKU column leaves description and other columns unchanged', async ({ page }) => {
  await mockQuotesApi(page);
  await page.goto(appPath);

  // Widen SKU first so there is room to shrink it back down.
  const skuHandle = page.locator('.col-resize-handle[data-col="col-th-sku"]');
  let box = await skuHandle.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2);
  await page.mouse.up();

  const skuTh = page.locator('#col-th-sku');
  const descTh = page.locator('#col-th-desc');
  const qtyTh = page.locator('.line-table thead th').nth(3);
  const startSkuWidth = (await skuTh.boundingBox()).width;
  const startDescWidth = (await descTh.boundingBox()).width;
  const startQtyWidth = (await qtyTh.boundingBox()).width;

  // Now shrink SKU back down — the failure mode where siblings used to grow.
  box = await skuHandle.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 80, box.y + box.height / 2);
  await page.mouse.up();

  const endSkuWidth = (await skuTh.boundingBox()).width;
  const endDescWidth = (await descTh.boundingBox()).width;
  const endQtyWidth = (await qtyTh.boundingBox()).width;

  expect(endSkuWidth).toBeLessThan(startSkuWidth - 40);
  expect(Math.abs(endDescWidth - startDescWidth)).toBeLessThan(1);
  expect(Math.abs(endQtyWidth - startQtyWidth)).toBeLessThan(1);
});
