/* Trims each capture to what is actually on it.
 *
 * A full-page screenshot of a project with five columns is 1680x1000 whether
 * the content ends at 700px or at 1000, and the empty remainder is a third of
 * every picture in the manual and a third of every slide. This finds the last
 * row and column that differ from the page background and cuts there.
 *
 * Two captures are cut short instead of trimmed: the Activity Log and the
 * permission grid are longer than a page and are shown to be READ, so they are
 * held to their first screenful and the caption says so.
 */
const { chromium } = require('playwright');
const fs = require('fs');
const DIR = require('path').join(__dirname, '..', 'shots');
const CAP = { '12-settings-activity': 1000, '12-settings-permissions-role': 980 };
const PAD = 12;

(async () => {
  const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const p = await br.newPage();
  const names = fs.readdirSync(DIR).filter((f) => f.endsWith('.png')).map((f) => f.replace('.png', ''));

  for (const name of names) {
    const src = `${DIR}/${name}.png`;
    const b64 = fs.readFileSync(src).toString('base64');
    const out = await p.evaluate(async ([data, cap, pad]) => {
      const im = new Image();
      await new Promise((ok, no) => { im.onload = ok; im.onerror = no; im.src = 'data:image/png;base64,' + data; });
      const W = im.naturalWidth, H = im.naturalHeight;
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(im, 0, 0);
      const px = g.getImageData(0, 0, W, H).data;
      const at = (x, y) => (y * W + x) * 4;
      // The background is whatever fills the bottom-left corner.
      const bg = [px[at(2, H - 3)], px[at(2, H - 3) + 1], px[at(2, H - 3) + 2]];
      const same = (i) => Math.abs(px[i] - bg[0]) < 10 && Math.abs(px[i + 1] - bg[1]) < 10
        && Math.abs(px[i + 2] - bg[2]) < 10;
      const rowEmpty = (y) => { for (let x = 0; x < W; x += 2) if (!same(at(x, y))) return false; return true; };
      const colEmpty = (x) => { for (let y = 0; y < H; y += 2) if (!same(at(x, y))) return false; return true; };
      let bottom = H; while (bottom > 40 && rowEmpty(bottom - 1)) bottom -= 1;
      let right = W; while (right > 200 && colEmpty(right - 1)) right -= 1;
      let h = Math.min(H, bottom + pad);
      const w = Math.min(W, right + pad);
      if (cap) h = Math.min(h, cap);
      if (w === W && h === H) return null;            // nothing to trim
      const o = document.createElement('canvas');
      o.width = w; o.height = h;
      o.getContext('2d').drawImage(c, 0, 0, w, h, 0, 0, w, h);
      return { data: o.toDataURL('image/png').split(',')[1], w, h, W, H };
    }, [b64, CAP[name] || 0, PAD]);

    /* Written back over the capture rather than beside it: an untrimmed copy
       is only ever one shoot.js away, and one file per screenshot means the
       builders have no choice to get wrong. Re-running this is a no-op. */
    if (!out) { console.log('  =', name, '(nothing to trim)'); continue; }
    fs.writeFileSync(src, Buffer.from(out.data, 'base64'));
    console.log(`  ${name}: ${out.W}x${out.H} -> ${out.w}x${out.h}`);
  }
  await br.close();
})().catch((e) => { console.error(e); process.exit(1); });
