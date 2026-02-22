require("dotenv").config();
const { chromium } = require("playwright");

async function postStory({ title, description = "", sprint = "", epic = "", priority = "", assignee = "", points = "" }) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ storageState: "trofos-session.json" });
  const page = await context.newPage();

  try {
    await page.goto("https://trofos-production.comp.nus.edu.sg/project/258/sprint", { waitUntil: 'domcontentloaded' });

    // Open New Backlog modal
    await page.locator('button:has-text("New Backlog")').waitFor({ timeout: 8000 });
    await page.locator('button:has-text("New Backlog")').click();

    // Title
    await page.locator('.summary-input').fill(title);

  // Type - fixed to 'Story'
  await page.locator('label[for="type"] + div .ant-select-selector').click();
  await page.waitForSelector('.ant-select-dropdown', { timeout: 5000 });
  await page.locator('.ant-select-dropdown .ant-select-item', { hasText: 'Story' }).first().click();

  // Reporter - fixed to AUTHOR
  const reporter = process.env.AUTHOR || "";
  if (reporter) {
    await page.locator('label[for="reporterId"] + div .ant-select-selector').click();
    await page.waitForSelector('.ant-select-dropdown', { timeout: 5000 });
    await page.locator('.ant-select-dropdown .ant-select-item', { hasText: reporter }).first().click();
  }

  // Auto-generated fields: sprint, epic, priority, points, description
  if (sprint) {
    await page.locator('label[for="sprintId"] + div .ant-select-selector').click();
    await page.waitForSelector('.ant-select-dropdown', { timeout: 5000 });
    await page.locator('.ant-select-dropdown .ant-select-item', { hasText: sprint }).first().click();
  }

  if (epic) {
    await page.locator('label[for="epicId"] + div .ant-select-selector').click();
    await page.waitForSelector('.ant-select-dropdown', { timeout: 5000 });
    await page.locator('.ant-select-dropdown .ant-select-item', { hasText: epic }).first().click();
  }

  if (priority) {
    await page.locator('label[for="priority"] + div .ant-select-selector').click();
    await page.waitForSelector('.ant-select-dropdown', { timeout: 5000 });
    await page.locator('.ant-select-dropdown .ant-select-item', { hasText: priority }).first().click();
  }

  if (points !== undefined && points !== null && points !== "") {
    await page.locator('.ant-input-number-input').fill(String(points));
  }

  if (assignee) {
    await page.locator('label[for="assigneeId"] + div .ant-select-selector').click();
    await page.waitForSelector('.ant-select-dropdown', { timeout: 5000 });
    await page.locator('.ant-select-dropdown .ant-select-item', { hasText: assignee }).first().click();
  }

    await page.locator('.backlog-textarea').fill(description || 'No description provided.');

    // Submit
    await page.locator('button:has-text("Create")').click();

    console.log(`Posted story: ${title}`);
  } catch (err) {
    console.error(`Error posting story '${title}': ${err.message}`);
    throw err;
  } finally {
    try {
      await browser.close();
    } catch (e) {
      // ignore
    }
  }
}

module.exports = { postStory };
