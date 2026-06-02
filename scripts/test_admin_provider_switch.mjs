#!/usr/bin/env node
/**
 * E2E: admin AI model provider switch (Cursor <-> third_party)
 * Usage: node scripts/test_admin_provider_switch.mjs [baseUrl]
 */
import { chromium } from "playwright";

const BASE = process.argv[2] || "https://annalog.jpgk.cn";
const ADMIN_ACCOUNT = process.env.ADMIN_ACCOUNT || "13473458864";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "1qaz2wsx";

function fail(msg) {
  console.error("FAIL:", msg);
  process.exit(1);
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (err) => errors.push(String(err)));

  await page.goto(`${BASE}/admin#models`, { waitUntil: "networkidle" });

  await page.fill("#loginAccount", ADMIN_ACCOUNT);
  await page.fill("#loginPassword", ADMIN_PASSWORD);
  await page.click("#loginSubmit");
  await page.waitForSelector("#adminScreen:not([hidden])", { timeout: 15000 });

  await page.click('[data-admin-page="models"]');
  await page.waitForSelector("#adminPageModels:not([hidden])", { timeout: 5000 });

  const thirdBtn = page.locator('#analysisProviderSwitch [data-analysis-provider="third_party"]');
  const cursorBtn = page.locator('#analysisProviderSwitch [data-analysis-provider="cursor"]');
  const status = page.locator("#analysisProviderStatus");

  await thirdBtn.click();
  await page.waitForTimeout(1500);

  const thirdActive = await thirdBtn.evaluate((el) => el.classList.contains("is-active"));
  const statusAfterThird = await status.textContent();
  if (!thirdActive) fail(`third_party button not active after click. status=${statusAfterThird}`);
  if (!/第三方/.test(statusAfterThird || "")) {
    fail(`status text unexpected after third_party click: ${statusAfterThird}`);
  }

  await cursorBtn.click();
  await page.waitForTimeout(1500);

  const cursorActive = await cursorBtn.evaluate((el) => el.classList.contains("is-active"));
  const statusAfterCursor = await status.textContent();
  if (!cursorActive) fail(`cursor button not active after click. status=${statusAfterCursor}`);
  if (!/Cursor/.test(statusAfterCursor || "")) {
    fail(`status text unexpected after cursor click: ${statusAfterCursor}`);
  }

  if (errors.length) {
    console.warn("page errors:", errors);
  }

  console.log("PASS: provider switch UI and status update correctly");
  console.log("  third_party status:", statusAfterThird?.trim());
  console.log("  cursor status:", statusAfterCursor?.trim());
  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
