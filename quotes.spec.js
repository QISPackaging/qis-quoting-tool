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
      const filtered = statusFilter ? quotes.filter(q => q.status === statusFilter) : quotes;
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
        body: JSON.stringify([]),
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

test('flags pending quotes with past follow-up dates and shows overdue tab badge', async ({ page }) => {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const dateString = yesterday.toISOString().substring(0,10);
  const initialQuotes = [
    {
      id: 401,
      business_name: 'Overdue Co',
      customer: 'Alex',
      rep: 'Jack',
      quote_number: 'SQ-00000222',
      status: 'pending',
      quote_date: '2026-06-10',
      freight: 0,
      freight_in_gp: false,
      sell_price: 200,
      gp_percent: 25,
      line_items: '[]',
      followups: [{id:1,date:dateString,note:'Follow-up overdue'}],
      created_at: '2026-06-10T00:00:00Z',
    },
  ];
  await mockQuotesApi(page, { quotes: initialQuotes });

  await page.goto(appPath);
  await page.locator('button.tab', { hasText: 'Saved quotes' }).click();

  await expect(page.locator('button#tab-button-quotes')).toHaveText('Saved quotes (1)');
  await expect(page.locator('table.quotes-table tbody tr', { hasText: 'Overdue Co' }).locator('span.overdue-dot')).toBeVisible();
});

test('shows reporting chart for quote statuses', async ({ page }) => {
  const initialQuotes = [
    { id: 301, status: 'won', rep: 'Jack', gp_percent: 65, sell_price: 1200 },
    { id: 302, status: 'lost', rep: 'Jack', gp_percent: 48, sell_price: 800 },
    { id: 303, status: 'pending', rep: 'Sam', gp_percent: 20, sell_price: 300 },
    { id: 304, status: 'withdrawn', rep: 'Liam', gp_percent: 0, sell_price: 150 },
    { id: 305, status: 'won', rep: 'Ava', gp_percent: 70, sell_price: 1000 }
  ];
  await mockQuotesApi(page, { quotes: initialQuotes });

  const appPath = 'file://' + path.join(__dirname, '..', 'index.html');
  await page.goto(appPath);
  await page.locator('button:has-text("Reporting")').click();

  await expect(page.locator('#reporting-summary')).toContainText('Won');
  await expect(page.locator('#reporting-summary')).toContainText('2');
  await expect(page.locator('#reporting-summary')).toContainText('Lost');
  await expect(page.locator('#reporting-summary')).toContainText('1');
  await expect(page.locator('#reporting-summary')).toContainText('Pending');
  await expect(page.locator('#reporting-summary')).toContainText('1');
  await expect(page.locator('#reporting-summary')).toContainText('Withdrawn');
  await expect(page.locator('#reporting-summary')).toContainText('1');
  await expect(page.locator('#reporting-chart')).toBeVisible();
  await expect(page.locator('#reporting-metrics')).toContainText('Total value won');
  await expect(page.locator('#reporting-metrics')).toContainText('$2,200.00');
  await expect(page.locator('#reporting-metrics')).toContainText('Total value lost');
  await expect(page.locator('#reporting-metrics')).toContainText('$800.00');
  await expect(page.locator('#reporting-metrics')).toContainText('Win rate');
  await expect(page.locator('#reporting-metrics')).toContainText('66.7%');
  await expect(page.locator('#reporting-metrics')).toContainText('Avg GP% on won quotes');
  await expect(page.locator('#reporting-metrics')).toContainText('67.5%');
  await expect(page.locator('#reporting-metrics')).toContainText('Avg GP% on lost quotes');
  await expect(page.locator('#reporting-metrics')).toContainText('48.0%');
  await expect(page.locator('#reporting-metrics')).toContainText('Quotes by rep');
  await expect(page.locator('#reporting-metrics')).toContainText('Jack');
  await expect(page.locator('#reporting-metrics')).toContainText('2');
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
  await expect(page.locator('#remove-overlay')).toContainText('Are you sure you want to delete this quote? This cannot be undone.');
  await page.locator('#remove-confirm').click();

  await expect(page.locator('#toast')).toContainText('Quote deleted');
  await expect(page.locator('#quotes-container')).toContainText('No quotes found');
  expect(state.quotes.length).toBe(0);
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

  await expect(page.locator('#landed-ocean-freight')).toHaveValue('1100');
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

test('clears all line items after confirmation and leaves one fresh blank line', async ({ page }) => {
  await mockQuotesApi(page);
  await page.goto(appPath);

  await page.locator('#line-items-body input[data-field="sku"]').nth(0).fill('FIRST');
  await page.locator('#add-line-btn').click();
  await page.locator('#line-items-body input[data-field="sku"]').nth(1).fill('SECOND');

  await expect(page.locator('#line-items-body tr:not(.line-slider-row)')).toHaveCount(2);

  await page.locator('#clear-lines-btn').click();

  await expect(page.locator('#remove-overlay')).toHaveClass(/show/);
  await expect(page.locator('#remove-overlay')).toContainText('Are you sure you want to clear all lines? This cannot be undone.');
  await page.locator('#remove-confirm').click();

  const rows = page.locator('#line-items-body tr:not(.line-slider-row)');
  await expect(rows).toHaveCount(1);
  await expect(rows.first().locator('input[data-field="sku"]')).toHaveValue('');
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

test('SKU and description fields expand on focus and allow normal text selection', async ({ page }) => {
  await mockQuotesApi(page);
  await page.goto(appPath);

  const descInput = page.locator('#line-items-body input[data-field="desc"]').first();
  await descInput.fill('A long product description that does not fit in the column width');

  const unfocusedWidth = (await descInput.boundingBox()).width;
  await descInput.click();
  const focusedWidth = (await descInput.boundingBox()).width;
  expect(focusedWidth).toBeGreaterThanOrEqual(unfocusedWidth);
  expect(focusedWidth).toBeGreaterThanOrEqual(260);

  // Triple-click should select text within the field rather than starting a drag
  await descInput.click({ clickCount: 3 });
  const selected = await descInput.evaluate(el => el.value.substring(el.selectionStart, el.selectionEnd));
  expect(selected.length).toBeGreaterThan(0);
});
