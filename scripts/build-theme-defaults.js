#!/usr/bin/env node
/* REGENERATE THE PAGE'S TOKEN DEFAULTS BLOCK from src/theme-tokens.js.
 *
 * public/index.html carries the whole default palette as a generated
 * `<style id="themeDefaults">` block. It is generated rather than hand-kept for
 * the obvious reason — a hundred values in two places drift — and it is IN the
 * page rather than only on the server for a less obvious one: the page must be
 * able to render correctly with no theme, no database and no request at all.
 * The server injects the SAVED overrides after it; this is the floor.
 *
 * tests/theme.test.js fails if the block and the catalogue disagree, so this
 * script is the fix for that failure rather than something anybody has to
 * remember to run.
 *
 *   node scripts/build-theme-defaults.js          rewrite the block
 *   node scripts/build-theme-defaults.js --check  exit 1 if it is stale
 */
process.env.DB_NAME = process.env.DB_NAME || 'unused';
process.env.DB_USER = process.env.DB_USER || 'unused';

const fs = require('node:fs');
const path = require('node:path');
const theme = require('../src/theme');

const PAGE = path.join(__dirname, '..', 'public', 'index.html');
const OPEN = '<style id="themeDefaults">';
const CLOSE = '</style>';
const NOTE = '/* GENERATED from src/theme-tokens.js by scripts/build-theme-defaults.js.\n'
  + '   Do not edit by hand: tests/theme.test.js fails if this and the catalogue disagree.\n'
  + '   Every value here is the colour this application shipped with, and the server\n'
  + '   injects a saved theme AFTER this block, so an untouched studio sees exactly this. */';

function block() {
  return `${OPEN}\n${NOTE}\n${theme.cssFor()}\n${CLOSE}`;
}

const src = fs.readFileSync(PAGE, 'utf8');
const at = src.indexOf(OPEN);
if (at === -1) {
  console.error('public/index.html has no <style id="themeDefaults"> block to fill.');
  process.exit(2);
}
const end = src.indexOf(CLOSE, at) + CLOSE.length;
const next = src.slice(0, at) + block() + src.slice(end);

if (process.argv.includes('--check')) {
  if (next !== src) {
    console.error('The theme defaults block in public/index.html is stale. '
      + 'Run: node scripts/build-theme-defaults.js');
    process.exit(1);
  }
  console.log('The theme defaults block is up to date.');
  process.exit(0);
}
fs.writeFileSync(PAGE, next);
console.log(`Wrote ${theme.all().length} token defaults into public/index.html.`);
