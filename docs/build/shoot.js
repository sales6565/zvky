/* Every screenshot the manual and the deck use, taken from the running
   application as whichever role the section is about. Named <module>-<step> so
   both documents draw on one set and a re-run replaces them all. */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const OUT = path.join(__dirname, '..', 'shots');
const D = JSON.parse(fs.readFileSync(path.join(__dirname, 'ids.json'), 'utf8'));
const PASS = 'Zvky-Demo-1!';
const W = 1680, H = 1000;
let n = 0;
const shot = async (p, name, target) => {
  n++;
  const el = target ? await p.$(target) : null;
  if (target && !el) { console.log('  ✗ MISSING', name, target); return false; }
  await (el || p).screenshot({ path: `${OUT}/${name}.png` });
  console.log('  ✓', name);
  return true;
};
const signIn = async (p, email) => {
  await p.goto('http://127.0.0.1:4415/');
  await p.fill('#loginEmail', email); await p.fill('#loginPassword', PASS);
  await p.click('#loginBtn'); await p.waitForSelector('#mainTabs', { timeout: 20000 });
  await p.waitForTimeout(2800);
  if (await p.$('.tour-pop')) { await p.keyboard.press('Escape'); await p.waitForTimeout(500); }
};
/* Nothing optional is allowed to stop the run. A modal that will not close, a
   button that moved — the shoot logs it and carries on, because one missing
   screenshot is a gap to fill and a crashed run is forty of them. */
const shut = async (p) => {
  try{
    if (await p.$('#overlay.show')) { await p.evaluate(()=>document.getElementById('overlay').click()); await p.waitForTimeout(700); }
  }catch{}
};
const closeModal = async (p) => {
  try{
    await p.keyboard.press('Escape'); await p.waitForTimeout(500);
    await p.evaluate(()=>{ document.querySelectorAll('.modal-wrap.show,[id$="ModalWrap"].show')
      .forEach(m=>m.classList.remove('show')); });
    await p.waitForTimeout(400);
  }catch{}
};
const tryClick = async (p, sel) => {
  try{ const el = await p.$(sel); if(!el) return false; await el.click({ timeout: 4000 }); return true; }
  catch{ return false; }
};
const tab = async (p, name) => { await shut(p); await p.click(`#mainTabs button[data-tab="${name}"]`); await p.waitForTimeout(2200); };
const project = async (p, name) => {
  await shut(p);
  const opts = await p.$$eval('#projectSelect option', o=>o.map(x=>({v:x.value,t:x.textContent.trim()})));
  const hit = opts.find(o=>o.t.includes(name));
  if (hit) { await p.selectOption('#projectSelect', hit.v); await p.waitForTimeout(2200); }
};
const openAsset = async (p, code) => {
  await shut(p);
  const ok = await p.evaluate((c)=>{
    const card=[...document.querySelectorAll('[data-id]')].find(el=>(el.textContent||'').includes(c));
    if(!card) return false; card.click(); return true; }, code);
  await p.waitForTimeout(1600);
  return ok;
};

/* The run has to be repeatable, because the manual is re-shot whenever a
   feature changes. Two bits of state survive a shoot and would break the next
   one: the artist has now seen the Quick Tour, and she has accepted the asset
   whose untouched Accept and Start button section 05 photographs. Both are put
   back before the browser opens. */
const reset = () => {
  const sql = [
    "UPDATE users SET tour_seen_at = NULL WHERE email = 'artist@zvky.test'",
    "DELETE ws FROM work_sessions ws JOIN assets a ON a.id = ws.asset_id WHERE a.code IN ('CHR-002','CHR-004')",
    "UPDATE assets SET status = 'assigned' WHERE code IN ('CHR-002','CHR-004')",
  ].join('; ');
  require('child_process').execFileSync('mysql', ['-u', 'root', 'zvky_ui', '-e', sql]);
  console.log('00 demo state reset\n');
};

(async () => {
  reset();
  const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const page = async () => { const p = await br.newPage({ viewport:{width:W,height:H} });
    p.on('pageerror', e=>console.log('   PAGE ERROR:', e.message)); return p; };

  // ---------- 01 Signing in ------------------------------------------------
  console.log('01 sign in');
  let p = await page();
  await p.goto('http://127.0.0.1:4415/');
  await p.waitForTimeout(1200);
  await shot(p, '01-login');
  await p.fill('#loginEmail','artist@zvky.test'); await p.fill('#loginPassword',PASS);
  await p.click('#loginBtn'); await p.waitForSelector('#mainTabs'); await p.waitForTimeout(3000);
  /* tour_seen_at was cleared for this account just above, so the tour launches
     itself the way a new joiner sees it. The header button is the fallback for
     a re-run where that reset did not take. */
  if (!(await p.$('.tour-pop'))) { await tryClick(p, '#tourBtn'); await p.waitForTimeout(1200); }
  if (await p.$('.tour-pop')) {
    await shot(p, '01-quicktour-autolaunch');
    await tryClick(p, '#tourNext'); await p.waitForTimeout(600);
    await tryClick(p, '#tourNext'); await p.waitForTimeout(600);
    await shot(p, '01-quicktour-step');
  } else console.log('  \u2717 MISSING quick tour \u2014 no .tour-pop and no #tourBtn');
  await p.keyboard.press('Escape'); await p.waitForTimeout(600);
  await shot(p, '01-header', 'header.top');
  await p.close();

  // ---------- 02 Dashboard (Super Admin, everything visible) ---------------
  console.log('02 dashboard');
  p = await page();
  await signIn(p, 'admin@zvky.test');
  await project(p, 'Nightgarden');
  await tab(p, 'board');
  await shot(p, '02-dashboard-full');
  await shot(p, '02-dashboard-stats', '.stats');
  await shot(p, '02-dashboard-board', '#boardView');

  // ---------- 03 Projects ---------------------------------------------------
  console.log('03 projects');
  await tab(p, 'projects');
  await shot(p, '03-projects-list');
  const addProject = await p.$('#newProjectBtn');
  if (addProject) { await addProject.click().catch(()=>{}); await p.waitForTimeout(1200); await shot(p, '03-project-new-form'); 
    await closeModal(p); }

  // ---------- 04 Assets List and its four sub-tabs -------------------------
  console.log('04 assets list');
  await tab(p, 'list');
  await shot(p, '04-assets-active');
  for (const sub of ['inactive','archived','history']) {
    const btn = await p.$(`.sub-tabs button[data-sub="${sub}"], .sub-tabs button:has-text("${sub}")`);
    if (btn) { await btn.click(); await p.waitForTimeout(1400); await shot(p, `04-assets-${sub}`); }
    else console.log('  ✗ no sub-tab', sub);
  }
  await p.close();

  // ---------- 05 The asset panel and the workflow, as the artist -----------
  console.log('05 asset panel (artist)');
  p = await page();
  await signIn(p, 'artist@zvky.test');
  await project(p, 'Nightgarden');
  await tab(p, 'list');
  if (await openAsset(p, D.assets.assigned.code)) {
    await shot(p, '05-asset-panel', '.drawer');
    await shot(p, '05-asset-panel-top', '.drawer');
  }
  await shut(p);
  if (await openAsset(p, D.assets.tlFeedback.code)) await shot(p, '05-asset-tl-feedback', '.drawer');
  await p.close();

  // ---------- 06 Review, as the Team Lead ----------------------------------
  console.log('06 review (team lead)');
  p = await page();
  await signIn(p, 'lead@zvky.test');
  await project(p, 'Nightgarden');
  await tab(p, 'list');
  if (await openAsset(p, D.assets.tlReview.code)) await shot(p, '06-tl-review-panel', '.drawer');
  await p.close();

  // ---------- 07 CD review --------------------------------------------------
  console.log('07 review (creative director)');
  p = await page();
  await signIn(p, 'cd@zvky.test');
  await project(p, 'Nightgarden');
  await tab(p, 'list');
  if (await openAsset(p, D.assets.cdReview.code)) await shot(p, '07-cd-review-panel', '.drawer');
  await tab(p, 'pending');
  await shot(p, '07-pending-actions-cd');
  await p.close();

  // ---------- 08 Pending Actions, as the submitter -------------------------
  console.log('08 pending actions (producer)');
  p = await page();
  await signIn(p, 'producer@zvky.test');
  await project(p, 'Nightgarden');
  await tab(p, 'pending');
  await shot(p, '08-pending-actions-submitter');
  await tab(p, 'projects');
  const sendBtn = await p.$('#sendProjectReviewBtn, button:has-text("Send Project to CD Review")');
  if (sendBtn) { await sendBtn.click(); await p.waitForTimeout(1400); await shot(p, '08-send-project-review');
    await closeModal(p); }
  else { await shot(p, '08-projects-producer'); console.log('  (send button not found on Projects)'); }
  await p.close();

  // ---------- 09 Time Sheet -------------------------------------------------
  console.log('09 time sheet');
  p = await page();
  await signIn(p, 'artist@zvky.test');
  await tab(p, 'timesheet');
  await shot(p, '09-timesheet-week');
  const add = await p.$('#timesheetView .ts-add');
  if (add) { await add.click(); await p.waitForTimeout(900); await shot(p, '09-timesheet-line-form', '#timesheetLineWrap .modal, #timesheetLineWrap');
    await tryClick(p, '#tl_cancel'); await closeModal(p); }
  await p.close();
  /* The approval queue is gone, so there is no queue to photograph. A lead's
     Time Sheet is now their team's week, read-only, which is what this shows. */
  p = await page();
  await signIn(p, 'lead@zvky.test');
  await tab(p, 'timesheet');
  await shot(p, '09-timesheet-team-view');
  await p.close();

  // ---------- 10 Reports ----------------------------------------------------
  console.log('10 reports');
  p = await page();
  await signIn(p, 'admin@zvky.test');
  await project(p, 'Nightgarden');
  await tab(p, 'reports');
  await shot(p, '10-reports-efficiency');
  const idle = await p.$('button:has-text("Idle")');
  if (idle) { await idle.click(); await p.waitForTimeout(2000); await shot(p, '10-reports-idle'); }

  // ---------- 11 Users ------------------------------------------------------
  console.log('11 users');
  await tab(p, 'users');
  await shot(p, '11-users-list');
  const newUser = await p.$('#newUserBtn, button:has-text("+ User"), button:has-text("Add User")');
  if (newUser) { await newUser.click(); await p.waitForTimeout(1300); await shot(p, '11-user-new-form');
    await closeModal(p); }

  // ---------- 12 Settings ---------------------------------------------------
  console.log('12 settings');
  await tab(p, 'settings');
  await p.waitForTimeout(2200);
  await shot(p, '12-settings-top');
  for (const [name, sel] of [['12-settings-working-hours','#scheduleSection'],
                             ['12-settings-branding','#brandingSection'],
                             ['12-settings-ip','#ipAllowlistSection'],
                             ['12-settings-permissions','#rolePermissionsSection'],
                             ['12-settings-activity','#activityLogSection']]) {
    await shot(p, name, sel);
  }
  // The permissions screen with a role chosen.
  const rp = await p.$('#rp_role');
  if (rp) {
    const opts = await p.$$eval('#rp_role option', o=>o.map(x=>({v:x.value,t:x.textContent})));
    const tl = opts.find(o=>/^Team Lead /.test(o.t));
    if (tl) { await p.selectOption('#rp_role', tl.v); await p.waitForTimeout(1800);
      await shot(p, '12-settings-permissions-role', '#rolePermissionsSection'); }
  }
  await p.close();

  // ---------- 13 One active task at a time ---------------------------------
  /* Meera holds two assets. She starts one; the other must refuse. Both halves
     are photographed, because the rule is only legible as a pair. */
  console.log('13 single active task');
  p = await page();
  await signIn(p, 'artist@zvky.test');
  await project(p, 'Nightgarden');
  await tab(p, 'list');
  if (await openAsset(p, D.assets.assigned.code)) {
    await shot(p, '13-accept-and-start', '.drawer');
    if (await tryClick(p, '.drawer button:has-text("Accept and Start")')) {
      await p.waitForTimeout(2200);
      await shot(p, '13-work-in-progress', '.drawer');
    } else console.log('  \u2717 could not click Accept and Start');
  }
  await shut(p);
  if (await openAsset(p, (D.assets.second || {}).code || 'CHR-004')) {
    await shot(p, '13-start-blocked', '.drawer');
  }
  await shut(p);
  await tab(p, 'board');
  await shot(p, '13-board-blocked', '#boardView');
  await p.close();

  // ---------- 14 Notifications and Profile ---------------------------------
  console.log('14 notifications and profile');
  p = await page();
  await signIn(p, 'artist@zvky.test');
  if (await tryClick(p, '#notifBell')) {
    await p.waitForTimeout(1200); await shot(p, '14-notifications');
  } else console.log('  \u2717 no notifications bell');
  await p.keyboard.press('Escape'); await p.waitForTimeout(400);
  if (await tryClick(p, '#profileBtn')) {
    await p.waitForTimeout(1400); await shot(p, '14-profile');
    await closeModal(p);
  } else console.log('  \u2717 no Profile button');
  await p.close();

  // ---------- 14b Chat -------------------------------------------------------
  console.log('14 chat');
  /* Two captures, from two accounts: the artist reads a one-to-one, and the
     lead — who holds Create Chat Group — opens a group's member list, which is
     the half an artist never sees. The conversations themselves are made by
     seed6.js so this only has to photograph them. */
  p = await page();
  await signIn(p, 'artist@zvky.test');
  if (await tryClick(p, '#chatBtn')) {
    await p.waitForTimeout(1200);
    // The one-to-one, not the group: the list is newest-first, so which one
    // is on top depends on who spoke last.
    const conv = await p.$('.chat-conv:not(:has(.chat-groupmark))');
    if (conv) { await conv.click(); await p.waitForTimeout(1600); await shot(p, '14-chat-thread'); }
    else console.log('  \u2717 no conversation to open');
  } else console.log('  \u2717 no chat button');
  await p.close();

  p = await page();
  await signIn(p, 'lead@zvky.test');
  if (await tryClick(p, '#chatBtn')) {
    await p.waitForTimeout(1200);
    const group = await p.$('.chat-conv:has(.chat-groupmark)');
    if (group) {
      await group.click();
      await p.waitForSelector('#chatManage', { timeout: 8000 }).catch(()=>{});
      if (await tryClick(p, '#chatManage')) { await p.waitForTimeout(1400); await shot(p, '14-chat-group'); }
    } else console.log('  \u2717 no group to open');
  }
  await p.close();

  // ---------- 15 My Team ----------------------------------------------------
  console.log('15 my team');
  p = await page();
  await signIn(p, 'lead@zvky.test');
  await project(p, 'Nightgarden');
  await tab(p, 'team');
  await shot(p, '15-my-team');
  await p.close();

  console.log(`\n${n} screenshots written to ${OUT}`);
  await br.close();
})().catch(e => { console.error('FAILED', e); process.exit(1); });
