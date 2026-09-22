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
  ['In Progress', 'The assignee has pressed Accept and Start. Time Spent runs from here, and pauses while the task is on hold.', 'The assignee, and nobody else.'],
  ['TL Review', 'Submitted, waiting on the first review gate — the project’s team, see 7.8b.', 'The assignee, on Submit for Review.'],
  ['TL Feedbacks', 'A reviewer asked for changes. Back with the assignee.', 'Anyone on the project team who may review at the first gate.'],
  ['TL Approved', 'The work has passed the first gate. Waiting on a decision about where it goes next.', 'Anyone on the project team who may review at the first gate, on approval.'],
  ['CD Review', 'Past the first gate and sent on, waiting on the Creative Director.', 'The reviewer, from TL Approved.'],
  ['CD Feedbacks', 'The Creative Director asked for changes. Sits with the team lead until relayed.', 'The Creative Director.'],
  ['Approved for Client', 'Cleared internally. Ready to leave the studio.', 'The Creative Director, or a lead who may skip the second gate.'],
  ['Awaiting Client Feedback', 'It has gone to the client and the studio is waiting.', 'Whoever holds Send to Client Review.'],
  ['Delivered', 'Finished and handed over.', 'Whoever holds Deliver, or the client approving.'],
];

const TRANSITIONS = [
  ['Assign', 'Not Assigned', 'Assigned', 'Asset Assign'],
  ['Accept and Start', 'Assigned', 'In Progress', 'The assignee'],
  ['Hold / Resume', 'In Progress / TL Feedbacks / CD Feedbacks', 'No change — the stage stays put', 'The assignee, with Hold / Resume Own Task'],
  ['Submit for Review', 'Not Assigned / In Progress / TL Feedbacks', 'TL Review', 'The assignee'],
  ['Submit for Review (after CD notes)', 'CD Feedbacks', 'CD Review or TL Review', 'The assignee'],
  ['TL Approved', 'TL Review', 'TL Approved', 'TL Review'],
  ['Request Changes', 'TL Review', 'TL Feedbacks', 'TL Review'],
  ['Approve \u2192 Send to CD Review', 'TL Approved', 'CD Review', 'TL Review'],
  ['Send to Client', 'TL Approved', 'Approved for Client', 'TL Send to Client'],
  ['Approve for client', 'CD Review', 'Approved for Client', 'CD Review'],
  ['Request changes', 'CD Review', 'CD Feedbacks', 'CD Review'],
  ['Relay the notes', 'CD Feedbacks', 'CD Feedbacks (now with the assignee)', 'TL Review'],
  ['Send to client review', 'Approved for Client', 'Awaiting Client Feedback', 'Send to Client Review'],
  ['Client approved', 'Awaiting Client Feedback', 'Delivered', 'Record Client Approval'],
  ['Client asked for changes', 'Awaiting Client Feedback', 'TL Feedbacks', 'Record Client Changes'],
  ['Deliver', 'Approved for Client', 'Delivered', 'Deliver'],
  ['Hand over (Reassign to Any User)', 'TL Review / CD Review / TL Feedbacks / CD Feedbacks', 'Assigned — the new person starts their own round', 'Asset Assign'],
  ['Reassign to Same User', 'TL Feedbacks', 'Assigned — the same person, a fresh round', 'Asset Assign'],
  ['Change the assignee', 'Not Assigned / Assigned / In Progress', 'Assigned', 'Asset Assign'],
  ['Unassign (pick Unassigned in the Assignee list)', 'Assigned / In Progress', 'Not Assigned', 'Asset Assign'],
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
  p('The studio ships with 60 designations and 64 permissions. Rather than repeat eight or twenty designations on '
    + 'every page, this manual names the fourteen groups of designations that the permissions actually fall into, '
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
    'Profile — your photo and your password (chapter 12.10).',
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
      ['Time Sheet', 'Your week, and your team\u2019s to read if you lead one.', 'Everyone'],
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
    'The preview image, if one has been set (chapter 6.3). Without one, the card shows the scope-of-work icon.',
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
  p('Opening a client lists its projects with what each one is and how it is going:'),
  table(
    ['Column', 'What it shows'],
    [
      ['Project', 'Its name, and its code beside it.'],
      ['Category', 'What kind of job it is \u2014 from the Project Categories list, which the studio keeps in Settings.'],
      ['Start Date', 'When the project begins. Optional.'],
      ['End Date', 'When it is due to finish. Optional.'],
      ['Milestones', 'The dated stages inside the project \u2014 Art from here to here, Animation from there to '
        + 'there \u2014 one line each. Only the stages that apply to that project; a project with none shows a dash.'],
      ['Total Bid Hours', 'Every asset\u2019s Man Hours estimate, added up. What the project was quoted at.'],
      ['Spent Time', 'The hours actually recorded against its assets.'],
      ['Status', 'Active, closed or archived.'],
    ],
    [2200, 7160]
  ),
  note('The two figures are worked out as you look at them',
    'Total Bid Hours and Spent Time are never stored on the project. They are counted from its assets on every read, '
    + 'so editing an estimate or finishing a round shows immediately, and there is nothing anybody has to remember to '
    + 'recalculate. Total Bid Hours counts EVERY asset under the project, whatever stage it is at and whichever tab it '
    + 'is on \u2014 an asset that has been delivered was still estimated, so it stays in the bid. Spent Time counts '
    + 'every round of every asset, including the finished rounds of people who have since handed the work on, and '
    + 'leaves out any stretch that was put on hold. It is the same figure, worked out the same way, that the '
    + 'Efficiency report shows per asset.'),

  h2('4.2 Creating a project'),
  steps([
    'Press + Project, at the right of the tab row.',
    'Give the project a name and pick the client it belongs to.',
    'Choose a Category, or leave it blank \u2014 it is optional. If the one you want is not in the list, pick "+ Add Category", type it and press Create: it is added to the studio\u2019s list and selected straight away, without leaving the form.',
    'Give it a Start Date and an End Date if the project has them. Both are optional, and a start date after the end date is refused.',
    'Name the team leads who will run its first review gate.',
    'Name the production coordinators, if the studio uses them.',
    'Add up to two people to the supervision list — the ones accountable for the project overall.',
    'Save.',
  ]),
  shot('03-project-new-form', 'The new-project form.'),
  note('These three lists are who may review this project\u2019s work',
    'The people named here are not only a record of who is involved. Anyone on any of the three lists can act on '
    + 'every asset in this project at TL Review, TL Feedbacks and TL Approved \u2014 whoever did the work, and '
    + 'whoever that person reports to. Leaving all three empty is allowed and falls back to the older behaviour, '
    + 'where an artist\u2019s own lead reviews their work. All three stay editable from Edit Project afterwards. '
    + 'See 7.8b for the whole rule.'),
  note('A project\u2019s dates describe it, they do not police it',
    'Start Date and End Date on a project are plain information. Nothing warns, blocks or moves when an end date '
    + 'passes with work outstanding, and a project whose dates are long past still takes new assets and still lets '
    + 'work be started on them. This is not the same field as an asset\u2019s Start Date, which does hold Accept and '
    + 'Start closed until the day arrives (7.4).'),
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
    'Optionally set a category, a priority, an estimate in man hours, a description, and the two dates: '
      + 'Start Date and End Date (Deadline). Both are optional and independent of each other.',
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
      ['Start Date', 'no', 'DD-MM-YYYY. The asset cannot be started before this day.'],
      ['End Date (Deadline)', 'no', 'DD-MM-YYYY. YYYY-MM-DD is accepted too. Sheets using the older "Deadline" heading still import.'],
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
  p('The table carries Start Date and End Date (Deadline) as columns, so a whole project\u2019s schedule can be '
    + 'read down two columns without opening anything. Every column has a filter of its own \u2014 see 5.3a.'),
  shot('04-assets-active', 'Active: everything still moving through the pipeline.'),
  shot('04-assets-inactive', 'Inactive: work nobody has picked up \u2014 assets that are Not Assigned, or '
    + 'assigned and not yet accepted. This is where a batch is selected for 5.5.'),
  shot('04-assets-archived', 'Archived: delivered work, kept for the record.'),
  shot('04-assets-history', 'History: every stage change, who made it and when.'),

  h2('5.3a Filtering the list'),
  p('A bar of filters sits under the sub-tabs, with one control for every column of the table \u2014 thirteen of '
    + 'them, each named after the heading it narrows. It is the same bar on all four sub-tabs.'),
  bullets([
    '<strong>Code</strong> and <strong>Assets Name</strong> \u2014 type a fragment of either. Not case sensitive, and it matches anywhere in the value, not just the start.',
    '<strong>Category</strong>, <strong>Scope of Work</strong>, <strong>Assignee</strong>, <strong>Round</strong>, <strong>Priority</strong> and <strong>Tasks</strong> \u2014 a dropdown each.',
    '<strong>Status</strong> \u2014 a tick list rather than a dropdown, so several stages can be asked for at once. TL Review, TL Feedbacks and TL Approved together is the usual reason.',
    '<strong>Man Hours</strong> and <strong>Time Spent</strong> \u2014 a smallest and a largest, either on its own or both. Time Spent is typed in hours.',
    '<strong>Start Date</strong> and <strong>End Date (Deadline)</strong> \u2014 a from and a to, either on its own or both. Both ends are included.',
  ]),
  p('EVERYTHING SET NARROWS TOGETHER. Choosing a project team member and a priority shows the rows that are both, '
    + 'not either \u2014 each filter takes away, none of them adds back. A filter left empty is not asked at all, so '
    + 'a bar with nothing in it shows the same list as no bar.'),
  p('<strong>Reset filters</strong>, at the end of the bar, clears the lot in one press. It is greyed out while '
    + 'nothing is set, so it also says at a glance whether anything is being hidden. The count beside it says '
    + '\u201cshowing 12 of 340\u201d whenever a filter is on, and just the row count when none is.'),
  note('The filters stay put when you change sub-tab',
    'Filter by assignee on Active, switch to History, and it is still that person\u2019s work you are looking at. '
    + 'That is the same thing the search box in the header already does on this screen, and it is what makes the '
    + 'counts on the sub-tabs useful: with a filter on, each tab\u2019s number is how many MATCHING rows it holds, '
    + 'so the tabs themselves tell you where the rest of what you are looking for is.\n\n'
    + 'A filter narrows within the sub-tab and never instead of it. Nothing set here can put an Archived row on the '
    + 'Active tab \u2014 the tab decides which rows exist, the filters decide which of those are shown.'),
  p('WHY THERE IS NO PROJECT OR CLIENT FILTER. The Assets List is already one project, under one client, both chosen '
    + 'in the header \u2014 a control for either would have one option in it. Neither is a column of this table for '
    + 'the same reason. The header\u2019s pickers are where that choice is made.'),
  p('A tick made for a bulk action is not lost when a filter hides the row. The selection bar counts those '
    + 'separately \u2014 \u201c3 hidden by the filter\u201d \u2014 so narrowing, ticking, widening and ticking '
    + 'again adds up to what it says it does.'),

  h2('5.4 Delivering several at once'),
  steps([
    'On the Assets List, tick the assets you want to deliver.',
    'Press the bulk deliver action.',
    'Confirm.',
  ]),
  p('Every asset in the batch is recorded individually in its own history, and the batch itself is recorded too, so '
    + 'a bulk delivery is as auditable as fifteen single ones.'),
  h2('5.5 Assigning and scheduling several at once'),
  p('Handing out a batch of new work. Select the assets, choose one assignee and one pair of dates, and press '
    + 'Apply \u2014 whatever is filled in is applied to every asset selected.'),
  steps([
    'On the Assets List, open the Inactive sub-tab, where work nobody has picked up sits.',
    'Narrow the pile with the filter bar if it is a long one \u2014 5.3a. Category and Scope of Work are the usual two.',
    'Tick the assets you want to set up.',
    'Press Assign & Schedule. The button says how many of your selection it will touch.',
    'Fill in any of Assignee, Start Date and End Date (Deadline), and press Apply.',
  ]),
  bullets([
    'Each field is optional. Set only the dates to schedule a batch without changing who holds it, or only the assignee to hand work out without inventing a schedule for it.',
    'One value for all of them, not a value per asset. This is for the forty assets that all begin on the same Monday and all belong to the same person; anything more varied is done on each asset.',
    'A blank field is left alone, not cleared. Emptying a date that is already set is done on the asset itself, where you can see what you are clearing.',
    'A start date after the end date is refused before anything is written, and the message quotes both dates back.',
    'Every asset is reported on its own line. One that cannot be set up does not hold up the rest.',
  ]),
  note('Only work nobody has started',
    'This sets up assets that are Not Assigned. Anything already on somebody\u2019s desk is skipped and listed with '
    + 'the reason. That is not because the record would be lost \u2014 handing work over in bulk would keep the '
    + 'round and the history exactly as the single flow does \u2014 but because a handover ends somebody\u2019s '
    + 'round and resets the Time Spent they can see, and doing that to forty assets from a tick list is a different '
    + 'act from doing it once with a name in front of you. Work under way is handed over one asset at a time, from '
    + 'its own panel.'),
  p('Everything a single assignment does, a bulk one does: the asset moves to Assigned, a Round opens, the person is '
    + 'notified, and the change is written to that asset\u2019s history and to the Activity Log. The batch itself is '
    + 'recorded too, so each asset\u2019s history says which act it was part of. A Start Date set this way gates '
    + 'Accept and Start exactly as one typed on the asset does (7.4).'),
  roles('Creating assets and bulk upload sit with production planning. Editing and assigning are open to everyone '
    + 'who works on assets, within the reach their designation gives them. Deleting an asset is administration only. '
    + 'Delivery sits with the delivery band. Bulk Assign & Schedule starts with Super Admin alone and is granted in '
    + 'Settings \u2192 Role Permissions to the coordinators who plan work \u2014 and granting it opens the bulk '
    + 'panel without widening whose assets anybody may touch: each asset is still checked one by one.',
    ['planners', 'asset_workers', 'delivery', 'administration', 'super_only']),

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
    'Man Hours, Start Date, End Date (Deadline), Category, Priority, Description.',
    'Tasks — the checklist, and the count the card shows.',
    'Notes, submissions and history, further down.',
  ]),

  h2('6.2 Who is holding it'),
  p('The Assignee list in the panel is the ordinary way work changes hands, and it does three things depending on '
    + 'what is picked. Choosing somebody on a Not Assigned asset assigns it, and the asset moves to Assigned. '
    + 'Choosing somebody else on an asset already under way hands it over: the outgoing person’s round is closed '
    + 'with their hours intact, and the new person starts a fresh one.'),
  p('Choosing Unassigned takes the work back off whoever holds it. The asset returns to Not Assigned — it goes '
    + 'back in the pool, and the card moves to the Not Assigned column — and any clock running on it stops. Two '
    + 'exceptions, both deliberate. Work that has already been submitted keeps its place in the review queue: '
    + 'unassigning an asset sitting in TL Review or CD Review clears the name but leaves the stage alone, so a '
    + 'reviewer does not lose a round somebody handed in. And the Bulk Assign panel has no Unassigned option: it '
    + 'only acts on Not Assigned assets, which have nobody on them to remove.'),
  p('Every one of these is recorded in the asset’s history, naming who made the change, who it came off and who '
    + 'it went to.'),

  h2('6.3 The preview image'),
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

  h2('6.4 Tasks and notes'),
  p('Tasks are a checklist on the asset — the 0/3 on the card. Notes are a running conversation, kept with the asset '
    + 'rather than in anybody’s inbox.'),

  h2('6.5 History'),
  p('Every stage change the asset has been through, with who made it, when, and what they wrote. This is the asset’s '
    + 'own record and is separate from the studio-wide Activity Log in chapter 13.7.'),

  pagebreak(),
  // ============================================================ 7
  h1('7. The workflow, stage by stage'),
  lead('Ten stages, and a fixed set of moves between them. Nothing moves an asset except one of these moves, and '
    + 'every one of them is recorded.'),

  h2('7.1 The eleven stages'),
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
  p('The asset moves to In Progress and the clock starts. Nothing ticks on screen: Time Spent is the part of the '
    + 'span between this moment and the moment you submit that falls inside the studio\u2019s working hours, less '
    + 'any stretch you put on hold (7.6).'),
  shot('13-work-in-progress', 'The same asset once started. The panel now shows when you started, and Time Spent is running.'),

  h2('7.3a The recording schedule'),
  p('The clock counts working time, not wall-clock time. Start an asset at ten to seven on a Friday and submit it on '
    + 'Monday morning and it has cost about two hours, not sixty-three. What counts is set in Settings \u2192 '
    + 'Working Hours, and it is the same setting the Idle report and the Time Sheet already read.'),
  p('THE STUDIO\u2019S SCHEDULE, as shipped:'),
  table(['', 'IST'], [
    ['Recording days', 'Monday to Friday. Nothing on Saturday or Sunday, ever.'],
    ['Recording hours', '09:30 \u2013 19:00'],
    ['Morning break', '11:00 \u2013 11:15 \u2014 recording stops'],
    ['Lunch', '13:00 \u2013 14:00 \u2014 recording stops'],
    ['Afternoon break', '16:00 \u2013 16:15 \u2014 recording stops'],
    ['A full day', '8 hours, which is exactly what the Time Sheet allows in a day'],
  ]),
  bullets([
    'It is IST, always. The studio\u2019s window is a wall clock in one office, so neither the server\u2019s timezone nor your laptop\u2019s changes what is recorded. Somebody working from another country has their hours measured against the studio\u2019s day, not their own.',
    'A BREAK STOPS THE CLOCK and starts it again at the far end. A timer running at 10:45 is put down at 11:00 and picks up at 11:15; the same at one o\u2019clock and at four. This changed: a break used to be subtracted from the total without stopping anything.',
    'A timer running when the day ends is put down at 19:00. Not when anybody noticed, and not when the server got round to it: the boundary is exact, so an evening left running costs the asset nothing.',
    'It starts again on its own the next working morning, at 09:30, with nobody pressing anything \u2014 and back-dated to 09:30, so signing in at eleven finds the morning already counted. Weekends and any other non-working day are skipped: a timer put down at seven on Friday starts again on Monday. See 7.3b for the cases where it does not.',
    'Starting outside a recording stretch is allowed. The click is never refused \u2014 you are taking the work on, and being made to wait would only mean recording a start time that was not true. The timer begins paused, accrues nothing, and joins the schedule at the next stretch.',
    'Public holidays are not recorded anywhere. A day the studio is shut for a festival still counts as a working day unless somebody changes the working days in Settings for that week.',
  ]),
  note('There is no Resume button for any of this',
    'Every stop and start above is the schedule\u2019s, and it makes them on the server whether or not anybody has '
    + 'the app open. So there is nothing to press: the panel says which stop it is and when recording picks up, and '
    + 'that is the whole of it.\n\n'
    + 'Hold keeps its Resume, and that is a different thing \u2014 a pause YOU chose, which the schedule does not '
    + 'undo, so the button is the only way back from it. The panel tells the two apart in as many words.'),
  p('WHERE THIS SHOWS UP. It is corrected at the source \u2014 one column, work_sessions.seconds \u2014 so every '
    + 'figure built on it moves together: Time Spent on the card and in the Assets List, the Efficiency report, the '
    + 'hours the Time Sheet suggests when you add a line, and the Fixed and Actual hours in the P&L. There is no '
    + 'screen where the old number survives, and none that needed its own fix.'),

  h2('7.3b When the overnight resume does NOT happen'),
  p('The clock starting itself is only right while the work is still there to be done, so the application asks '
    + 'again at half past nine rather than assuming what was true at seven. Four answers mean no, and in each of '
    + 'them the timer stays down for you to pick up by hand:'),
  bullets([
    '<strong>You submitted it.</strong> Work waiting on a reviewer is not work in progress, and nothing accrues against it. This is the case the check exists for.',
    '<strong>It was reassigned.</strong> Somebody else holds it now. Their clock starts when they press Accept and Start, in a round of their own \u2014 the overnight rule never reaches across an assignment.',
    '<strong>It was taken off everybody.</strong> Nobody holds it, so nobody\u2019s clock runs.',
    '<strong>You started something else.</strong> The studio\u2019s one-active-task rule holds here exactly as it does on the Resume button: the task you actually chose this morning keeps running, and last night\u2019s waits.',
  ]),
  p('A task you put down YOURSELF is also left alone. Hold and the working-hours pause look similar on screen and '
    + 'are one column apart in the record, but they are different things: one is a decision you made, and the '
    + 'application does not undo it overnight. Only the pause the studio applied starts itself again.'),
  note('The hours are the studio\u2019s day, not your attendance',
    'This records the working day as configured, not whether you were at your desk for it. A task left open '
    + 'overnight and forgotten will be counted from 09:30 until somebody submits it, holds it or hands it on. That '
    + 'is the studio\u2019s decision and it is the point of the feature \u2014 the alternative, which this '
    + 'replaced, was a clock that stayed down until pressed and quietly lost a morning\u2019s real work.\n\n'
    + 'The panel says which state a task is in and the bell says when the clock started again, so the way to stop '
    + 'a figure you do not want is Hold. Breaks still come out either way.'),
  p('Every stop and start runs on the server, on a schedule, not when somebody opens the page \u2014 so it '
    + 'happens at eleven o\u2019clock with nobody looking, and a server restarted overnight does the missed '
    + 'ones on the way back up. Each is stamped at its own boundary whatever time the check actually ran, so '
    + 'a late tick costs nobody a correct number: open the app at ten and the state already reflects what '
    + 'should have happened at half past nine.'),

  h2('7.4 Not before the start date'),
  p('An asset carrying a Start Date cannot be accepted before that day. The button is disabled until then and says '
    + 'which day it is waiting for, and the server refuses an early start as well \u2014 a disabled button is a '
    + 'courtesy, not the rule.'),
  bullets([
    'On or after, not only on. A start date that slipped past unnoticed leaves the task late, not forbidden \u2014 it stays startable.',
    'No start date means no waiting. The field is optional, and blank behaves exactly as it did before the field existed.',
    'Today is IST, the same day boundary the Time Sheet uses, so a reader in another timezone sees the same answer as the studio.',
  ]),

  h2('7.5 One active task at a time'),
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

  h2('7.6 Putting a task on hold'),
  p('Work stops for reasons that are nobody\u2019s fault \u2014 a client call, a machine being reimaged, a day off in '
    + 'the middle of a long asset. Hold is how you say so, and the time between holding and resuming is left out of '
    + 'that asset\u2019s Time Spent.'),
  steps([
    'With the asset In Progress, press Hold in the Time Spent box.',
    'Say why, in a line, or leave it blank \u2014 the reason is optional.',
    'Press Resume when you pick it up again. (That is for a hold YOU made, and it is the only Resume left in the app. A pause the recording schedule made \u2014 a break, or the end of the day \u2014 starts again by itself and has no button; see 7.3a.)',
  ]),
  bullets([
    'Holding frees you to start something else. It is the one way to have a second task open without finishing the first.',
    'Resuming obeys the same one-task rule as starting. If something else is open when you press Resume, it is refused and names what to finish \u2014 holding is not a way around the rule.',
    'The asset does not change stage. It stays In Progress, or in whichever feedback stage its rework belongs to, and carries an On hold badge on the board and in the Assets List so a lead can see the work has stopped.',
    'The round is unchanged. A hold is not a submission, so picking the work up again continues the same round rather than starting a new one.',
    'You may hold as many tasks as you like. Each one keeps its badge, so none of them can be quietly forgotten.',
    'Hand a held task to somebody else and the hold does not follow it. Their Time Spent starts at nothing, and your hours stay on the asset.',
  ]),
  p('WHAT THIS COSTS, AND WHY IT IS WORTH SAYING. Time Spent is working-hours time less whatever was declared as a '
    + 'hold, which means its accuracy depends on people pressing the button \u2014 exactly as the Time Sheet\u2019s '
    + 'does. Two assets showing the same hours can mean different things, so the Efficiency report says how many of '
    + 'the assets it covers had time held back. Note also that the Idle report and the Efficiency report move in '
    + 'opposite directions for the same honest hold: the held gap is time nothing was open, so it reads as idle, '
    + 'while the asset\u2019s efficiency improves. They measure different things and are meant to disagree here.'),
  p('A studio that would rather nobody paused anything can switch Hold / Resume Own Task off for a designation in '
    + 'Settings \u2192 Role Permissions. Nobody is stranded by that: a task already on hold is picked up with the '
    + 'ordinary Accept and Start button, and Time Spent goes back to counting every hour between the two stamps.'),
  p('Holding somebody ELSE\u2019s task is not something anybody can do in this version, Super Admin included. A lead '
    + 'who needs work stopped reassigns the asset or moves its stage, both of which record who did it. A separate '
    + 'permission for holding on another person\u2019s behalf could be added if the studio asks for one.'),

  h2('7.7 Submitting for review'),
  steps([
    'With the asset In Progress, scroll to Submissions in the panel.',
    'Attach the file, or paste the link to it.',
    'Press Submit for Review.',
  ]),
  p('The asset moves to TL Review, Time Spent is fixed, and the reviewer is notified. You cannot submit work you '
    + 'never started — the stamps are what make Time Spent mean anything.'),

  h2('7.8 The first review gate'),
  shot('06-tl-review-panel', 'An asset at TL Review, seen by the team lead.'),
  p('WHO STANDS AT THIS GATE: the PROJECT\u2019S team. Anyone named on the project in one of four '
    + 'categories \u2014 <strong>Team Lead</strong>, <strong>Production Coordinator</strong>, '
    + '<strong>Supervision</strong> or <strong>Creative Direction</strong> \u2014 can act on every asset in that '
    + 'project sitting at TL Review, TL Feedbacks or TL Approved. It does not matter which artist did the work, '
    + 'and it does not matter who that artist reports to. See 7.8b.'),
  steps([
    'Open the asset from your queue.',
    'Look at what was submitted.',
    'Press <strong>TL Approved</strong> to pass it, or <strong>Request Changes</strong> with a note saying what needs doing.',
  ]),
  p('TWO BUTTONS, AND THAT IS THE WHOLE GATE. This screen asks one question \u2014 is the work good \u2014 and '
    + 'nothing else. It used to carry a third button that sent work straight to the client, which meant a lead was '
    + 'answering \u201cis this good\u201d and \u201cwho else needs to see it\u201d in the same click. Approving now '
    + 'lands the asset in <strong>TL Approved</strong>, and the second question is asked there on its own (7.8a).'),

  h2('7.8a TL Approved \u2014 where does it go now?'),
  p('An asset here has passed the first gate and is waiting on the lead to choose its route. Two buttons, and they '
    + 'are not the same kind of decision:'),
  bullets([
    '<strong>Approve → Send to CD Review</strong> — the ordinary pipeline. The Creative Director looks at it next. Whoever may review at the first gate may do this.',
    '<strong>Send to Client</strong> — skips the Creative Director entirely and lands on Approved for Client, one step from Delivered. This needs <strong>TL Send to Client</strong> on top of the review permission, and a lead without it does not see the button.',
  ]),
  p('WHY THE SECOND ONE IS GATED DIFFERENTLY. Passing work through a gate and walking around one are different '
    + 'authorities. TL Send to Client defaults to the full-access tier alone, so a studio grants it to particular '
    + 'senior leads deliberately rather than getting it by holding the review permission. Moving the button from '
    + 'the review pop-up to this screen did not move the authority behind it.'),
  p('There is no route back into CD Review once Send to Client has been used \u2014 that is the point of it. A '
    + 'studio that wanted the work reviewed after all sends it back through the ordinary path by reassigning it.'),
  roles('The ordinary route on sits with the first review gate. Send to Client is its own permission and is Super '
    + 'Admin only out of the box.', ['tl_gate']),

  h2('7.8b Who may act at these three stages'),
  p('The first gate belongs to the project, not to the reporting line. Put somebody on a project\u2019s team and '
    + 'they can review its work; take them off and they cannot. Nothing about who reports to whom comes into it.'),
  p('The four categories are the three lists on the project form, which is where they are set:'),
  bullets([
    '<strong>Team leads on this project</strong> \u2014 Team Lead and the other lead designations.',
    '<strong>Production coordinators on this project</strong> \u2014 Production Coordinator and the rest of Production.',
    '<strong>Supervision and Creative Direction</strong> \u2014 one section holding both, up to two people. '
      + 'An Art Supervisor and an Art Director, typically.',
  ]),
  p('They are set when the project is created and stay editable afterwards from Edit Project. A change takes '
    + 'effect immediately \u2014 there is nothing to re-save on the assets themselves.'),
  p('WHAT THIS REPLACED, AND WHY. The gate used to ask a question about the ARTIST: who is this person\u2019s team '
    + 'lead, and is that you? Two things went wrong with that often enough to be worth naming. A lead staffed on a '
    + 'project could not clear work done by somebody who reported elsewhere \u2014 the asset simply sat there with '
    + 'nothing on screen explaining why. And a Production Coordinator running the project, or a Supervisor '
    + 'answerable for its look, is nobody\u2019s \u201creports to\u201d, so neither could act however plainly they '
    + 'were on the project.'),
  p('EVERYBODY QUALIFYING CAN ACT \u2014 this is not one gatekeeper. If a project has a lead, a coordinator, a '
    + 'supervisor and a director on it, all four see the work and any of them can move it. Whoever gets there '
    + 'first moves it, exactly as two leads would have raced before.'),
  p('NOBODY REVIEWS THEIR OWN WORK, and being on the project team does not change that. A lead who is on the '
    + 'project and is also the person who submitted the asset gets no review controls on it \u2014 a colleague on '
    + 'the same team clears it instead. This matters more than it used to, because leads can be handed work and are '
    + 'exactly the people likely to be on the team.'),
  p('A PROJECT WITH NOBODY ON ITS TEAM keeps the older behaviour: the artist\u2019s own lead reviews their work, '
    + 'and failing that any lead who can see it. Projects created before this change therefore carry on working '
    + 'rather than stalling at the first gate. Name one person on the project and the rule above takes over.'),
  p('THE PERMISSION IS STILL THE SWITCH. Being on a project team does not hand anybody First Review Gate '
    + '\u2014 it decides WHERE somebody who holds it may use it. Every designation the project form can name starts '
    + 'with the permission, and a Super Admin takes it away in Settings \u2192 Role Permissions like any other.'),
  p('One thing the categories do not level out: handing rework to somebody else also needs <strong>Asset '
    + 'Assign</strong>, and Creative Direction does not hold that by default. A director on the project can Request '
    + 'Changes and approve, and will not see Hand over until that permission is granted. That is unchanged by any '
    + 'of this, and it is one toggle in Settings.'),
  roles('Any project-team member in the four categories, holding First Review Gate.', ['tl_gate']),

  h2('7.9 TL Feedbacks'),
  shot('05-asset-tl-feedback', 'An asset returned with the lead’s notes, seen by the artist who holds it.'),
  p('The asset comes back to you with the note attached. Press Accept and Start again to reopen it — which counts '
    + 'as your one active task — and Submit for Review when the changes are done. It goes back to the same gate.'),
  p('The reviewer who sent it back has two ways to put the rework back on the board, and both are on this screen:'),
  bullets([
    '<strong>Reassign to Same User</strong> — one click, straight back to whoever did the first round. This is the common case, and it used to be the one thing the screen would not do.',
    '<strong>Reassign to Any User</strong> — the full picker, for when the rework belongs with somebody else. They may be on something else, out, or simply the wrong fit for the note.',
  ]),
  p('Both do the same move and go through the same rules: the asset leaves TL Feedbacks and returns to '
    + '<strong>Assigned</strong> with a fresh round and a clock of its own, the designation is checked the same way, '
    + 'the history records it the same way, and the person picking it up is told. The earlier round\u2019s hours stay '
    + 'on the record; the note and the whole history travel with the asset. Where the two differ, only the picker '
    + 'tells the previous holder that the work has moved \u2014 on the one-click path nobody has lost anything, so '
    + 'there is nothing to tell them.'),
  p('The picker offers the studio\u2019s ordinary eligible-assignee list, so a team lead appears in it and can be '
    + 'handed the rework like anyone else. Whoever is holding the asset is not in that list, because the button '
    + 'above it is how you send it back to them.'),
  roles('Who sees this control is the TL review permission plus Asset Assign, and being on this project\u2019s '
    + 'team in one of the four categories \u2014 never a designation by name. Take First Review Gate away from a '
    + 'role in Settings \u2192 Permissions and the control goes with it for everyone holding that role; take the '
    + 'person off the project team and it goes for them on that project alone. See 7.8b.',
    ['tl_gate']),

  h2('7.10 The Creative Director gate'),
  shot('07-cd-review-panel', 'An asset at CD Review.'),
  p('The Creative Director either approves it for the client, or submits feedback — one action, not two decisions. '
    + 'Approval moves it to Approved for Client. Feedback moves it to CD Feedbacks, which sits with the team lead.'),

  h2('7.11 CD Feedbacks and the relay'),
  p('CD Feedbacks does not go straight back to the artist. It stops with a lead, who reads the Creative '
    + 'Director’s notes, adds their own reading of them if needed, and relays them on. Until they do, the artist '
    + 'cannot start the rework — and the application says so plainly rather than leaving the button silently dead.'),
  p('Who may relay is the same question as who may review at the first gate, and gets the same answer: the '
    + 'project’s team, in the four categories described in 7.8b. It is one idea — who is standing at this '
    + 'project’s lead gate — and giving it two answers is how the two would drift apart.'),

  h2('7.12 Leaving the studio'),
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
  lead('Everybody fills in their own. It is a weekday at a time, Monday to Friday, in Indian Standard Time, '
    + 'against the studio’s configured working hours.'),

  h2('9.1 Your week'),
  shot('09-timesheet-week', 'A week. Each day is a card with its lines, its total and its state. The window in force is printed at the top right.'),
  p('The line above the days says what a day is flagged at. It is the studio’s own number rather than a fixed '
    + 'rule of the software: a Super Admin changes it in Settings (chapter 13.2) and the change applies to '
    + 'everybody from that moment.'),
  note('There is no Saturday or Sunday',
    'The week shows five cards, Monday to Friday, and the API refuses a line dated to a weekend as well — so '
    + 'an out-of-date browser cannot put a row somewhere the screen will never show it. The date range at the top '
    + 'names the days actually shown, not the calendar week behind them.\n\n'
    + 'Weekend WORK is not lost. Time recorded by the timer on a Saturday still counts towards the asset, and the '
    + 'hours it recorded are offered on the next weekday you file against that asset — because the figure is '
    + 'your whole recorded time on the asset, not that one day’s. What is gone is the weekend ROW, not the '
    + 'weekend’s hours. A weekend day that already carries lines from before this change is still shown, so '
    + 'nothing already filed disappears.'),

  h2('9.2 Adding a line'),
  steps([
    'Press + Add a line on the day.',
    'Choose the project, and the asset if the time was against one.',
    'If the line names an asset, the hours are worked out for you and the field is locked. If it does not \u2014 leave, a meeting, training, or project time with no asset named \u2014 type the hours in.',
    'Say what you did.',
    'Save.',
  ]),
  note('Where the filled-in hours come from',
    'Choosing an asset fills in WHAT IS LEFT: the time you have recorded on that asset, less whatever you have '
    + 'already logged against it on any day. So a job that took three days offers its first day\u2019s hours, then '
    + 'only what has accrued since, then only what accrued after that \u2014 the three add up to the time the asset '
    + 'recorded, once, instead of to that total three times over. The line under the field shows the arithmetic: '
    + 'what was recorded, what is already on your timesheet, and what is left.'),
  note('The figure is not yours to type',
    'Where a line names an asset the hours are the software\u2019s answer, not a suggestion: the field is locked, '
    + 'and the server works the number out again when the line is saved, so nothing typed into it would survive. '
    + 'The lock is the server\u2019s rather than the field\u2019s \u2014 a request made outside the form is worth '
    + 'the same calculated figure.\n\n'
    + 'An asset still in progress offers the time elapsed so far, not counting anything it spent on hold. An asset '
    + 'you have already logged in full offers nothing and says so, and a second line against it is refused rather '
    + 'than filed as nought. An asset the timer has never run on cannot be logged against at all: time is measured '
    + 'from Accept and Start, and there is nothing for the sheet to read.\n\n'
    + 'Because the figure is the whole outstanding balance rather than a part of it, filing a line claims '
    + 'everything not yet claimed. Skip a day and the next day\u2019s line carries the earlier day\u2019s hours '
    + 'too \u2014 the total across the asset is right either way, but the hours sit on the day they were filed.'),
  note('If the number looks wrong, flag it',
    'Nobody can correct a locked figure, so the way to disagree with one is on the record instead of over it. '
    + 'Tick THIS FIGURE LOOKS WRONG under the Hours field and say briefly what is wrong \u2014 a timer left '
    + 'running, a stretch worked without starting it. The reason is required: a mark with no reason is one nobody '
    + 'can act on. It is stored with the line and shown beside the hours on the day, to you and to whoever reads '
    + 'your week. Raising or clearing a flag never changes the hours.'),
  note('It is your own recorded time, not the asset\u2019s',
    'An asset handed over from somebody else carries their hours in its Time Spent on the Efficiency report, '
    + 'because that is what the asset cost. The figure offered here counts only your own stretches, because their '
    + 'hours are not yours to file. After a hand-over the two numbers differ, and both are right.'),
  shot('09-timesheet-line-form', 'Adding a line.'),

  h2('9.3 The rules'),
  bullets([
    'A line is a number of hours against one thing. There are no start and end times to give.',
    'The smallest line is a quarter of an hour; the largest single line is a day. A timer left running longer than that files a day and offers the rest again tomorrow.',
    'A day over 8 hours is FLAGGED, not refused. A long day is a real thing, and a form that refuses one teaches people to log eight and go home late.',
    'A line is either project work or non-project time, never both.',
    'Saturday and Sunday are not days the sheet has. A line dated to one is refused.',
    'Hours against an asset are calculated and locked; hours with no asset are typed.',
  ]),
  note('What the simpler form gives up',
    'A line used to be a stretch of the clock, and three rules went with it. Two are no loss: the 09:30\u201319:00 '
    + 'working window and the automatic lunch subtraction were only ever checks against times nobody types any '
    + 'more. The third is a real one. Two lines claiming the same hours used to be refused, and that is the single '
    + 'arithmetic mistake a timesheet cannot catch by adding up \u2014 the total looks perfectly reasonable. With '
    + 'hours alone there is nothing to compare, so the day total and its flag are the only defence left. Worth '
    + 'knowing when reading somebody\u2019s week.'),

  h2('9.4 Submitting a day'),
  steps([
    'Fill in the day.',
    'Press Submit this day.',
  ]),
  p('Submission is daily, not weekly, and it is the end of it: a submitted timesheet is nobody else\u2019s to '
    + 'approve. Submitting locks the day so that filing it is a definite act rather than an autosave, and the '
    + 'state on each card \u2014 Draft or Submitted \u2014 says where it is.'),
  note('You can take a day back yourself',
    'A locked day carries a Reopen button for the person whose day it is. This exists BECAUSE approval does not: '
    + 'the way out of a locked day used to be asking your approver to send it back, and with nobody to ask, a '
    + 'mistyped 8 that should have been 0.8 would be permanent. Reopening is written to the day\u2019s own history '
    + 'and to the Activity Log, so a day submitted, changed and submitted again says so. Only its owner can do it '
    + '\u2014 a lead reading their team\u2019s hours has no such button.'),

  h2('9.5 Reading your team\u2019s hours'),
  p('Holding View Team Timesheets puts a person picker above the week. Pick somebody and their week is drawn '
    + 'exactly as their own is, and entirely read-only. There is nothing to approve, nothing to send back and no '
    + 'queue \u2014 those went with the approval step. What is left is oversight, which is what a lead needed.'),
  p('A flagged line shows its reason here too. Since the hours themselves are calculated, a flag is the only '
    + 'thing on the sheet somebody has written about a figure, and it is worth reading: it usually means the '
    + 'timer and the day did not agree.'),

  h2('9.6 Excel and PDF'),
  p('Excel and PDF buttons sit at the top right of the week. Both export exactly what is on screen, for the week and '
    + 'the person shown.'),
  roles('Everybody fills in their own time sheet. Seeing a team\u2019s sits with the leads and producers band, and '
    + 'seeing it is all it does. Studio leadership can see everybody\u2019s. There is no Approve Timesheets '
    + 'permission any more \u2014 it was removed with the step it gated, rather than left as a switch that turns '
    + 'nothing on.', ['everyone', 'leads', 'leadership']),

  pagebreak(),
  // ============================================================ 10
  h1('10. Reports'),

  h2('10.1 Efficiency'),
  shot('10-reports-efficiency', 'The Efficiency report: estimated against actual, by whichever view is chosen.'),
  p('Efficiency compares the estimate on each asset — its man hours — against Time Spent, the gap between Accept '
    + 'and Start and Submit for Review, less any stretch put on hold. It can be read by user, by asset, by project '
    + 'or by scope of work.'),
  p('The report says how many of the assets it covers had time held back, because two assets showing the same hours '
    + 'mean different things if one had a day taken out of it. Holding is something a person chooses to record, so '
    + 'an asset with no holds may still have been interrupted — the number is a measure of turnaround, not of effort.'),

  h2('10.2 Idle'),
  shot('10-reports-idle', 'The Idle report: working time with no asset open.'),
  p('Idle is working time during which somebody had nothing started. It is computed against the studio’s configured '
    + 'working hours, so time outside the working day and the lunch hour are not counted as idle. Overlapping '
    + 'sessions are counted once, not twice.'),
  p('Time put on hold counts as idle here, and that is deliberate rather than an oversight: nothing was open, which '
    + 'is what this report measures. So a hold improves an asset’s efficiency and worsens the holder’s idle figure '
    + 'at the same time. The two reports answer different questions and are meant to disagree on this point — read '
    + 'either alone and the other will look wrong.'),

  h2('10.3 Idle Now'),
  p('A sub-tab answering the immediate question: who has nothing open at this moment, and what is waiting on them. '
    + 'It is a separate permission from the staff list, because noticing a stalled queue and reading everybody’s '
    + 'reporting line are different needs.'),

  h2('10.4 Exports'),
  p('Every report exports to Excel and to PDF. The exported file carries the view you were looking at, named after '
    + 'it, so an Idle export is not filed as an Efficiency one.'),
  roles('Reports sit with studio leadership, plus any designation given View Reports — Team Lead is a common one to '
    + 'add. The Idle report and Idle Now are separately granted.', ['leadership']),

  h2('10.5 Profit & Loss'),
  p('Two tabs, the same projects, the same hours, two different questions. They are separately granted, so a '
    + 'producer can be given one without the other, and holding neither hides the screen entirely.'),
  bullets([
    'Fixed P&L asks whether the work cost more or less than it was estimated at. Nothing on it is entered by hand \u2014 there is no contract value, no billing and no revenue figure on that tab at all.',
    'Actual P&L asks what the studio is making on a project. It has one field: the Total Project Value.',
  ]),

  h3('The two figures both tabs are built on'),
  bullets([
    'Total Hours (Budgeted) — every asset’s Man Hours estimate, added up. The same number the Projects tab calls Total Bid Hours.',
    'Total Hours Recorded — hours logged against tasks that have reached Delivered. It rises as tasks are delivered and never needs touching. Working hours only, in IST (7.3a), so evenings and weekends are not in it.',
  ]),
  p('BOTH TABS READ THE SECOND ONE, and it is genuinely one figure rather than two that happen to agree. Deliver a '
    + 'task and the recorded hours move on Fixed P&L and Actual P&L together, by the same amount.'),

  h3('How everything is costed'),
  p('From the <strong>Rate Card</strong> in Settings, which says what one hour of each role and level costs. Hours '
    + 'are costed at the rate of the person who logged them; the estimate on an asset is costed at the rate of the '
    + 'person it is assigned to. Same list, same method, both sides \u2014 which is what makes the difference '
    + 'between them a difference in <em>hours</em> rather than an artefact of the two halves being priced '
    + 'differently.'),
  bullets([
    'A correction spreads. Nothing is copied onto a row, so fixing a rate re-costs every project it applies to, for work already done as well as work still to come.',
    'An unpriced designation is not a free one. Its hours are counted and its cost is not, and the screen says so in as many words — the real figures are higher, and both the variance and the margin look better than the truth.',
  ]),

  h3('Fixed P&L'),
  p('Total Hours (Budgeted), Total Hours Recorded, Budgeted Cost, Actual Cost and the Variance between them, in '
    + 'rupees and per cent, with a table breaking both sides down by role and level.'),
  p('THE SIGN OF THE VARIANCE IS THE POINT. It is budgeted cost minus actual, so a <strong>positive</strong> figure '
    + 'is money the studio did not have to spend \u2014 a saving \u2014 and a <strong>negative</strong> one is an '
    + 'overrun. The percentage is against the budget: \u201cwe came in 39% under what we planned\u201d is a '
    + 'statement about the plan. A project nobody estimated is <em>unplanned</em> rather than under budget, and says '
    + 'so rather than showing a confident zero.'),

  h3('Actual P&L'),
  p('Total Project Value, Total Hours Recorded, Cost, Profit and Margin, with the same breakdown table. Profit is '
    + 'the value less the cost; margin is the profit as a share of the value.'),
  p('The Total Project Value is the only figure in the whole feature that anybody types. A project with none '
    + 'entered has no profit and no margin and shows a dash \u2014 a different statement from a project worth '
    + 'nothing, and the two must not look alike.'),

  h3('What is no longer here'),
  p('Billing Type, Invoiced to Date, Other Costs, the manual Project Team list, the typed Total Cost, the manually '
    + 'entered Fixed Contract Value and the second free-text rate list have all been removed. Every one of them was '
    + 'either a number the application already recorded or a number nobody kept up to date, and a stale figure in a '
    + 'P&L is worse than a missing one because it looks authoritative. The margin trend went with them: it was drawn '
    + 'from a snapshot written whenever somebody saved on the screen, and with nothing left to save it would have '
    + 'frozen while still looking live.'),
  p('Their data has not been deleted. The columns and rows are still in the database; nothing reads them.'),
  roles('Access Fixed P&L is a view-only grant \u2014 there is nothing on that tab to change. Access Actual P&L '
    + 'covers the tab and its Total Project Value together. Manage Rate Card is the third, and it is the one with '
    + 'reach: the Rate Card costs every project at once. All three are Super Admin only out of the box.',
    ['super_only']),

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

  h2('11.4 Resetting somebody\u2019s password'),
  p('When somebody is locked out, an administrator gives them a temporary one rather than being '
    + 'told what they had. Press Reset password on their row in the Users tab.'),
  steps([
    'The screen says what will happen, and asks you to confirm.',
    'The password they have been given is shown. Pass it on to them.',
    'Close the panel.',
  ]),
  shot('11-user-reset-password', 'The confirmation. The screen after it shows the temporary password, once.'),
  note('What the reset does, and what it deliberately does not',
    'It signs out every device that account is signed in on, and it locks the account to one '
    + 'action: choosing a new password. Until they do, nothing else in the app answers them \u2014 '
    + 'enforced by the server, not just hidden by the screen, so the password they are given '
    + 'cannot be used to work.\n\n'
    + 'It does NOT tell you their old password, and nobody \u2014 at any permission level \u2014 '
    + 'ever sees the password they then choose.\n\n'
    + 'There is no email. This deployment has no mail transport configured, so the password '
    + 'travels by whatever channel the two of you already use. The account holder is told in the '
    + 'app that their password was reset and by whom.'),
  note('It is the studio\u2019s standing password, not a one-off',
    'A reset sets the same password every time \u2014 the one every new account is also created '
    + 'with. That is the studio\u2019s choice, so an administrator has one thing to remember and '
    + 'one thing to say over the phone rather than a different string each time.\n\n'
    + 'It carries a cost worth understanding. The password is not a secret and is not unique to '
    + 'the person: anybody who knows it and their email address could sign in and set a new one '
    + 'for them, in the window between the reset and that person signing in. The lock does not '
    + 'prevent this \u2014 it only prevents the account being USED without a change, and the '
    + 'change is exactly what an impostor would do. So tell the person promptly.\n\n'
    + 'Two things reduce the risk. Set DEFAULT_USER_PASSWORD in the deployment\u2019s .env so the '
    + 'value is not the one printed in this manual or in the source. And reset a password when the '
    + 'person is there to receive it, rather than in advance.'),
  note('Who may do it',
    'Reset User Password is a permission like any other, and it starts switched on for the Super '
    + 'Admin and nobody else. Grant it in Settings \u2192 Permissions (chapter 13.1) to hand it to '
    + 'another designation.\n\n'
    + 'One rule holds whoever has it: you cannot reset the password of an account that can change '
    + 'who may do what. Otherwise the permission would be a way of taking over the studio \u2014 '
    + 'grant it to somebody, and they reset the Super Admin. Nor can you reset your own from here; '
    + 'that is Profile, with your current password.'),
  p('Every reset is on the Activity Log, naming who did it and to whom. The password itself is not '
    + 'in it, and is not in the notification either \u2014 the value is settable per deployment, so '
    + 'a log quoting it would be a log that leaks whatever a studio set it to.'),

  h2('11.5 My Team'),
  shot('15-my-team', 'My Team: the people who report to you, what they are carrying and how far along it is.'),
  roles('Adding, editing and deleting people, changing designations, reporting lines, projects and passwords all sit '
    + 'with the administration band. My Team is open to anyone who supervises people.',
    ['administration', 'supervisors']),

  pagebreak(),
  // ============================================================ 12
  h1('12. Notifications, chat and your profile'),

  h2('12.1 Notifications'),
  shot('14-notifications', 'The notification panel, opened from the bell.'),
  bullets([
    'The bell carries the number of unread notifications.',
    'Mark all as read clears the count.',
    'Clicking one opens the asset or the project it is about, switching the pickers if it is somewhere you are not currently looking.',
    'The same events also appear on your DESKTOP, outside the browser \u2014 see below.',
  ]),
  p('What raises one:'),
  table(['Event', 'Who is told', 'What it says'], [
    ['Work is assigned to you', 'The new assignee',
     '\u201cPriya Nair assigned you FX-001 \u2014 Dragon Head.\u201d'],
    ['Work is taken off you', 'The outgoing assignee',
     'Who it moved to, or that it is no longer assigned to anybody.'],
    ['Work you handed out is submitted', 'Whoever assigned it, and the submitter\u2019s team lead',
     '\u201cAna Artist submitted FX-001 \u2014 Dragon Head in Reef Riches for review.\u201d'],
    ['A project is submitted for review', 'Everybody holding View Project Review Queue', 'Who submitted which project.'],
    ['Your project submission is answered', 'The person who submitted it', 'That the answer is ready to read and close.'],
    ['You are tagged in a chat message', 'Each person named, once', '\u201cPriya Nair mentioned you in Neon Drift.\u201d Never what was said \u2014 see 12.7.'],
    ['An administrator resets your password', 'The account holder only', 'Who did it. Never the password itself.'],
  ]),
  note('Who hears about a submission, and why those two',
    'Whoever ASSIGNED the work \u2014 they handed it out and are waiting on it \u2014 and the '
    + 'submitter\u2019s TEAM LEAD, who is the first review gate. If one person is both, they are '
    + 'told once, not twice. The person who pressed Submit is never told about their own '
    + 'submission, however many of those roles they hold.\n\n'
    + 'It fires on SUBMIT and on nothing before it. Accept and Start raises nothing: that is '
    + 'somebody picking up work they had already been given, and nobody else is waiting on it. A '
    + 'resubmission after a lead has asked for changes is a new round and does raise a new one.'),

  h2('12.2 Desktop notifications'),
  p('Everything in the table above, and every chat message, raises a notification on your DESKTOP '
    + 'as well as in the app, so you are told while working in something else. Each one carries a '
    + 'heading that says what kind of event it is \u2014 Assigned to you, Submitted for review, '
    + 'Work reassigned \u2014 and the same sentence the bell shows underneath it. A bar at the '
    + 'top of the screen asks for permission the first time you sign in; press Turn on '
    + 'notifications and answer your browser\u2019s own prompt.'),
  p('They arrive on their own, without reloading the page: the app checks for new ones every half '
    + 'minute and raises whatever has appeared since it last looked. Several at once \u2014 a '
    + 'batch of forty assets assigned in one action \u2014 raise ONE pop-up saying how many, '
    + 'rather than forty boxes up the side of the screen. The bell carries the count and the panel '
    + 'carries the rest.'),
  note('What "on" and "off" mean here, exactly',
    'There is no switch inside Zvky Forge to turn desktop notifications off. The only control is '
    + 'the browser\u2019s, and that is not a choice the studio made \u2014 it is how the web '
    + 'works: no site can show a desktop notification without the browser\u2019s permission, and '
    + 'no site can raise that prompt more than once per answer, suppress it, pre-answer it, or get '
    + 'around a refusal.\n\n'
    + 'So: everybody is asked, anybody who has not answered is asked again next time they sign in, '
    + 'and Not now postpones rather than cancels. If somebody REFUSES the browser prompt, the app '
    + 'says so in a bar that cannot be dismissed, with what to change \u2014 rather than leaving '
    + 'them to wonder why nothing arrives. Only they can undo it, in their browser\u2019s site '
    + 'settings.'),
  note('Two things that also stop one arriving',
    'Notifications need a SECURE CONNECTION. Over plain http browsers do not allow them at all, '
    + 'and the same bar says so. They start working once the site is reached over https.\n\n'
    + 'And granting the browser permission is not the same as the operating system letting it '
    + 'through. Somebody with Do Not Disturb or Focus on will see nothing, and the app is never '
    + 'told. The bell and the chat panel still carry everything either way \u2014 a desktop '
    + 'notification is a second copy, never the only one.'),
  p('A message in the conversation you already have open, in a window you are looking at, does not '
    + 'raise one \u2014 you are reading it. Everything else does.'),

  h2('12.3 Chat'),
  shot('14-chat-thread', 'A one-to-one conversation, opened from the chat icon in the header.'),
  p('The speech-bubble icon beside the bell opens chat. It carries the number of unread messages, the way the '
    + 'bell carries notifications.'),
  roles('Chat is open to everybody by default. A Super Admin can close it for a designation in Settings.', ['everyone']),
  h3('Messaging one person'),
  steps([
    'Press the chat icon.',
    'Press New message.',
    'Search for the person and pick them.',
    'Type, and press Enter. Shift+Enter starts a new line instead of sending.',
  ]),
  p('There is one conversation per pair of people, and it is the same conversation from both ends — messaging '
    + 'somebody you have spoken to before reopens the thread rather than starting a second one.'),
  note('You do not need a permission to message a colleague',
    'Talking to one other person is what a colleague does, not a privilege the studio hands out, so Use Chat '
    + 'starts on for every designation — the same reasoning as filling in your own time sheet. It is still a '
    + 'toggle, so a studio that wants chat closed for a department can say so in Settings.'),

  h2('12.4 Groups'),
  shot('14-chat-group', 'The member list of a group, as its owner sees it.'),
  roles('Starting a group is restricted. Everybody can already chat one to one without it.', ['runs_work']),
  steps([
    'Press the chat icon, then New group.',
    'Give the group a name and tick the people to put in it.',
    'Press Create.',
  ]),
  p('A group holds thirty people, counting the person who made it. The panel shows the count as you tick, and '
    + 'the thirty-first is refused rather than quietly dropped.'),
  p('The person who created the group owns it. The owner renames it, adds people and removes them, from the '
    + 'member list behind the “N members” link in the conversation header. Anybody in a group can leave it.'),
  note('An owner who leaves hands the group on',
    'Ownership moves to whoever has been in the group longest, so a group never ends up with nobody able to '
    + 'manage it. When the last person leaves, the group is closed.'),

  h2('12.5 Files in chat'),
  p('The paperclip attaches a file. Six formats are carried \u2014 .png, .jpg, .svg, .webp, .mov and .mp4 \u2014 up to '
    + '30MB each. Anything else is refused with a message naming what was wrong.'),
  h3('Saving one'),
  p('Every attachment in a conversation carries a download button, and it saves the file exactly as it was '
    + 'sent \u2014 pictures are shrunk on screen to fit the panel, never in the file itself. On a picture or '
    + 'a video the button sits in the top corner and appears when the pointer is over it; on a phone, and on '
    + 'a row for a file that is not shown inline, it is simply there. The filename is still a link, as it '
    + 'always was.'),
  bullets([
    'Anybody who can see the message can save what is in it \u2014 the person who sent it and everybody who '
      + 'received it, in a one-to-one conversation and in a group alike.',
    'The file keeps its own name. A screenshot pasted in is saved as pasted-20260418-143210.png rather than '
      + 'as whatever the browser would have called it.',
    'An expired attachment has no button: there is nothing left on the server to fetch.',
  ]),
  h3('Pasting a screenshot'),
  p('A picture on the clipboard can go straight into the message box: click into it and press Ctrl+V '
    + '(Cmd+V on a Mac). The image is attached the same way the paperclip attaches one \u2014 a thumbnail '
    + 'appears above the box with a \u00d7 to take it back off, and it sends as an ordinary attachment. It '
    + 'works in a one-to-one conversation and in a group, and the picture can go on its own or alongside '
    + 'something typed.'),
  bullets([
    'Pasting ordinary text is unchanged \u2014 it goes into the box as text, as it always did.',
    'Copying words and a picture together attaches the picture and types the words.',
    'The same six formats and the same 30MB ceiling apply, with the same refusal. A screenshot copied as a '
      + 'GIF is turned away exactly as a .gif chosen through the paperclip would be.',
    'Up to five files on one message, however they were added.',
  ]),
  note('Chat files are deleted after twelve hours',
    'A screenshot pasted in to ask “is this the right blue” has done its job by the end of the day, and chat '
    + 'is not the studio\u2019s archive. Twelve hours after it is sent \u2014 a working day and the evening after '
    + 'it \u2014 the file is deleted. THE MESSAGE STAYS: the words are kept, and the attachment is replaced by a '
    + 'line naming the file and saying it has expired. Anything worth keeping belongs on the asset, where '
    + 'submissions and reference links live.'),
  p('Text messages do not expire. A conversation\u2019s history stays until the conversation itself is gone.'),

  h2('12.6 Sent, delivered, read'),
  p('Every message you send carries a mark beside its time, and it means what the same marks mean '
    + 'everywhere else:'),
  table(['Mark', 'What it means', 'When it changes'], [
    ['One check', 'Sent. It is on the server and cannot now be lost.', 'The moment the message goes.'],
    ['Two checks, grey', 'Delivered. It has reached everybody\u2019s Zvky Forge.',
     'When their app next looks \u2014 they do not have to do anything, and neither do you.'],
    ['Two checks, blue', 'Read. Everybody has opened the conversation and seen it.',
     'When the last of them looks at the thread.'],
  ]),
  bullets([
    'The marks move on your screen by themselves. You never have to reload to watch a message go from '
      + 'one check to two to blue.',
    'In a GROUP both double marks mean everybody: grey once the last person\u2019s app has it, blue once '
      + 'the last person has read it. One person on leave keeps a message grey, which is the point.',
    'In a group, tap the marks to see WHO \u2014 every member, with when it reached them and when they '
      + 'read it, or that it has not reached them yet. Only the person who sent a message can open that.',
    'Somebody who leaves a group stops holding a message back. The \u201ceverybody\u201d is recalculated '
      + 'from whoever is in the group now.',
    'A message sent to somebody who is not signed in stays on one check until they are, then goes to two '
      + 'on its own.',
  ]),
  note('Read means somebody looked, not that the app was running',
    'Zvky Forge sitting behind another window goes on receiving \u2014 messages still arrive and still go '
    + 'to two grey checks. Blue needs the conversation to be open and on screen. So the two marks answer '
    + 'two different questions: \u201chas it got there\u201d and \u201chas anybody looked at it\u201d, '
    + 'which is exactly the difference somebody waiting on an answer cares about.'),

  h2('12.7 Tagging somebody \u2014 @mentions'),
  p('Type @ in the message box and a list of people opens. Keep typing to narrow it \u2014 \u201c@pri\u201d '
    + 'finds Priya Nair \u2014 then press Enter, or Tab, or click the one you want. The name goes into the '
    + 'message highlighted, and stays highlighted once it is sent.'),
  bullets([
    'The list offers the people in THAT conversation and nobody else. In a group, its members; in a '
      + 'one-to-one, the other person. Somebody who is not in the room cannot be tagged from it.',
    'Tag as many people as you like in one message. Each of them is told once, however many times their '
      + 'name appears in it.',
    'You are not offered to yourself, because tagging yourself would notify nobody.',
    'Delete the name again before sending and it stops being a tag \u2014 nothing is sent to anybody.',
  ]),
  note('A tag is louder than a message, on purpose',
    'An ordinary message shows up in the chat panel and on your phone. Being TAGGED also raises a '
    + 'notification in the bell and on your desktop, headed \u201cYou were mentioned\u201d \u2014 the same '
    + 'channel an assignment uses, and a different one from chat\u2019s own. Clicking it opens the '
    + 'conversation.\n\n'
    + 'It says who tagged you and which conversation, and never what was said. That is the same rule the '
    + 'rest of chat follows: a message on a lock screen is the one place this application could show a '
    + 'private conversation to whoever is standing nearby. The app is two taps away.\n\n'
    + 'There is no way to mute a conversation in Zvky Forge, so nothing can currently stop a tag \u2014 or '
    + 'any other chat notification \u2014 reaching you. If muting is ever added, a tag is built to come '
    + 'through it.'),

  h2('12.8 Designations nobody may write to unasked'),
  p('A designation can be shielded: nobody starts a conversation with it, or adds it to a group, unless they '
    + 'hold Message a Shielded Designation. Out of the box that shields Managing Director & CEO and Vice '
    + 'President \u2014 Global Operations & Business Development, and only the Super Admin can reach them.'),
  roles('Going through a shield.', ['super_only']),
  bullets([
    'The shield is one way round. A shielded designation still messages anybody it likes.',
    'Anybody it has written to can write back \u2014 otherwise its own messages would be unanswerable.',
    'Shielded people are left out of the New message and Add people lists rather than shown and refused.',
    'History stays readable. What stops is writing more into a conversation they never took part in.',
  ]),
  note('It is a switch, not two names in the code',
    'Open Inbox is an ordinary permission on the Role Permissions screen, held by every designation by default '
    + 'and switched OFF to shield one. So a studio that wants a third designation shielded, or wants one of '
    + 'these two reachable again, changes a checkbox \u2014 there is no list of job titles buried in the '
    + 'application to keep in step with the studio\u2019s own.'),

  h2('12.9 Who can read a conversation'),
  p('This chapter said, until the studio decided otherwise, that nobody could ever read a conversation '
    + 'they were not in. That is no longer true, and the paragraph saying it has been replaced rather '
    + 'than left standing. What follows is what is true now.'),
  note('Inside chat, a conversation is private to the people in it',
    'Nobody reads a conversation through the chat panel that they are not in \u2014 not a Super Admin, not '
    + 'the holder of any permission. There is no chat permission that opens somebody else\u2019s messages, '
    + 'no way to reach one from the panel, and a file link is not a way round it: the membership check is '
    + 'inside the query that fetches the bytes.'),
  note('Outside it, there is now one screen that reads everything',
    'Settings \u2192 Chat Activity shows every message in the studio, one-to-one and group, with its sender, '
    + 'its conversation and its text. It is behind its own permission \u2014 View Chat Activity \u2014 which '
    + 'starts held by the Super Admin and nobody else, and is deliberately narrower than the Activity Log '
    + 'beside it.\n\n'
    + 'It is a separate screen with a separate key on purpose. Granting it changes nothing about how chat '
    + 'works, and holding every chat permission does not open it. See chapter 13.5.'),
  p('The cost is worth stating plainly, because it did not stop being real when the studio authorised it: '
    + 'people say different things when they know they are read, including \u201cI think this brief is '
    + 'wrong\u201d \u2014 the sentence a studio most needs somebody to be able to send. Tell people that '
    + 'chat is logged. In some places that is a legal expectation as well as a decent one; either way, the '
    + 'application cannot do it for you, and the permission carries a warning saying so to whoever grants '
    + 'it.'),

  h2('12.10 Your profile'),
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
    'Tick the days the studio works. Monday to Friday out of the box.',
    'Set the start and end of the working day.',
    'Set the start and end of each break, or clear both ends of one the studio does not have.',
    'Save.',
  ]),
  p('This one setting drives four things: what the timer records, what the Time Sheet will accept, how much of a '
    + 'line counts as work, and what the Idle report treats as working time. The form refuses a window that cannot '
    + 'hold the 8-hour daily maximum, a break outside the day, half a break, two breaks that overlap, or a day that '
    + 'ends before it starts, and says why in each case.'),
  p('THE TIMER IS THE NEWEST OF THE FOUR, and the one worth knowing about before changing anything here. Time Spent '
    + 'on every asset is the part of its start-to-submit span that falls inside the days and hours on this screen '
    + '(7.3a). A change here is NOT retroactive: each stretch of work is measured against the window in force at the '
    + 'moment it ends, and that figure is then stored, so widening or narrowing the day changes what is recorded '
    + 'from now on and leaves finished work exactly as it was. That is deliberate \u2014 a setting that silently '
    + 'rewrote last quarter\u2019s hours would rewrite last quarter\u2019s P&L with them. The times are read as '
    + 'IST wherever the server and the reader happen to be.'),
  roles('Changing the working day is a studio-wide decision, so it sits with leadership rather than with the people who fill in time sheets.', ['leadership']),

  h2('13.3 Branding'),
  shot('12-settings-branding', 'Branding: the studio name and the colour used across the application.'),
  roles('The studio name and colour are leadership’s to set.', ['leadership']),

  h2('13.4 The value lists'),
  p('Six lists feed the dropdowns on the forms. Each is edited in Settings, and each is its own permission.'),
  table(
    ['List', 'What it feeds'],
    [
      ['Scope of Work', 'The Scope of Work dropdown, and the prefix each asset code is built from (CHR-001).'],
      ['Priorities', 'The Priority dropdown on Add Asset and in the asset panel.'],
      ['Asset Categories', 'The Category dropdown on an asset \u2014 what kind of thing it is. Starts empty.'],
      ['Project Categories', 'The Category dropdown on a project \u2014 what kind of job it is. A separate list, starting empty.'],
      ['Milestone Types', 'The stages a project can be planned in \u2014 the Milestones column. Art and Animation to '
        + 'begin with; add the studio\u2019s own.'],
      ['Roles', 'The Role dropdown on Add User. What a designation can do comes from the tier behind it.'],
    ],
    [2400, 6960]
  ),
  note('The two category lists are separate on purpose',
    'A project\u2019s category answers "what kind of work is this" \u2014 a slot game, a pitch, a co-development. An '
    + 'asset\u2019s answers "what kind of thing is this" \u2014 a character, an environment, an effect. Sharing one '
    + 'list would put both vocabularies in both dropdowns and make each of them wrong, and there is no way back once '
    + 'a studio has filled it in. They are two lists, in two tables, behind two permissions, with no values in '
    + 'common.'),
  note('Renaming is safe; deleting in-use values is not allowed',
    'Renaming a value leaves every record that uses it working. A value in use cannot be deleted at all — '
    + 'deactivate it instead and it disappears from the dropdowns while the existing records keep their meaning.'),
  roles('Each list is a separate permission, so a studio can let somebody manage its project categories without also handing them the asset categories or the designations list. All five sit with leadership by default.', ['leadership']),

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
  shot('12-settings-permissions-role', 'The permission grid for one designation. Shown here to the first screenful; the real grid runs to all 64 permissions.'),
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

  h2('13.8 Chat Activity'),
  shot('12-settings-chat-activity', 'Chat Activity, before anything has been read. Nothing is fetched, and nothing is logged, until the button is pressed.'),
  p('Every chat message in the studio \u2014 one-to-one and group \u2014 with its sender, its conversation, when '
    + 'it was sent and its full text. Read-only: nothing here can be edited, removed or replied to, and there is '
    + 'no way to join a conversation from it.'),
  bullets([
    'Filter by person, by whether it was one-to-one or a group, by date range, by whether there was a file, or search the text.',
    'The person filter reaches BOTH SIDES \u2014 what somebody said, and what was said in a room they are in.',
    'A one-to-one conversation is named by both people in it; a group by its title and its current membership.',
    'A file inside its twelve-hour window opens from here. Past it, the same placeholder as in chat.',
    'Group notices \u2014 "X created this group" \u2014 are in the record too, marked as notices rather than as somebody\u2019s message.',
  ]),
  note('Reading it is itself recorded',
    'Every visit writes a line to the Activity Log naming who looked and what they filtered by \u2014 not what they '
    + 'read. Opening a file writes its own line naming the file. That is what makes the screen accountable rather '
    + 'than merely permitted, and it is why the listing sits behind a button: a section that loaded itself would '
    + 'record a visit every time anybody opened Settings for any reason, and bury the times somebody actually went '
    + 'looking.'),
  note('It preserves nothing',
    'Chat files are still deleted twelve hours after they are sent, here as everywhere. This screen cannot recover '
    + 'one, and cannot keep one alive \u2014 oversight reads what is there, it does not extend what would otherwise '
    + 'have gone.'),
  note('Before you grant it',
    'View Chat Activity starts held by the Super Admin and nobody else \u2014 deliberately narrower than the '
    + 'Activity Log above it, because what people DID to the work and what people SAID to each other are different '
    + 'kinds of access. Extending it is a decision, not a default.\n\n'
    + 'Tell staff that chat is logged before granting it, not after. Many organisations disclose this as a matter of '
    + 'practice and in some places it is a legal expectation; the application cannot do it for you. The permission '
    + 'carries this warning on the Role Permissions screen so whoever grants it reads it at the moment they do.'),
  roles('The Super Admin alone, until somebody decides otherwise.', ['administration']),
];
