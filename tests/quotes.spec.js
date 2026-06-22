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
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(quotes),
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
