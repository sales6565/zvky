/* The manual, as content rather than as formatting.
 *
 * Every screenshot named here is a file in ../shots, taken from a running
 * instance by shoot.js. Every role note names an access band from bands.js,
 * which is generated from a pristine deployment's permission table — so the
 * two things most likely to go stale, the pictures and the permissions, are
 * both generated rather than typed.
 */
const { band } = require('./bands');

const h1 = (text) => ({ t: 'h1', text });
const h2 = (text) => ({ t: 'h2', text });
const h3 = (text) => ({ t: 'h3', text });
const p = (text) => ({ t: 'p', text });
const lead = (text) => ({ t: 'lead', text });
const steps = (items) => ({ t: 'steps', items });
const bullets = (items) => ({ t: 'bullets', items });
const shot = (file, caption) => ({ t: 'shot', file, caption });
const table = (head, rows, widths) => ({ t: 'table', head, rows, widths });
const note = (title, text) => ({ t: 'note', title, text });
const roles = (text, bandKeys) => ({ t: 'roles', text, bands: (bandKeys || []).map((k) => band[k]) });
const pagebreak = () => ({ t: 'pagebreak' });

const STATES = [
  ['Not Assigned', 'The asset exists and nobody is holding it.', 'Whoever creates it, or a bulk upload with the Assignee Email column left blank.'],
  ['Assigned', 'It is on somebody’s desk, not yet accepted.', 'Anyone who may assign work.'],
  ['In Progress', 'The assignee has pressed Accept and Start. The clock for Time Spent runs from here.', 'The assignee, and nobody else.'],
  ['TL Review', 'Submitted, waiting on the first review gate.', 'The assignee, on Submit for Review.'],
  ['TL Feedbacks', 'The team lead asked for changes. Back with the assignee.', 'The reviewer at the first gate.'],
  ['CD Review', 'Past the first gate, waiting on the Creative Director.', 'The reviewer at the first gate, on approval.'],
  ['CD Feedbacks', 'The Creative Director asked for changes. Sits with the team lead until relayed.', 'The Creative Director.'],
  ['Approved for Client', 'Cleared internally. Ready to leave the studio.', 'The Creative Director, or a lead who may skip the second gate.'],
  ['Awaiting Client Feedback', 'It has gone to the client and the studio is waiting.', 'Whoever holds Send to Client Review.'],
  ['Delivered', 'Finished and handed over.', 'Whoever holds Deliver, or the client approving.'],
];

const TRANSITIONS = [
  ['Assign', 'Not Assigned', 'Assigned', 'Asset Assign'],
  ['Accept and Start', 'Assigned', 'In Progress', 'The assignee'],
  ['Submit for Review', 'Not Assigned / In Progress / TL Feedbacks', 'TL Review', 'The assignee'],
  ['Submit for Review (after CD notes)', 'CD Feedbacks', 'CD Review or TL Review', 'The assignee'],
  ['Approve', 'TL Review', 'CD Review', 'TL Review'],
  ['Request changes', 'TL Review', 'TL Feedbacks', 'TL Review'],
  ['Send straight to client', 'TL Review', 'Approved for Client', 'TL Send to Client'],
  ['Approve for client', 'CD Review', 'Approved for Client', 'CD Review'],
  ['Request changes', 'CD Review', 'CD Feedbacks', 'CD Review'],
  ['Relay the notes', 'CD Feedbacks', 'CD Feedbacks (now with the assignee)', 'TL Review'],
  ['Send to client review', 'Approved for Client', 'Awaiting Client Feedback', 'Send to Client Review'],
  ['Client approved', 'Awaiting Client Feedback', 'Delivered', 'Record Client Approval'],
  ['Client asked for changes', 'Awaiting Client Feedback', 'TL Feedbacks', 'Record Client Changes'],
  ['Deliver', 'Approved for Client', 'Delivered', 'Deliver'],
  ['Reassign', 'Any stage before delivery', 'Assigned', 'Asset Assign'],
];

module.exports = [
  // ============================================================ 1
  h1('1. About this manual'),
  lead('ZVKY FORGE is the studio’s art asset and animation pipeline. Every piece of work in the studio '
    + 'lives in it as an asset, moves through a fixed set of review gates, and carries with it who did what and when.'),
  p('This manual is a training and reference document for people inside the studio. It walks through every screen '
    + 'in the order somebody meets them, with a picture of each one taken from a running instance, and says at the '
    + 'end of each section who can do what.'),

  h2('1.1 How to read it'),
  p('Each chapter covers one module. Inside a chapter you will find numbered steps you can follow at your own screen, '
    + 'a screenshot of what you should be seeing, and a shaded box headed WHO CAN DO THIS listing the designations '
    + 'that hold the actions in that chapter.'),
  p('If a button described here is missing from your screen, that is the permission system working, not a fault. '
    + 'The application shows a person only the actions their designation holds. Chapter 13.6 and Appendix B explain '
    + 'how a Super Admin changes that.'),

  h2('1.2 Roles, permissions and access bands'),
  p('The studio ships with 60 designations and 58 permissions. Rather than repeat eight or twenty designations on '
    + 'every page, this manual names the twelve groups of designations that the permissions actually fall into, '
    + 'and calls them access bands. Appendix A lists every band and its members; Appendix B lists every permission '
    + 'and the band that holds it.'),
  p('Two rules hold throughout. A permission says what somebody may do, never how much of the studio they may do it '
    + 'to — that reach comes from the designation itself. And Super Admin holds everything, including any permission '
    + 'added in future, without anybody switching it on.'),

  h2('1.3 About the screenshots'),
  p('Every screenshot in this manual was taken from a live instance with a demo studio loaded: two clients '
    + '(Aurora Games and Lumen Interactive), three projects, thirteen assets spread across every stage of the '
    + 'workflow, and seven people holding different designations. Nothing is a mock-up or a placeholder.'),
  table(
    ['The person in the screenshots', 'Their designation', 'What they are used to show'],
    [
      ['Priya Nair', 'Super Admin', 'Settings, Users, Reports — everything'],
      ['Rahul Menon', 'Team Lead', 'The first review gate, My Team'],
      ['Ananya Rao', 'Creative Art Director', 'The second review gate, the project review queue'],
      ['Vikram Shah', 'Producer', 'Sending a project to review, delivery'],
      ['Meera Iyer', 'Game Artist', 'An artist’s own work: accepting, submitting, time sheets'],
      ['Arjun Das', 'Game Artist', 'A second artist, so handovers have somewhere to go'],
      ['Kavya Reddy', 'Game Animator', 'Animation work alongside art'],
    ],
    [2600, 2400, 4360]
  ),

  pagebreak(),
  // ============================================================ 2
  h1('2. Signing in and finding your way'),

  h2('2.1 Sign in'),
  steps([
    'Open the studio address in a browser. Chrome, Edge, Firefox and Safari are all fine; there is nothing to install.',
    'Type the email address the studio issued you and your password.',
    'Press Sign in.',
  ]),
  shot('01-login', 'The sign-in screen.'),
  p('Passwords must be at least 10 characters and contain an uppercase letter, a lowercase letter, a number and a '
    + 'symbol. The form checks each rule as you type when you change your password, so you can see which one you '
    + 'have not met yet.'),
  note('If you cannot get in',
    'The studio may restrict sign-in to office IP addresses. If you are working from elsewhere and the page refuses '
    + 'you before it even asks for a password, ask a Super Admin to add your address in Settings (chapter 13.5).'),

  h2('2.2 The Quick Tour'),
  p('The first time you sign in, a short guided tour opens by itself. It is not a generic tour: it walks only the '
    + 'tabs your designation actually gives you, so an artist sees four steps where a Super Admin sees twelve.'),
  shot('01-quicktour-autolaunch', 'The Quick Tour, opening by itself on a first sign-in. The counter reads 1 of 7 for a Game Artist.'),
  steps([
    'Read the step, then press Next to move on, or Skip to leave the tour.',
    'Each step highlights the part of the screen it is describing.',
    'When you reach the end the tour closes and does not open again by itself.',
  ]),
  shot('01-quicktour-step', 'A later step. Each one points at a real tab or control.'),
  p('You can reopen the tour at any time from the question-mark icon in the header, next to your name. Everybody has '
    + 'this — it needs no permission.'),

  h2('2.3 The header'),
  shot('01-header', 'The header, from left: the studio brand, the client and project pickers, your name and designation, the notification bell, the Quick Tour icon, Profile and Log out.'),
  bullets([
    'Client and Project/Game — everything below the header is filtered to the project chosen here. Change the project and the whole page follows.',
    'Your name and designation — what the studio has you down as. If it is wrong, that is a Users change (chapter 11).',
    'The bell — notifications, with a count of the unread ones (chapter 12.1).',
    'The question mark — reopens the Quick Tour.',
    'Profile — your photo and your password (chapter 12.2).',
  ]),

  h2('2.4 The tabs'),
  p('The row of tabs under the statistics strip is built from your permissions. Nobody sees a tab they cannot use.'),
  table(
    ['Tab', 'What it holds', 'Who sees it'],
    [
      ['Dashboard', 'The board: every asset in the project, in columns by stage.', 'Everyone'],
      ['Pending Actions', 'Project reviews waiting on you.', 'View Pending Actions'],
      ['Projects', 'The projects under the chosen client, and the form to add one.', 'Anyone who may see or add projects'],
      ['Assets List', 'The same assets as a table, with Active, Inactive, Archived and History.', 'Everyone'],
      ['My Team', 'The people who report to you, and their load.', 'View Team'],
      ['Time Sheet', 'Your week, and your team’s if you approve them.', 'Everyone'],
      ['Reports', 'Efficiency and Idle.', 'View Reports'],
      ['Users', 'The staff list.', 'User View'],
      ['Settings', 'Everything configurable, and the Activity Log.', 'Any one Settings permission'],
    ],
    [1800, 5000, 2560]
  ),

  pagebreak(),
  // ============================================================ 3
  h1('3. The Dashboard'),
  lead('The Dashboard is the board: every asset in the chosen project, in a column for the stage it is at. It is the '
    + 'first thing everybody sees and the fastest way to answer "where is this?".'),

  h2('3.1 The statistics strip'),
  shot('02-dashboard-stats', 'The strip above the tabs: a count for every stage, and the percentage of the project that is finished.'),
  p('The strip counts only what you are allowed to see. An artist looking at the same project as a producer will see '
    + 'smaller numbers, because the artist is counting their own work and the producer is counting the project.'),

  h2('3.2 The board'),
  shot('02-dashboard-board', 'The board. Each column is a stage; each card is an asset.'),
  steps([
    'Choose a client, then a project, in the header.',
    'Scroll the board sideways to reach the later stages.',
    'Click any card to open the asset panel (chapter 6).',
  ]),
  shot('02-dashboard-full', 'The whole Dashboard as a Super Admin sees it, with every column and both upload buttons.'),

  h2('3.3 What is on a card'),
  bullets([
    'The preview image, if one has been set (chapter 6.2). Without one, the card shows the scope-of-work icon.',
    'The asset code and the estimate in hours — CHR-002 / 24h.',
    'The asset name.',
    'The scope of work, the task count, and the initials of whoever holds it.',
    'A coloured corner flag for priority.',
  ]),
  note('Colour',
    'Stage colours are deliberately distinct from the studio brand colour, so a red card never reads as branding '
    + 'and branding never reads as an alert.'),
  roles('Everybody can see the Dashboard. What appears on it depends on the designation: an artist sees their own '
    + 'work, a lead their team’s, and leadership the whole studio.', ['everyone']),

  pagebreak(),
  // ============================================================ 4
  h1('4. Clients and projects'),

  h2('4.1 The Projects tab'),
  shot('03-projects-list', 'The projects under the chosen client.'),
  p('Clients sit above projects. Choosing a client in the header narrows the project picker to that client’s work.'),

  h2('4.2 Creating a project'),
  steps([
    'Press + Project, at the right of the tab row.',
    'Give the project a name and pick the client it belongs to.',
    'Name the team leads who will run its first review gate.',
    'Name the production coordinators, if the studio uses them.',
    'Add up to two people to the supervision list — the ones accountable for the project overall.',
    'Save.',
  ]),
  shot('03-project-new-form', 'The new-project form.'),
  note('Two supervisors, and no more',
    'The supervision list is capped at two people, and the cap is enforced by the server, not only by the form. '
    + 'This is deliberate: a list of five supervisors means nobody is supervising.'),

  h2('4.3 Closing a project'),
  p('A finished project is closed rather than deleted, so its assets, time sheets and history stay readable. '
    + 'A closed project accepts no new assets and no changes to the ones it holds.'),

  h2('4.4 Archiving, and deleting for good'),
  p('There are two levels, and the application steers you to the first. Archiving hides a client or a project from '
    + 'every dashboard and keeps everything under it — assets, submissions, review history, time sheets — ready to '
    + 'be restored. Permanent deletion is offered only where it costs nothing: something holding nothing.'),
  h3('Archiving'),
  steps([
    'Projects tab, then click the client.',
    'Archive client for the whole client, or Archive on a project\u2019s row for one project.',
    'A project with undelivered assets asks you to confirm, and says how many.',
    'Restore brings either one back exactly as it was.',
  ]),
  h3('Deleting permanently'),
  p('The Delete permanently button appears only once two things are true: the client or project is already '
    + 'archived, and it holds nothing. A client with any project, or a project with any asset, cannot be deleted '
    + 'at all — the button is not shown, because it is not something that could be allowed.'),
  steps([
    'Move or delete whatever it holds, until it holds nothing.',
    'Archive it.',
    'For a client: go back to the client list and tick Show archived \u2014 archived clients are not listed by default. The tick box says how many are hidden.',
    'Open it and press Delete permanently. This one cannot be undone.',
  ]),
  note('Where the delete option seems to have gone',
    'Archiving a client takes it out of the default list, and the Delete permanently button only exists once it is '
    + 'archived \u2014 so both can appear to vanish at the same moment. Tick Show archived and it is there. The '
    + 'built-in Unassigned client can never be deleted; it is where projects go before they have a client.'),
  roles('Adding, editing, closing and deleting projects and clients sits with the administration band. Everyone can '
    + 'see the clients they work under. One extra rule on projects: unless your designation sees the whole studio, '
    + 'you can only delete projects you created.', ['administration', 'everyone']),

  pagebreak(),
  // ============================================================ 5
  h1('5. Assets'),

  h2('5.1 Creating one asset'),
  steps([
    'On the Dashboard, press + New Asset.',
    'Give it a name.',
    'Choose the scope of work — Character, Prop, Environment, FX, Animation, Background, or whatever the studio has added. This decides the code prefix, so a character becomes CHR-004.',
    'Optionally set a category, a priority, an estimate in man hours, a deadline and a description.',
    'Optionally choose an assignee. Leave it blank and the asset starts in Not Assigned.',
    'Save. The code is generated for you.',
  ]),

  h2('5.2 Bulk upload'),
  p('For a batch, use Bulk Upload Assets. Press Sample format first to download a spreadsheet with the right columns '
    + 'and a filled-in example row.'),
  table(
    ['Column', 'Required', 'What it does'],
    [
      ['No.', 'no', 'Your own row number. Not stored.'],
      ['Asset Name', 'YES', 'The name.'],
      ['Category', 'no', 'A new value here is added to the Settings list rather than rejected.'],
      ['Scope of Work', 'YES', 'Character, Prop, Environment, FX, Animation, Background, or a new one.'],
      ['Man Hours', 'no', 'The estimate. A positive number.'],
      ['Assignee Email', 'no', 'A match assigns the asset immediately; a blank leaves it Not Assigned.'],
      ['Deadline', 'no', 'DD-MM-YYYY. YYYY-MM-DD is accepted too.'],
      ['Project Link', 'no', 'The brief or reference. Shown as Requirement / Reference Link.'],
      ['Lead/Supervisor Notes', 'no', 'Visible only to designations holding Lead / Supervisor Notes.'],
    ],
    [2800, 1200, 5360]
  ),
  note('A bad row does not lose the good ones',
    'The upload reports every row it could not accept, with the row number and the reason, and imports the rest. '
    + 'An unrecognised column heading is reported rather than silently ignored, so a mis-saved file cannot quietly '
    + 'drop a column of deadlines.'),

  h2('5.3 The Assets List'),
  p('The same assets as a table, which is easier than the board when there are many. It has four sub-tabs, and an '
    + 'asset appears in exactly one of them.'),
  shot('04-assets-active', 'Active: everything still moving through the pipeline.'),
  shot('04-assets-inactive', 'Inactive: assets on hold.'),
  shot('04-assets-archived', 'Archived: delivered work, kept for the record.'),
  shot('04-assets-history', 'History: every stage change, who made it and when.'),

  h2('5.4 Delivering several at once'),
  steps([
    'On the Assets List, tick the assets you want to deliver.',
    'Press the bulk deliver action.',
    'Confirm.',
  ]),
  p('Every asset in the batch is recorded individually in its own history, and the batch itself is recorded too, so '
    + 'a bulk delivery is as auditable as fifteen single ones.'),
  roles('Creating assets and bulk upload sit with production planning. Editing and assigning are open to everyone '
    + 'who works on assets, within the reach their designation gives them. Deleting an asset is administration only. '
    + 'Delivery sits with the delivery band.',
    ['planners', 'asset_workers', 'delivery', 'administration']),

  pagebreak(),
  // ============================================================ 6
  h1('6. The asset panel'),
  lead('Clicking any card or any row opens the asset panel from the right. Everything about one asset is here.'),

  h2('6.1 What is in it'),
  shot('05-asset-panel', 'The asset panel. The preview image is at the top, then the code, the name, the stage, Time Spent, and the fields.'),
  bullets([
    'Preview image, and the controls to change it.',
    'Code, name and scope of work.',
    'Status — the stage the asset is at.',
    'Time Spent — the gap between Accept and Start and Submit for Review, and the button for whichever of those is next.',
    'Requirement / Reference Link — the brief. Not the finished work.',
    'Man Hours, Deadline, Category, Priority, Description.',
    'Tasks — the checklist, and the count the card shows.',
    'Notes, submissions and history, further down.',
  ]),

  h2('6.2 The preview image'),
  p('An asset can carry a preview image, shown both on its card and at the top of this panel. There are two ways to '
    + 'set one, and an asset holds one or the other, never both.'),
  h3('Uploading a file'),
  steps([
    'Open the asset panel.',
    'Press Upload an image, or Replace with a file if one is already set.',
    'Choose a JPG or PNG of up to 5 MB.',
  ]),
  h3('Pasting a link'),
  steps([
    'Press Paste a link.',
    'Put the image address into the box — it must start with http:// or https://.',
    'Press Use this.',
  ]),
  p('A linked image is fetched by the browser each time, so it stays current if the source changes, and disappears '
    + 'if the source is taken down. When a link stops loading, the card and the panel fall back to the scope-of-work '
    + 'icon rather than showing a broken picture. An uploaded file has no such dependency.'),
  p('Press Remove to clear either kind. Both setting and removing a preview are recorded in the Activity Log, naming '
    + 'the person and saying which kind it was.'),
  roles('The person an asset is assigned to can always change its preview image, even if their designation does not '
    + 'otherwise let them edit assets. Anyone else needs Asset Edit.', ['asset_workers']),

  h2('6.3 Tasks and notes'),
  p('Tasks are a checklist on the asset — the 0/3 on the card. Notes are a running conversation, kept with the asset '
    + 'rather than in anybody’s inbox.'),

  h2('6.4 History'),
  p('Every stage change the asset has been through, with who made it, when, and what they wrote. This is the asset’s '
    + 'own record and is separate from the studio-wide Activity Log in chapter 13.7.'),

  pagebreak(),
  // ============================================================ 7
  h1('7. The workflow, stage by stage'),
  lead('Ten stages, and a fixed set of moves between them. Nothing moves an asset except one of these moves, and '
    + 'every one of them is recorded.'),

  h2('7.1 The ten stages'),
  table(['Stage', 'What it means', 'Who puts it here'], STATES, [2400, 4560, 2400]),

  h2('7.2 Every move'),
  table(['Action', 'From', 'To', 'Permission'], TRANSITIONS, [2400, 3000, 2600, 1360]),

  pagebreak(),
  h2('7.3 Accepting work'),
  steps([
    'Open the asset assigned to you.',
    'Read the brief in Requirement / Reference Link.',
    'Press Accept and Start.',
  ]),
  shot('13-accept-and-start', 'An asset assigned to you, before you accept it. Time Spent reads 0s and has not begun.'),
  p('The asset moves to In Progress and the clock starts. Time Spent is not a timer you can pause — it is the gap '
    + 'between this moment and the moment you submit.'),
  shot('13-work-in-progress', 'The same asset once started. The panel now shows when you started, and Time Spent is running.'),

  h2('7.4 One active task at a time'),
  p('You may hold one piece of work open at a time. While an asset of yours is open, Accept and Start on every other '
    + 'asset assigned to you is disabled, and the panel says which asset is holding you up.'),
  shot('13-start-blocked', 'A second asset, refused. The button is greyed and the message names CHR-002 (Lantern Keeper) as the open one.'),
  shot('13-board-blocked', 'The same rule seen on the board.'),
  bullets([
    'Submit your open asset for review and every other one unlocks immediately.',
    'The rule is enforced by the server as well as the screen, so it holds in a second browser tab too.',
    'It applies only to starting your own work. Reviewing, approving, relaying feedback, filling in a time sheet and everything else are untouched — a lead with their own asset under way still runs their queue.',
    'Rework after TL or CD feedback counts as open work, because it is started with the same button.',
  ]),

  h2('7.5 Submitting for review'),
  steps([
    'With the asset In Progress, scroll to Submissions in the panel.',
    'Attach the file, or paste the link to it.',
    'Press Submit for Review.',
  ]),
  p('The asset moves to TL Review, Time Spent is fixed at the gap between your two stamps, and the reviewer is '
    + 'notified. You cannot submit work you never started — the two stamps are what make Time Spent mean anything.'),

  h2('7.6 The first review gate'),
  shot('06-tl-review-panel', 'An asset at TL Review, seen by the team lead.'),
  steps([
    'Open the asset from your queue.',
    'Look at what was submitted.',
    'Approve to send it on to the Creative Director, or Request changes with a note saying what needs doing.',
  ]),
  p('A studio that does not use a Creative Director gate can send work straight from here to Approved for Client, '
    + 'if the reviewer holds TL Send to Client.'),

  h2('7.7 TL Feedbacks'),
  shot('05-asset-tl-feedback', 'An asset returned with the lead’s notes, seen by the artist who holds it.'),
  p('The asset comes back to you with the note attached. Press Accept and Start again to reopen it — which counts '
    + 'as your one active task — and Submit for Review when the changes are done. It goes back to the same gate.'),

  h2('7.8 The Creative Director gate'),
  shot('07-cd-review-panel', 'An asset at CD Review.'),
  p('The Creative Director either approves it for the client, or submits feedback — one action, not two decisions. '
    + 'Approval moves it to Approved for Client. Feedback moves it to CD Feedbacks, which sits with the team lead.'),

  h2('7.9 CD Feedbacks and the relay'),
  p('CD Feedbacks does not go straight back to the artist. It stops with the team lead, who reads the Creative '
    + 'Director’s notes, adds their own reading of them if needed, and relays them on. Until they do, the artist '
    + 'cannot start the rework — and the application says so plainly rather than leaving the button silently dead.'),

  h2('7.10 Leaving the studio'),
  p('From Approved for Client there are two routes, and a studio uses whichever matches how it works with that client.'),
  bullets([
    'Deliver — the work is handed over and the asset is Delivered. One step.',
    'Send to client review — the asset moves to Awaiting Client Feedback while the client looks at it. If they approve, it becomes Delivered. If they ask for changes, it goes back to TL Feedbacks and round again.',
  ]),
  roles('The first gate sits with the first review gate band. The Creative Director gate and approval for client sit '
    + 'with creative direction. Delivery sits with the delivery band. The whole client-feedback loop — send, record '
    + 'approval, record changes — is Super Admin only out of the box and must be granted deliberately.',
    ['tl_gate', 'cd_gate', 'delivery', 'super_only']),

  pagebreak(),
  // ============================================================ 8
  h1('8. Project reviews and Pending Actions'),
  lead('Asset review is per asset. Project review is the other conversation: a producer asking the Creative Director '
    + 'to look at a project as a whole.'),

  h2('8.1 Sending a project to review'),
  steps([
    'Go to the Projects tab.',
    'Press Send Project to CD Review on the project.',
    'Say what you want looked at.',
    'Send.',
  ]),
  shot('08-send-project-review', 'A producer sending a project to the Creative Director.'),

  h2('8.2 The reviewer’s queue'),
  shot('07-pending-actions-cd', 'Pending Actions as the Creative Director sees it: Active for what is waiting, History for what has been answered.'),
  steps([
    'Open Pending Actions. The tab carries a count and is highlighted while something is waiting on you.',
    'Open a request and read it.',
    'Write your feedback and press Submit Feedback.',
  ]),
  p('The submitter is notified the moment the feedback lands.'),

  h2('8.3 Acknowledging the answer'),
  shot('08-pending-actions-submitter', 'The producer’s side: their own submissions, and the answers that came back.'),
  steps([
    'Open Pending Actions.',
    'Read the feedback on your submission.',
    'Press Acknowledge and Close when you have acted on it.',
  ]),
  p('Your own submissions never appear in your queue to answer — only in your queue to read.'),
  note('These permissions are narrow out of the box',
    'Sending a project to review, seeing Pending Actions, the review queue and the answering step are held by '
    + 'Super Admin, and in two cases the Creative Art Director, in a fresh deployment. A studio that wants its '
    + 'producers and directors using this must grant them in Settings first. This is the single most common reason '
    + 'the tab is missing for somebody who expects it.'),
  roles('The queue and the answering step sit with the Creative Art Director and Super Admin. Sending a project to '
    + 'review, and seeing your own submissions, are Super Admin only until granted.',
    ['cd_and_super', 'super_only']),

  pagebreak(),
  // ============================================================ 9
  h1('9. Time Sheet'),
  lead('Everybody fills in their own. It is a day at a time, in Indian Standard Time, against the studio’s '
    + 'configured working hours.'),

  h2('9.1 Your week'),
  shot('09-timesheet-week', 'A week. Each day is a card with its lines, its total and its state. The window in force is printed at the top right.'),
  p('The line above the days — 09:30-19:00 IST, lunch 13:00-14:00, 8h a day — is the studio’s configured window, '
    + 'not a fixed rule of the software. A Super Admin changes it in Settings (chapter 13.2) and the change applies '
    + 'to everybody from that moment.'),

  h2('9.2 Adding a line'),
  steps([
    'Press + Add a line on the day.',
    'Give a start and an end time.',
    'Choose the project, and the asset if the time was against one.',
    'Say what you did.',
    'Save.',
  ]),
  shot('09-timesheet-line-form', 'Adding a line.'),

  h2('9.3 The rules'),
  bullets([
    'Times are Indian Standard Time, always. Nothing is converted.',
    'A line must fall inside the working day. Outside it, the form refuses and says what the window is.',
    'Lunch is not loggable. A line crossing it has the lunch hour taken out of its total automatically.',
    'A day holds at most 8 loggable hours. The eighth hour is the limit, not a target.',
    'Every rule above reads the configured window. Change the window and the rules change with it.',
  ]),

  h2('9.4 Submitting a day'),
  steps([
    'Fill in the day.',
    'Press Submit this day.',
  ]),
  p('Submission is daily, not weekly. A submitted day is with your approver and is no longer yours to edit. '
    + 'The state on each card — Draft, Submitted, Approved — says where it is.'),

  h2('9.5 Approving'),
  shot('09-timesheet-approval-queue', 'The approver’s view: the days waiting on them, with the count carried on the tab.'),
  steps([
    'Open Time Sheet. The tab count is the number of days waiting on you.',
    'Read the day.',
    'Approve it, or send it back with a reason.',
  ]),

  h2('9.6 Excel and PDF'),
  p('Excel and PDF buttons sit at the top right of the week. Both export exactly what is on screen, for the week and '
    + 'the person shown.'),
  roles('Everybody fills in their own time sheet. Seeing and approving a team’s sits with the leads and producers '
    + 'band. Studio leadership can see everybody’s.', ['everyone', 'leads', 'leadership']),

  pagebreak(),
  // ============================================================ 10
  h1('10. Reports'),

  h2('10.1 Efficiency'),
  shot('10-reports-efficiency', 'The Efficiency report: estimated against actual, by whichever view is chosen.'),
  p('Efficiency compares the estimate on each asset — its man hours — against Time Spent, the gap between Accept '
    + 'and Start and Submit for Review. It can be read by user, by asset, by project or by scope of work.'),

  h2('10.2 Idle'),
  shot('10-reports-idle', 'The Idle report: working time with no asset open.'),
  p('Idle is working time during which somebody had nothing started. It is computed against the studio’s configured '
    + 'working hours, so time outside the working day and the lunch hour are not counted as idle. Overlapping '
    + 'sessions are counted once, not twice.'),

  h2('10.3 Idle Now'),
  p('A sub-tab answering the immediate question: who has nothing open at this moment, and what is waiting on them. '
    + 'It is a separate permission from the staff list, because noticing a stalled queue and reading everybody’s '
    + 'reporting line are different needs.'),

  h2('10.4 Exports'),
  p('Every report exports to Excel and to PDF. The exported file carries the view you were looking at, named after '
    + 'it, so an Idle export is not filed as an Efficiency one.'),
  roles('Reports sit with studio leadership, plus any designation given View Reports — Team Lead is a common one to '
    + 'add. The Idle report and Idle Now are separately granted.', ['leadership']),

  pagebreak(),
  // ============================================================ 11
  h1('11. People'),

  h2('11.1 The Users tab'),
  shot('11-users-list', 'The staff list: name, designation, who they report to, and their projects.'),

  h2('11.2 Adding somebody'),
  steps([
    'Press + User.',
    'Give their name and the email they will sign in with.',
    'Choose their designation. What it can do comes from the tier behind it — pick the closest match.',
    'Set who they report to, and the project they are on.',
    'Set a first password, which they can change from Profile.',
  ]),
  shot('11-user-new-form', 'The new-user form.'),

  h2('11.3 Bulk user import'),
  p('For a batch, the import takes a spreadsheet with the columns name, email, role, reports_to_email, project and '
    + 'password — the first three required. The asset uploader and the user uploader are separate and labelled, and '
    + 'each rejects the other’s file clearly rather than importing nonsense.'),

  h2('11.4 My Team'),
  shot('15-my-team', 'My Team: the people who report to you, what they are carrying and how far along it is.'),
  roles('Adding, editing and deleting people, changing designations, reporting lines, projects and passwords all sit '
    + 'with the administration band. My Team is open to anyone who supervises people.',
    ['administration', 'supervisors']),

  pagebreak(),
  // ============================================================ 12
  h1('12. Notifications and your profile'),

  h2('12.1 Notifications'),
  shot('14-notifications', 'The notification panel, opened from the bell.'),
  bullets([
    'The bell carries the number of unread notifications.',
    'You are notified when work is assigned to you, when a review comes back, when feedback on your project submission lands, and when a time sheet needs you.',
    'Mark all as read clears the count.',
  ]),

  h2('12.2 Your profile'),
  shot('14-profile', 'The Profile panel: your photo, and your password.'),
  h3('Your photo'),
  steps([
    'Press Profile.',
    'Choose an image and crop it in the preview.',
    'Save.',
  ]),
  p('Your photo appears everywhere you are represented — on cards, in the staff list, in My Team and in the header.'),
  h3('Your password'),
  steps([
    'Press Profile.',
    'Give your current password, then the new one twice.',
    'Save.',
  ]),
  note('Changing your password signs out your other sessions',
    'Every other browser and device signed in as you is signed out immediately. This is deliberate: a password is '
    + 'changed because it may be known, and a session that outlives the change would defeat the point.'),

  pagebreak(),
  // ============================================================ 13
  h1('13. Settings'),
  lead('Settings is not one screen but a set of them, and you get only the ones your designation holds. A person '
    + 'given one Settings permission gets this page with exactly that one section on it.'),

  h2('13.1 The Settings index'),
  shot('12-settings-top', 'The Settings page. The index at the top lists what you hold and, greyed, what lives elsewhere.'),

  h2('13.2 Working hours and lunch'),
  shot('12-settings-working-hours', 'The working-hours control.'),
  steps([
    'Set the start and end of the working day.',
    'Set the start and end of the lunch break, or clear both if the studio does not have a fixed one.',
    'Save.',
  ]),
  p('This one setting drives three things: what the Time Sheet will accept, how much of a line counts as work, and '
    + 'what the Idle report treats as working time. The form refuses a window that cannot hold the 8-hour daily '
    + 'maximum, a lunch outside the day, half a lunch, or a day that ends before it starts, and says why in each case.'),
  roles('Changing the working day is a studio-wide decision, so it sits with leadership rather than with the people who fill in time sheets.', ['leadership']),

  h2('13.3 Branding'),
  shot('12-settings-branding', 'Branding: the studio name and the colour used across the application.'),
  roles('The studio name and colour are leadership’s to set.', ['leadership']),

  h2('13.4 The value lists'),
  p('Four lists feed the dropdowns on the forms. Each is edited in Settings.'),
  table(
    ['List', 'What it feeds'],
    [
      ['Scope of Work', 'The Scope of Work dropdown, and the prefix each asset code is built from (CHR-001).'],
      ['Priorities', 'The Priority dropdown on Add Asset and in the asset panel.'],
      ['Categories', 'The Category dropdown. This list starts empty — nothing is assumed about how a studio groups its work.'],
      ['Roles', 'The Role dropdown on Add User. What a designation can do comes from the tier behind it.'],
    ],
    [2400, 6960]
  ),
  note('Renaming is safe; deleting in-use values is not allowed',
    'Renaming a value leaves every record that uses it working. A value in use cannot be deleted at all — '
    + 'deactivate it instead and it disappears from the dropdowns while the existing records keep their meaning.'),
  roles('Each list is a separate permission, so a studio can let somebody manage its categories without also handing them the designations list. All four sit with leadership by default.', ['leadership']),

  h2('13.5 The IP allowlist'),
  shot('12-settings-ip', 'The IP allowlist.'),
  p('Restricts sign-in to named addresses or ranges, written as single addresses or in CIDR notation. Every change '
    + 'is recorded with who made it. There are deliberate escape hatches so a studio cannot lock itself out entirely.'),
  roles('Super Admin, and nobody else. Sign-in restriction is not something to hand out.', ['super_only']),

  h2('13.6 Role permissions'),
  shot('12-settings-permissions', 'The Role Permissions section before a designation is chosen.'),
  steps([
    'Choose a designation from the dropdown.',
    'Tick or untick the actions it should hold. They are grouped by module.',
    'Save. Everyone holding that designation changes on their next request.',
  ]),
  shot('12-settings-permissions-role', 'The permission grid for one designation. Shown here to the first screenful; the real grid runs to all 58 permissions.'),
  bullets([
    'A change here applies to everybody holding that designation, not to one person.',
    'Super Admin holds every permission, including any added in future, and cannot be edited down.',
    'Every change is written to the Activity Log, naming the designation, the permission and the direction.',
  ]),
  roles('Super Admin, and nobody else — this is the screen that decides what everybody else may do.', ['super_only']),

  h2('13.7 The Activity Log'),
  shot('12-settings-activity', 'The Activity Log. Shown here to the first screenful of a much longer list.'),
  p('One consolidated record of every action anybody takes, newest first, with the person’s name and designation '
    + 'beside it. Times are IST.'),
  bullets([
    'Filter by person, by module, by action, by date range, or search the text.',
    'Where a change has a before and an after — a stage move, a permission toggle, a preview image set — the entry shows both.',
    'Nothing here can be edited or removed, from this screen or any other.',
    'Export the filtered view to Excel or PDF.',
  ]),
  note('It adds to the existing trails, it does not replace them',
    'An asset still keeps its own history, a project review its own feedback trail, and a time sheet its own approval '
    + 'log. The Activity Log is the one view that crosses all of them.'),
  roles('Studio leadership. The log is readable, filterable and exportable, and editable by nobody.', ['leadership']),
];
