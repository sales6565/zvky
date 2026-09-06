/* The application icon and the installer's sidebar, generated rather than
 * checked in as opaque binaries.
 *
 * Two reasons it is a script. A checked-in PNG is a file nobody can correct —
 * the brand red is a value in the web application (--brand, #7f1416) and an
 * icon carrying a hand-picked approximation of it drifts the first time
 * somebody adjusts one. And an icon somebody can regenerate is one a studio can
 * restyle without asking for a new build of the wrapper.
 *
 * THE ICON is drawn as HTML and photographed by Chromium, which is already on
 * this machine for the web application's own screenshot pipeline. That avoids
 * adding an image library to a project whose entire job is to open a window.
 * electron-builder derives the Windows .ico and the macOS .icns from the single
 * 1024px PNG, so there is one source image rather than three.
 *
 * THE SIDEBAR is a Windows installer BMP, written here by hand. NSIS wants an
 * uncompressed 24-bit BMP at exactly 164x314, which is a format simple enough
 * to write in forty lines and not worth a dependency.
 */
const fs = require('node:fs');
const path = require('node:path');

const BUILD = path.join(__dirname, '..', 'build');
/* The web application's own --brand. If the studio restyles, this is the one
   value to change here, and it is the same string they would change there. */
const BRAND = '#7f1416';
const INK = '#f4f1ec';

fs.mkdirSync(BUILD, { recursive: true });

// ---------------------------------------------------------------- the sidebar
/* An uncompressed 24-bit BMP. Rows are stored bottom-up and each one is padded
   to a multiple of four bytes — the two details that make a hand-written BMP
   either work or come out sheared. */
function writeBmp(file, width, height, pixelAt) {
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const pixels = Buffer.alloc(rowSize * height);
  for (let y = 0; y < height; y += 1) {
    // Bottom-up: row 0 of the file is the LAST row of the image.
    const row = (height - 1 - y) * rowSize;
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = pixelAt(x, y);
      // BGR, not RGB.
      pixels[row + x * 3] = b;
      pixels[row + x * 3 + 1] = g;
      pixels[row + x * 3 + 2] = r;
    }
  }
  const header = Buffer.alloc(54);
  header.write('BM', 0);
  header.writeUInt32LE(54 + pixels.length, 2);   // file size
  header.writeUInt32LE(54, 10);                  // where the pixels start
  header.writeUInt32LE(40, 14);                  // header size
  header.writeInt32LE(width, 18);
  header.writeInt32LE(height, 22);
  header.writeUInt16LE(1, 26);                   // planes
  header.writeUInt16LE(24, 28);                  // bits per pixel
  header.writeUInt32LE(pixels.length, 34);
  fs.writeFileSync(file, Buffer.concat([header, pixels]));
}

const hex = (s) => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];

function sidebar() {
  const W = 164; const H = 314;
  const [r, g, b] = hex(BRAND);
  /* A vertical fade from the brand red to a darker version of itself. Not a
     second colour: a gradient between two brand colours reads as a brand, and a
     gradient into an arbitrary one reads as a mistake. */
  writeBmp(path.join(BUILD, 'installer-sidebar.bmp'), W, H, (x, y) => {
    const t = y / (H - 1);
    const k = 1 - t * 0.55;
    return [Math.round(r * k), Math.round(g * k), Math.round(b * k)];
  });
  console.log('wrote build/installer-sidebar.bmp  164x314');
}

// ------------------------------------------------------------------- the icon
const ICON_HTML = `<!doctype html><meta charset="utf-8">
<style>
  html,body{margin:0;padding:0;width:1024px;height:1024px;background:transparent;}
  .tile{
    width:1024px;height:1024px;box-sizing:border-box;
    /* A rounded square at roughly the proportion both platforms round to
       themselves, so it looks deliberate on Windows and is not clipped oddly
       when macOS applies its own mask. */
    border-radius:210px;
    background:linear-gradient(160deg, ${BRAND} 0%, #5c0e10 100%);
    display:flex;align-items:center;justify-content:center;
    box-shadow:inset 0 -18px 60px rgba(0,0,0,.28);
  }
  .z{
    font-family:Georgia,'Times New Roman',serif;
    font-weight:700;font-size:660px;line-height:1;color:${INK};
    letter-spacing:-12px;
    /* Lifted a touch: a capital sits optically low when centred by its box. */
    transform:translateY(-24px);
    text-shadow:0 10px 30px rgba(0,0,0,.30);
  }
</style>
<div class="tile"><span class="z">Z</span></div>`;

async function icon() {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  });
  const page = await (await browser.newContext({
    viewport: { width: 1024, height: 1024 }, deviceScaleFactor: 1,
  })).newPage();
  await page.setContent(ICON_HTML, { waitUntil: 'load' });
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(BUILD, 'icon.png'), omitBackground: true });
  await browser.close();
  console.log('wrote build/icon.png  1024x1024');
}

sidebar();
icon().catch((err) => {
  console.error('The icon needs Chromium. Set CHROMIUM_PATH, or install Playwright:');
  console.error(err.message);
  process.exit(1);
});
