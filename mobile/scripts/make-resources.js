#!/usr/bin/env node
/* Produce resources/icon.png and resources/splash.png from resources/source.html.
 *
 * WHY A SCRIPT AND NOT TWO CHECKED-IN IMAGES. The two have to agree — an icon
 * and a launch screen showing different marks is the kind of thing nobody
 * notices until it is on fifty phones — and a studio replacing the placeholder
 * mark should have to change ONE file. Rendering them from the same HTML makes
 * that structural rather than a thing to remember.
 *
 * Run it with any Chromium that Playwright or Puppeteer can drive:
 *   node scripts/make-resources.js
 * then `npm run icons`, which is what turns these two into the twenty-odd sizes
 * iOS and Android actually want.
 *
 * If this machine has no browser, that is not a blocker: drop a 1024x1024
 * icon.png and a 2732x2732 splash.png into resources/ by hand and skip this.
 */
const path = require('node:path');
const fs = require('node:fs');

const RES = path.join(__dirname, '..', 'resources');
const SRC = 'file://' + path.join(RES, 'source.html');

async function chromium() {
  for (const mod of ['playwright', 'puppeteer', '/opt/node22/lib/node_modules/playwright']) {
    try { return require(mod); } catch { /* try the next */ }
  }
  return null;
}

(async () => {
  const driver = await chromium();
  if (!driver) {
    console.error('No Playwright or Puppeteer on this machine.');
    console.error('Put a 1024x1024 icon.png and a 2732x2732 splash.png in resources/ by hand instead.');
    process.exit(1);
  }
  const launch = driver.chromium ? driver.chromium.launch.bind(driver.chromium) : driver.launch.bind(driver);
  const browser = await launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ['--no-sandbox'],
  });
  for (const [name, size, cls] of [['icon.png', 1024, ''], ['splash.png', 2732, 'splash']]) {
    const page = await browser.newPage(
      driver.chromium ? { viewport: { width: size, height: size }, deviceScaleFactor: 1 } : undefined);
    if (!driver.chromium) await page.setViewport({ width: size, height: size });
    await page.goto(SRC, { waitUntil: 'load' });
    if (cls) await page.evaluate((c) => { document.body.className = c; }, cls);
    await page.screenshot({ path: path.join(RES, name) });
    await page.close();
    const { size: bytes } = fs.statSync(path.join(RES, name));
    console.log(`resources/${name}  ${size}x${size}  ${(bytes / 1024).toFixed(0)} KB`);
  }
  await browser.close();
  console.log('\nNow run: npm run icons');
})();
