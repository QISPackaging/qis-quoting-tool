const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  use: {
    baseURL: 'https://qis-quoting-tool.netlify.app',
    headless: true,
    trace: 'on-first-retry',
    viewport: { width: 1440, height: 900 },
    launchOptions: process.env.PW_CHROME_PATH ? { executablePath: process.env.PW_CHROME_PATH } : {},
  },
});
