const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto('https://trofos-production.comp.nus.edu.sg/login');
  console.log("Log in manually using 'Sign in with NUS (Student)'...");

  // Wait until redirected to project page
  await page.waitForURL('**/project/**', { timeout: 0 });

  // Save session
  await context.storageState({ path: 'trofos-session.json' });
  console.log('Session saved to trofos-session.json');

  await browser.close();
})();
