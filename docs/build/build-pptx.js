/* The overview deck: roughly one slide per module, drawn from the same
   screenshots and the same generated permission tables as the manual.
   Dark throughout, because every screenshot in it is a dark interface -- on a
   white deck each one would sit in a glowing white surround. */
const fs = require('fs');
const path = require('path');
const pptxgen = require('pptxgenjs');
const bands = require('./bands');

const SHOTS = path.join(__dirname, '..', 'shots');
const BRAND = '7F1416';
const BRAND_LIT = 'B8323A';   // brand, lifted enough to read on near-black
const BG = '141110';
const BG_DEEP = '0B0908';
const CARD = '1E1A19';
const INK = 'F4F1F0';
const MUTED = 'A9A09E';

const pres = new pptxgen();
pres.layout = 'LAYOUT_WIDE';                 // 13.33 x 7.5
pres.author = 'ZVKY FORGE';
pres.title = 'ZVKY FORGE - Studio Pipeline Overview';

const W = 13.33, H = 7.5;
const img = (name) => {
  const b = fs.readFileSync(path.join(SHOTS, `${name}.png`));
  const d = b.subarray(16, 24);
  return { data: 'image/png;base64,' + b.toString('base64'), w: d.readUInt32BE(0), h: d.readUInt32BE(4) };
};
// A fresh shadow object every time: pptxgenjs converts these in place.
const shadow = () => ({ type: 'outer', blur: 14, offset: 4, angle: 90, color: '000000', opacity: 0.55 });

let n = 0;
const slide = (opts = {}) => {
  const s = pres.addSlide();
  s.background = { color: opts.deep ? BG_DEEP : BG };
  n += 1;
  if (!opts.bare) {
    s.addText(String(n), {
      x: W - 0.85, y: H - 0.55, w: 0.5, h: 0.3, isTextBox: true,
      align: 'right', fontSize: 10, color: MUTED, fontFace: 'Calibri', margin: 0,
    });
  }
  return s;
};

/* The motif: a brand square with the studio initial, then the module name.
   Repeated at the same place on every content slide. */
const mark = (s, module) => {
  s.addShape(pres.ShapeType.roundRect, {
    x: 0.62, y: 0.42, w: 0.36, h: 0.36, rectRadius: 0.08, fill: { color: BRAND },
  });
  s.addText('Z', {
    x: 0.62, y: 0.42, w: 0.36, h: 0.36, isTextBox: true, margin: 0,
    align: 'center', valign: 'middle', fontSize: 16, bold: true, color: 'FFFFFF', fontFace: 'Cambria',
  });
  s.addText(module.toUpperCase(), {
    x: 1.12, y: 0.42, w: 8, h: 0.36, isTextBox: true, margin: 0,
    valign: 'middle', fontSize: 11, bold: true, charSpacing: 2, color: MUTED, fontFace: 'Calibri',
  });
};

const title = (s, text, sub) => {
  s.addText(text, {
    x: 0.62, y: 0.95, w: 12.1, h: 0.75, isTextBox: true, margin: 0,
    fontSize: 34, bold: true, color: INK, fontFace: 'Cambria',
  });
  if (sub) {
    s.addText(sub, {
      x: 0.62, y: 1.7, w: 6.6, h: 0.5, isTextBox: true, margin: 0,
      fontSize: 14, color: MUTED, fontFace: 'Calibri',
    });
  }
};

const points = (s, items, opts = {}) => {
  s.addText(items.map((t, i) => ({
    text: t, options: { bullet: true, breakLine: i < items.length - 1 },
  })), {
    x: opts.x ?? 0.62, y: opts.y ?? 2.35, w: opts.w ?? 5.4, h: opts.h ?? 3.6, isTextBox: true,
    fontSize: opts.size ?? 14, color: INK, fontFace: 'Calibri', paraSpaceAfter: 10, lineSpacing: 20,
  });
};

const who = (s, text, opts = {}) => {
  const y = opts.y ?? 6.05;
  s.addShape(pres.ShapeType.roundRect, {
    x: 0.62, y, w: opts.w ?? 5.4, h: 0.85, rectRadius: 0.06,
    fill: { color: CARD }, line: { color: '2C2524', width: 1 },
  });
  s.addText([
    { text: 'WHO  ', options: { bold: true, color: BRAND_LIT, charSpacing: 2, fontSize: 10 } },
    { text, options: { color: INK, fontSize: 12 } },
  ], {
    x: 0.82, y, w: (opts.w ?? 5.4) - 0.4, h: 0.85, isTextBox: true, margin: 0,
    valign: 'middle', fontFace: 'Calibri',
  });
};

/* A screenshot on the right half. Wide captures fill the column; the narrow
   asset-panel captures are portrait and get centred in it instead. */
const picture = (s, name, caption) => {
  const p = img(name);
  const colX = 6.55, colW = 6.16, colY = 1.5, colH = 4.9;
  const ratio = p.w / p.h;
  let w = colW, h = colW / ratio;
  if (h > colH) { h = colH; w = colH * ratio; }
  const x = colX + (colW - w) / 2;
  const y = colY + (colH - h) / 2;
  s.addImage({ data: p.data, x, y, w, h, shadow: shadow() });
  if (caption) {
    s.addText(caption, {
      x: colX, y: y + h + 0.12, w: colW, h: 0.5, isTextBox: true, margin: 0,
      align: 'center', fontSize: 10, italic: true, color: MUTED, fontFace: 'Calibri',
    });
  }
};

// A module slide: mark, title, points, who, screenshot.
const module_ = ({ module, head, sub, items, whoText, shotName, caption, notes }) => {
  const s = slide();
  mark(s, module);
  title(s, head, sub);
  points(s, items, { y: sub ? 2.35 : 2.0, h: whoText ? 3.5 : 4.3 });
  if (whoText) who(s, whoText);
  if (shotName) picture(s, shotName, caption);
  if (notes) s.addNotes(notes);
  return s;
};

// ---------------------------------------------------------------- 1. Title
{
  const s = slide({ deep: true, bare: true });
  s.addShape(pres.ShapeType.roundRect, { x: 0.9, y: 2.35, w: 0.62, h: 0.62, rectRadius: 0.12, fill: { color: BRAND } });
  s.addText('Z', {
    x: 0.9, y: 2.35, w: 0.62, h: 0.62, isTextBox: true, margin: 0,
    align: 'center', valign: 'middle', fontSize: 30, bold: true, color: 'FFFFFF', fontFace: 'Cambria',
  });
  s.addText('ZVKY FORGE', {
    x: 1.75, y: 2.3, w: 9, h: 0.75, isTextBox: true, margin: 0, valign: 'middle',
    fontSize: 46, bold: true, charSpacing: 4, color: INK, fontFace: 'Cambria',
  });
  s.addText('art asset & animation pipeline', {
    x: 1.78, y: 2.95, w: 9, h: 0.4, isTextBox: true, margin: 0,
    fontSize: 14, color: MUTED, fontFace: 'Calibri',
  });
  s.addText('Studio Pipeline Overview', {
    x: 0.9, y: 3.95, w: 11, h: 0.6, isTextBox: true, margin: 0,
    fontSize: 28, color: BRAND_LIT, bold: true, fontFace: 'Cambria',
  });
  s.addText('One slide per module, with screenshots from the running application', {
    x: 0.9, y: 4.55, w: 11, h: 0.4, isTextBox: true, margin: 0,
    fontSize: 14, color: MUTED, fontFace: 'Calibri',
  });
  s.addText(`Internal induction deck  ·  built ${new Date().toISOString().slice(0, 10)}`, {
    x: 0.9, y: 6.3, w: 11, h: 0.35, isTextBox: true, margin: 0,
    fontSize: 11, color: MUTED, fontFace: 'Calibri',
  });
  s.addNotes('Companion to the full User Manual and Reference. This deck is the ten-minute version; '
    + 'the manual is the one to follow at a keyboard.');
}

// ---------------------------------------------------------------- 2. In numbers
{
  const s = slide();
  mark(s, 'The shape of it');
  title(s, 'One place where every piece of work lives');
  const stats = [
    ['10', 'stages from Not Assigned to Delivered'],
    ['60', 'designations, each with its own view'],
    ['58', 'permissions a Super Admin controls'],
    ['1', 'active task per person at a time'],
  ];
  stats.forEach(([big, small], i) => {
    const x = 0.62 + i * 3.12;
    s.addShape(pres.ShapeType.roundRect, {
      x, y: 2.35, w: 2.85, h: 2.35, rectRadius: 0.08,
      fill: { color: CARD }, line: { color: '2C2524', width: 1 },
    });
    s.addText(big, {
      x: x + 0.2, y: 2.6, w: 2.45, h: 0.95, isTextBox: true, margin: 0,
      fontSize: 54, bold: true, color: BRAND_LIT, fontFace: 'Cambria',
    });
    s.addText(small, {
      x: x + 0.22, y: 3.6, w: 2.45, h: 0.95, isTextBox: true, margin: 0,
      fontSize: 12, color: MUTED, fontFace: 'Calibri',
    });
  });
  s.addText('Every asset carries who did what and when. Nothing moves except through a recorded step, '
    + 'and every step is one somebody was allowed to take.', {
    x: 0.62, y: 5.25, w: 11.9, h: 1.0, isTextBox: true, margin: 0,
    fontSize: 16, color: INK, fontFace: 'Calibri',
  });
  s.addNotes('The four numbers are the whole design: a fixed pipeline, a role system fine enough to '
    + 'match a real studio, and one rule about focus.');
}

// ---------------------------------------------------------------- 3. Contents
{
  const s = slide();
  mark(s, 'Contents');
  title(s, 'What this deck covers');
  const items = [
    ['Signing in, the tour, the header', '4-5'],
    ['The Dashboard', '6'],
    ['Clients and projects', '7'],
    ['Assets, and bulk upload', '8-9'],
    ['The asset panel and preview images', '10-11'],
    ['The workflow, and one active task', '12-14'],
    ['The two review gates', '15-16'],
    ['Delivery and the client loop', '17'],
    ['Project reviews and Pending Actions', '18'],
    ['Time Sheet', '19'],
    ['Reports', '20'],
    ['People', '21'],
    ['Notifications and your profile', '22'],
    ['Settings and permissions', '23-25'],
    ['The Activity Log', '26'],
    ['Keeping the documentation current', '27'],
  ];
  items.forEach((row, i) => {
    const col = i < 8 ? 0 : 1;
    const y = 2.2 + (i % 8) * 0.55;
    const x = 0.62 + col * 6.2;
    s.addText(row[0], {
      x, y, w: 5.2, h: 0.45, isTextBox: true, margin: 0, valign: 'middle',
      fontSize: 14, color: INK, fontFace: 'Calibri',
    });
    s.addText(row[1], {
      x: x + 5.2, y, w: 0.7, h: 0.45, isTextBox: true, margin: 0, valign: 'middle', align: 'right',
      fontSize: 13, color: BRAND_LIT, bold: true, fontFace: 'Calibri',
    });
  });
}

// ---------------------------------------------------------------- 4-27
module_({
  module: 'Getting in',
  head: 'Signing in, and the tour that meets you',
  items: [
    'Sign in with the email the studio issued and your password.',
    'A guided Quick Tour opens by itself the first time. It walks only the tabs your designation actually gives you.',
    'The question-mark icon in the header reopens it whenever you want.',
    'Passwords need 10 characters, upper and lower case, a number and a symbol.',
  ],
  whoText: 'Everybody. The tour needs no permission and shows each person a different walk.',
  shotName: '01-quicktour-autolaunch',
  caption: 'The tour opening on a first sign-in. Seven steps for a Game Artist.',
  notes: 'Worth demonstrating live: sign in as an artist and as a producer and show the tour differing.',
});

module_({
  module: 'Getting around',
  head: 'The header decides what you are looking at',
  items: [
    'Client, then Project — everything below follows the pair you choose here.',
    'Your name and designation, so you always know which view you are in.',
    'The bell carries unread notifications; the question mark reopens the tour.',
    'The tab row is built from your permissions. Nobody sees a tab they cannot use.',
  ],
  whoText: 'Everybody, but no two designations see the same tab row.',
  shotName: '01-header',
  caption: 'The header, from the brand mark to Log out.',
});

module_({
  module: 'Dashboard',
  head: 'The board answers "where is this?"',
  items: [
    'One column per stage, one card per asset.',
    'The strip above counts every stage and the share of the project that is finished.',
    'A card shows the preview image, the code, the estimate, the name and who holds it.',
    'The counts are what YOU may see — an artist and a producer read different numbers off the same project.',
  ],
  whoText: 'Everybody. Reach comes from the designation, not from the screen.',
  shotName: '02-dashboard-full',
  caption: 'The Dashboard as a Super Admin sees it.',
});

module_({
  module: 'Clients and projects',
  head: 'Projects sit under clients',
  items: [
    'Create a project against a client, and name the team leads who run its first review gate.',
    'Add production coordinators if the studio uses them.',
    'Name up to two people to supervise it — the cap is enforced by the server, because five supervisors means none.',
    'A finished project is closed rather than deleted, so its assets and history stay readable.',
  ],
  whoText: 'Administration — 8 designations. Everyone else sees the clients they work under.',
  shotName: '03-project-new-form',
  caption: 'The new-project form.',
});

module_({
  module: 'Assets',
  head: 'One asset, or two hundred',
  items: [
    'New Asset takes a name and a scope of work; the code is generated (CHR-004).',
    'Bulk Upload Assets takes a spreadsheet of nine columns — press Sample format first.',
    'A bad row is reported with its row number and reason; the good rows still import.',
    'An unrecognised column heading is reported, never silently dropped.',
  ],
  whoText: 'Production planning — 23 designations. Deleting an asset is administration only.',
  shotName: '04-assets-active',
  caption: 'The Assets List, on its Active sub-tab.',
});

module_({
  module: 'Assets',
  head: 'Four sub-tabs, and an asset is in exactly one',
  items: [
    'Active — everything still moving.',
    'Inactive — work on hold.',
    'Archived — delivered, kept for the record.',
    'History — every stage change, who made it and when.',
    'Tick several rows to deliver them in one action; each is still recorded individually.',
  ],
  whoText: 'Everybody sees the list. Bulk delivery sits with the delivery band — 18 designations.',
  shotName: '04-assets-history',
  caption: 'The History sub-tab.',
});

module_({
  module: 'The asset panel',
  head: 'Everything about one asset, in one place',
  items: [
    'Opens from any card or any row.',
    'Preview image, code, name, stage, and Time Spent at the top.',
    'The brief, the estimate, the deadline, the category, the priority and the description.',
    'Tasks, notes, submissions and the asset’s own history further down.',
  ],
  whoText: 'Everybody who can see the asset. What you may change depends on your designation.',
  shotName: '05-asset-panel',
  caption: 'The asset panel.',
});

module_({
  module: 'Preview images',
  head: 'Upload a file, or paste a link',
  items: [
    'Upload a JPG or PNG of up to 5 MB, or paste an http/https image address.',
    'An asset holds one or the other, never both.',
    'A linked image stays current with its source — and falls back to the scope-of-work icon if the link dies, rather than showing a broken picture.',
    'Both setting and removing are recorded in the Activity Log, naming the person and the kind.',
  ],
  whoText: 'The assignee can always set their own asset’s preview. Anybody else needs Asset Edit.',
  shotName: '13-work-in-progress',
  caption: 'An asset with an uploaded preview, in progress.',
});

// The workflow gets a diagram rather than a screenshot.
{
  const s = slide();
  mark(s, 'The workflow');
  title(s, 'Ten stages, and no way round them');
  const stages = [
    ['Not Assigned', '6E6A69'], ['Assigned', '5B8DEF'], ['In Progress', 'C8922B'],
    ['TL Review', '7B9BD6'], ['TL Feedbacks', 'E8402C'], ['CD Review', '9B7EF0'],
    ['CD Feedbacks', 'E8402C'], ['Approved for Client', '3FA96B'], ['Awaiting Client', '2FA3B5'],
    ['Delivered', '54B84C'],
  ];
  stages.forEach(([label, colour], i) => {
    const col = i % 5, row = Math.floor(i / 5);
    const x = 0.62 + col * 2.48, y = 2.2 + row * 1.5;
    s.addShape(pres.ShapeType.roundRect, {
      x, y, w: 2.24, h: 1.15, rectRadius: 0.07,
      fill: { color: CARD }, line: { color: colour, width: 1.5 },
    });
    s.addShape(pres.ShapeType.ellipse, { x: x + 0.18, y: y + 0.22, w: 0.16, h: 0.16, fill: { color: colour } });
    s.addText(label, {
      x: x + 0.42, y: y + 0.12, w: 1.7, h: 0.55, isTextBox: true, margin: 0,
      fontSize: 12, bold: true, color: INK, fontFace: 'Calibri',
    });
    s.addText(String(i + 1), {
      x: x + 0.42, y: y + 0.68, w: 1.7, h: 0.3, isTextBox: true, margin: 0,
      fontSize: 10, color: MUTED, fontFace: 'Calibri',
    });
  });
  s.addText('Feedback at either gate sends the asset back a stage, not to the beginning. '
    + 'Stage colours are deliberately distinct from the brand colour, so a red card never reads as branding.', {
    x: 0.62, y: 5.5, w: 11.9, h: 0.8, isTextBox: true, margin: 0,
    fontSize: 14, color: MUTED, fontFace: 'Calibri',
  });
  s.addNotes('Fifteen moves connect these ten stages. The manual has the full table; this deck shows the shape.');
}

module_({
  module: 'Doing the work',
  head: 'Accept and Start, then Submit for Review',
  items: [
    'Accept and Start moves the asset to In Progress and stamps the time.',
    'Time Spent is the gap between that stamp and your submission, less any stretch put on hold.',
    'Submit for Review sends it to the first gate with the file or the link attached.',
    'You cannot submit work you never started, which is what makes Time Spent mean anything.',
  ],
  whoText: 'The person the asset is assigned to, and nobody else.',
  shotName: '13-accept-and-start',
  caption: 'Before accepting. Time Spent reads 0s.',
});

module_({
  module: 'Projects',
  head: 'What a project is, and how it is going',
  items: [
    'Category, Start Date and End Date describe the project. They are set on Add Project and are plain information \u2014 nothing warns or blocks when an end date passes.',
    '"+ Add Category" creates a category from inside the form and selects it straight away.',
    'Total Bid Hours adds up every asset\u2019s Man Hours \u2014 every asset, at every stage, including delivered ones.',
    'Spent Time adds up every round of every asset, held time excluded. The same figure the Efficiency report shows.',
    'Neither figure is stored. Both are counted from the assets each time the tab is drawn, so they are never out of date.',
  ],
  whoText: 'Anyone who can see clients sees the columns. Creating and editing projects is the existing project '
    + 'permission; managing the Project Categories list is its own Settings permission, separate from asset categories.',
  shotName: '03-projects-list',
  caption: 'The projects under a client.',
});

module_({
  module: 'Bulk assign',
  head: 'Hand out and schedule a batch in one action',
  items: [
    'Tick the assets on the Assets List \u2014 Inactive sub-tab \u2014 and press Assign & Schedule.',
    'One assignee, one Start Date, one End Date, applied to all of them. Each field is optional.',
    'Only work nobody has started. Anything already on somebody\u2019s desk is skipped and listed with the reason.',
    'Each asset gets its own Round, its own history line and its own notification, exactly as a single assignment does.',
    'The button says how many of your selection it will touch before you press it.',
  ],
  whoText: 'Super Admin alone out of the box. Granted in Settings to the coordinators who plan work \u2014 which '
    + 'opens the bulk panel without widening whose assets anybody may touch.',
  shotName: '04-assets-inactive',
  caption: 'The Assets List, where a batch is selected.',
});

module_({
  module: 'One at a time',
  head: 'One active task, enforced',
  items: [
    'While one of your assets is open, Accept and Start on every other one is disabled.',
    'The message names the asset that is holding you up.',
    'Submit the open one and every other unlocks immediately.',
    'Enforced on the server as well as the screen, so a second browser tab does not get round it.',
    'It restricts starting your own work and nothing else — reviewing, approving and time sheets are untouched.',
  ],
  whoText: 'Applies to everybody who accepts work. A lead with an asset under way still runs their queue.',
  shotName: '13-start-blocked',
  caption: 'A second asset, refused, naming the open one.',
});

module_({
  module: 'Hold',
  head: 'Put a task down without handing it in',
  items: [
    'Hold stops the count on a task and frees you to start another one.',
    'The held time is left out of that asset\u2019s Time Spent. Say why in a line, or leave it blank.',
    'It stays in its stage and carries an On hold badge, so a lead can see the work has stopped.',
    'Resume obeys the same one-task rule as starting, so holding is not a way around it.',
    'Time Spent now depends on people pressing the button, exactly as the Time Sheet does.',
  ],
  whoText: 'The person the task is assigned to, with Hold / Resume Own Task \u2014 on for every designation by '
    + 'default, and switchable off in Settings. Nobody can hold somebody else\u2019s task in this version.',
  shotName: '13-work-in-progress',
  caption: 'A task in progress, where the Hold button sits.',
});

module_({
  module: 'First review gate',
  head: 'The team lead sees it first',
  items: [
    'Approve to send it on to the Creative Director.',
    'Request changes to send it back as TL Feedbacks, with a note.',
    'A studio without a Creative Director gate can send straight to Approved for Client, if the reviewer holds that permission.',
    'Rework comes back through this same gate.',
  ],
  whoText: 'First review gate — 23 designations: leads, supervisors, production and creative direction.',
  shotName: '06-tl-review-panel',
  caption: 'An asset at TL Review.',
});

module_({
  module: 'Second review gate',
  head: 'The Creative Director, and the relay',
  items: [
    'Approve for client, or Submit Feedback — one action, not two competing decisions.',
    'Feedback goes to CD Feedbacks, which sits with the team lead first.',
    'The lead reads the notes, adds their own reading, and relays them to the artist.',
    'Until they do, the artist cannot start the rework — and the application says so plainly.',
  ],
  whoText: 'Creative direction — 9 designations: art direction and above.',
  shotName: '07-cd-review-panel',
  caption: 'An asset at CD Review.',
});

module_({
  module: 'Delivery',
  head: 'Two ways out of the studio',
  items: [
    'Deliver — handed over, and the asset is Delivered. One step.',
    'Send to client review — the asset waits at Awaiting Client Feedback.',
    'Client approved sends it to Delivered; client changes send it back to TL Feedbacks and round again.',
    'A studio uses whichever route matches how it works with that client.',
  ],
  whoText: 'Delivery — 18 designations. The whole client-feedback loop is Super Admin only until granted.',
  shotName: '02-dashboard-board',
  caption: 'The later columns on the board.',
});

module_({
  module: 'Project reviews',
  head: 'A project, not an asset',
  items: [
    'A producer sends a project to the Creative Director with a question.',
    'It lands in the reviewer’s Pending Actions, which carries a count and highlights while something waits.',
    'The reviewer answers with Submit Feedback; the submitter is notified at once.',
    'The submitter reads it and presses Acknowledge and Close.',
    'Your own submissions never appear in your queue to answer, only in your queue to read.',
  ],
  whoText: 'Creative Art Director and Super Admin. Sending, and seeing your own submissions, are Super Admin only until granted.',
  shotName: '07-pending-actions-cd',
  caption: 'Pending Actions, as the Creative Director.',
  notes: 'Flag this one in induction: the permissions here are narrow out of the box, and a studio must '
    + 'grant them before producers and directors can use the feature.',
});

module_({
  module: 'Time Sheet',
  head: 'A day at a time, in IST',
  items: [
    'A line is a number of HOURS against a project, an asset or non-project time. No start and end times.',
    'Pick an asset and the hours it recorded that day are offered — a suggestion in a field you can change.',
    'A day over 8 hours is flagged, not refused. A long day is real; a form that refuses one is not.',
    'Submission is daily, and nobody approves it. Submitting locks the day; its owner can reopen it.',
    'A lead reads their team\u2019s hours and nothing more — the approval queue is gone.',
  ],
  whoText: 'Everybody fills in their own. Reading a team\u2019s sits with leads and producers \u2014 18 designations. '
    + 'There is no Approve Timesheets permission any more.',
  shotName: '09-timesheet-week',
  caption: 'A week of Draft and Submitted days.',
});

module_({
  module: 'Reports',
  head: 'Estimate against actual, and time with nothing open',
  items: [
    'Efficiency compares each asset’s man hours against Time Spent, by user, asset, project or scope of work.',
    'It says how many assets had time held back, and Idle counts that same held time as idle — the two reports are meant to disagree there.',
    'Idle is working time during which somebody had nothing started.',
    'Idle counts against the configured working hours, so evenings and lunch are not counted as idle.',
    'Idle Now answers the immediate question: who has nothing open right now.',
    'Every report exports to Excel and PDF, named after the view you were looking at.',
  ],
  whoText: 'Studio leadership — 7 designations, plus anyone given View Reports. Team Lead is a common addition.',
  shotName: '10-reports-idle',
  caption: 'The Idle report.',
});

module_({
  module: 'People',
  head: 'The staff list, and your own team',
  items: [
    'Add a person with their name, sign-in email, designation, reporting line and project.',
    'What a designation can do comes from the tier behind it — pick the closest match.',
    'Bulk import takes name, email and role as required columns.',
    'My Team shows the people who report to you, what they are carrying and how far along it is.',
  ],
  whoText: 'Administration — 8 designations. My Team is open to anyone who supervises people — 14.',
  shotName: '15-my-team',
  caption: 'My Team, as a Team Lead.',
});

module_({
  module: 'You',
  head: 'Notifications, your photo, your password',
  items: [
    'The bell carries unread notifications: work assigned to you, reviews coming back, feedback landing, time sheets waiting.',
    'Profile holds your photo, which then appears everywhere you are represented.',
    'Profile also holds your password.',
    'Changing your password signs out every other session — deliberately, since a password is changed because it may be known.',
  ],
  whoText: 'Everybody, for themselves.',
  shotName: '14-profile',
  caption: 'The Profile panel.',
});

module_({
  module: 'Settings',
  head: 'Not one screen, but the ones you hold',
  items: [
    'Working hours — the standard day the Idle report measures against.',
    'Branding — the studio name and the colour used across the application.',
    'Five value lists: Scope of Work, Priorities, Asset Categories, Project Categories and Roles.',
    'Renaming a value is safe; a value in use cannot be deleted, only deactivated.',
    'A person given one Settings permission gets this page with exactly that one section on it.',
  ],
  whoText: 'Studio leadership — 7 designations, one permission per section.',
  shotName: '12-settings-working-hours',
  caption: 'The working-hours control.',
});

// The permission bands get a grid of their own.
{
  const s = slide();
  mark(s, 'Permissions');
  title(s, 'Twelve access bands, not sixty role lists',
    `${bands.groups.reduce((a, g) => a + g.permissions.length, 0)} permissions across ${bands.roles.length} designations, `
    + 'in only twelve distinct groups of holders.');
  const list = Object.values(bands.band);
  list.forEach((b, i) => {
    const col = i % 3, row = Math.floor(i / 3);
    const x = 0.62 + col * 4.06, y = 2.5 + row * 1.0;
    s.addShape(pres.ShapeType.roundRect, {
      x, y, w: 3.82, h: 0.85, rectRadius: 0.06,
      fill: { color: CARD }, line: { color: '2C2524', width: 1 },
    });
    s.addText(b.label, {
      x: x + 0.18, y: y + 0.06, w: 2.8, h: 0.42, isTextBox: true, margin: 0, valign: 'top',
      fontSize: 12, bold: true, color: INK, fontFace: 'Calibri',
    });
    s.addText(`${b.permissions.length} permission${b.permissions.length === 1 ? '' : 's'}`, {
      x: x + 0.18, y: y + 0.45, w: 3.0, h: 0.32, isTextBox: true, margin: 0,
      fontSize: 11, color: MUTED, fontFace: 'Calibri',
    });
    s.addText(String(b.roles.length), {
      x: x + 3.02, y: y + 0.1, w: 0.62, h: 0.65, isTextBox: true, margin: 0,
      align: 'right', valign: 'middle', fontSize: 20, bold: true, color: BRAND_LIT, fontFace: 'Cambria',
    });
  });
  s.addText('The large number on each card is how many designations hold that band. '
    + 'Super Admin holds everything, including any permission added in future, without anybody switching it on.', {
    x: 0.62, y: 6.55, w: 11.9, h: 0.6, isTextBox: true, margin: 0,
    fontSize: 13, color: MUTED, fontFace: 'Calibri',
  });
  s.addNotes('These twelve bands are generated from the permission table, not written by hand. '
    + 'Appendix A of the manual lists every designation in each.');
}

module_({
  module: 'Permissions',
  head: 'One screen decides what everybody else may do',
  items: [
    'Choose a designation, tick the actions it should hold, save.',
    'The change applies to everybody holding that designation, on their next request.',
    'Super Admin holds every permission and cannot be edited down.',
    'Every change is written to the Activity Log — the designation, the permission and the direction.',
  ],
  whoText: 'Super Admin, and nobody else.',
  shotName: '12-settings-permissions-role',
  caption: 'The permission grid for one designation (first screenful).',
});

module_({
  module: 'Activity Log',
  head: 'One record that crosses every module',
  items: [
    'Every action anybody takes, newest first, with the person’s name and designation.',
    'Filter by person, module, action or date; search the text.',
    'Where a change has a before and an after, the entry shows both.',
    'Nothing here can be edited or removed, from this screen or any other.',
    'The asset history, the review trail and the time-sheet log all still exist — this is the view that crosses them.',
  ],
  whoText: 'Studio leadership — 7 designations. Readable, filterable, exportable, editable by nobody.',
  shotName: '12-settings-activity',
  caption: 'The Activity Log (first screenful).',
});

// ---------------------------------------------------------------- close
{
  const s = slide({ deep: true });
  mark(s, 'Keeping it current');
  title(s, 'The documentation is built, not written');
  const cards = [
    ['Screenshots', 'Captured by a script that signs in as each demo designation and drives the real buttons. A rebuild cannot leave last month’s picture behind.'],
    ['Permission tables', 'Read out of a pristine deployment, so they say what the software ships with rather than what somebody remembers.'],
    ['Access bands', 'Derived from those tables. A new permission appears in the manual on the next build with nobody editing it.'],
  ];
  cards.forEach(([head, text], i) => {
    const x = 0.62 + i * 4.06;
    s.addShape(pres.ShapeType.roundRect, {
      x, y: 2.2, w: 3.82, h: 2.35, rectRadius: 0.08,
      fill: { color: CARD }, line: { color: '2C2524', width: 1 },
    });
    s.addText(head, {
      x: x + 0.25, y: 2.4, w: 3.3, h: 0.4, isTextBox: true, margin: 0,
      fontSize: 15, bold: true, color: BRAND_LIT, fontFace: 'Cambria',
    });
    s.addText(text, {
      x: x + 0.25, y: 2.85, w: 3.35, h: 1.55, isTextBox: true, margin: 0, valign: 'top',
      fontSize: 12, color: INK, fontFace: 'Calibri', lineSpacing: 17,
    });
  });
  s.addText('What a new feature needs', {
    x: 0.62, y: 4.85, w: 11.9, h: 0.4, isTextBox: true, margin: 0,
    fontSize: 17, bold: true, color: INK, fontFace: 'Cambria',
  });
  points(s, [
    'A section in the right chapter of the manual, written as steps somebody can follow.',
    'A screenshot, added to the capture script so it is re-taken on every build.',
    'A role note naming the access band — which the permission tables already know about.',
    'A slide here, if it is something a new joiner needs to know exists.',
  ], { y: 5.25, w: 11.9, h: 1.6, size: 13 });
  s.addNotes('The standing rule: every feature prompt from here on should say what the documentation needs added.');
}

const out = path.join(__dirname, '..', 'ZVKY-FORGE-Overview.pptx');
fs.mkdirSync(path.dirname(out), { recursive: true });
pres.writeFile({ fileName: out }).then(() => console.log('wrote', out, `${n} slides`));
