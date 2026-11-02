// EVERY AREA OF FORGE, ITS VIEW KEY AND ITS WRITE KEYS — in one table.
//
// ===========================================================================
// WHAT THIS IS FOR. The studio asked for role-wise VIEW-ONLY access: a role
// that may open a screen and read it without being able to change anything.
// Forge already had that for some areas (reports, Outsource, the Server tab,
// Holidays) and not for others, where "can you see this screen" was answered by
// the key that CHANGES it — so handing somebody read access to Working Hours
// meant handing them the ability to move everybody's working day.
//
// So every area is listed here with:
//
//   view    the key that opens the screen and guards its READ routes;
//   writes  the keys that change something in it, each of which IMPLIES view
//           (see src/permission-catalog.js: a role with a write key keeps
//           working exactly as it did, and the roles screen shows the view as
//           on and locked);
//   gates   the page elements whose visibility is this area's view question;
//   section the Settings section, where the area is one;
//   class   how the area stood BEFORE this prompt, which is the audit:
//             'A' already had a proper view key — left exactly as it was;
//             'B' had write keys and no view key — one was added;
//             'C' was visible by role tier or nothing — one was added whose
//                 defaults reproduce today's visibility exactly;
//             'D' self scope — my own timesheet, my own profile, my own
//                 notifications, a chat I am a member of. Not governed by
//                 view-only roles and deliberately untouched.
//
// NOTHING HERE WIDENS SCOPE. A view key decides whether a screen opens, never
// which rows it shows: visibleProjects() and the existing per-row checks are
// unchanged, so a view-only role sees its own projects and not the studio's.
//
// AND NO VIEW KEY REACHES PRIVATE DATA. There is deliberately no "view all
// chats" key; chat stays membership-based. Where an area mixes shareable
// configuration with a secret — the mail server's password, the gateway's keys,
// the integration's client secret — the view key covers the configuration and
// the secret is never returned to anybody, which tests/settings-secrets.test.js
// enforces route by route.

/* The areas, in the order the Settings index and the sidebar put them. */
const AREAS = [
  // ---------------------------------------------------------------- the tabs
  { id: 'admin_dashboard', label: 'Admin Dashboard', class: 'A',
    view: 'report.admin_dashboard', writes: ['report.follow_up', 'report.remind'],
    gates: ['adminDashTabBtn'],
    note: 'Its own grant already, and what it counts is scoped by the role.' },

  { id: 'projects', label: 'Projects & clients', class: 'C',
    view: 'client.view',
    writes: ['client.add', 'client.edit', 'client.delete', 'client.close',
      'project.add', 'project.edit', 'project.delete', 'project.close', 'project.milestones'],
    gates: ['projectsTabBtn', 'newClientBtn', 'newProjectBtn', 'editProjectBtn'],
    note: 'The TAB was already client.view, but GET /api/projects had no key at all — '
      + 'any signed-in person could read the project list within their scope over the API '
      + 'while the tab was hidden. The read keeps working for everybody (the artist board '
      + 'needs it), and project.view now says so out loud: implied for every designation.',
    addView: 'project.view' },

  { id: 'assets', label: 'Assets & asset detail', class: 'D',
    view: null,
    writes: ['asset.add', 'asset.edit', 'asset.delete', 'asset.assign', 'asset.assign_any',
      'asset.bulk_upload', 'asset.bulk_assign', 'asset.lead_notes', 'asset.hold', 'asset.hold_any',
      'asset.override_stage'],
    gates: ['newAssetBtn', 'bulkImportBtn', 'downloadSampleBtn'],
    note: 'ROW SCOPE, NOT A SCREEN KEY. Every asset read is decided per asset by '
      + 'canViewAsset()/visibleProjects() and every transition by the workflow table in '
      + 'src/asset-workflow.js — a key that said "may see the Assets tab" would be either a '
      + 'lie or a widening. Left alone, and the reason is written down here so the next '
      + 'reader does not add one.' },

  { id: 'review', label: 'Review queue', class: 'A',
    view: 'review.client_view',
    writes: ['review.tl', 'review.cd', 'review.approve_client', 'review.tl_send_client',
      'review.tl_feedback', 'review.deliver', 'review.client_send', 'review.client_deliver',
      'review.client_return'],
    gates: [],
    note: 'review.client_view is the existing read grant; the rest are the gates in the '
      + 'pipeline, each decided per asset.' },

  { id: 'project_reviews', label: 'Project review queue & Pending Actions', class: 'A',
    view: 'project.review_queue',
    writes: ['project.review_send', 'project.review_respond'],
    gates: ['pendingTabBtn'],
    note: 'pending.view opens Pending Actions; project.review_mine is a self scope.' },

  { id: 'timesheet', label: 'Time Sheet', class: 'D',
    view: 'timesheet.own',
    writes: ['timesheet.tl_action'],
    gates: ['timesheetTabBtn'],
    note: 'timesheet.own is self scope — my own week. timesheet.team and timesheet.all are '
      + 'the existing grants for reading other people\'s, which is what a view-only role '
      + 'with no writes already gets.' },

  { id: 'reports', label: 'Reports', class: 'A',
    view: 'report.view', writes: [],
    gates: ['reportsTabBtn'],
    note: 'Already view-only by nature: report.view, report.idle and report.artist_report '
      + 'read and never write.' },

  { id: 'pnl', label: 'Profit & Loss', class: 'A',
    view: 'pnl.actual', writes: ['pnl.manage'],
    gates: ['pnlTabBtn'], section: 'pnl.manage',
    note: 'pnl.actual and pnl.fixed are the two read grants (the screen shows the sub-tabs '
      + 'the viewer holds); pnl.manage is the rate card. Already the shape this prompt is '
      + 'about, and the routes enforce it with their own middleware.' },

  { id: 'outsource', label: 'Outsource', class: 'A',
    view: 'outsource.view',
    writes: ['outsource.manage', 'outsource.deliver', 'outsource.reopen', 'outsource.rates'],
    gates: ['outsourceTabBtn'] },

  { id: 'users', label: 'Users & teams', class: 'A',
    view: 'user.view',
    writes: ['user.add', 'user.edit', 'user.delete', 'user.deactivate', 'user.reset_password',
      'user.change_role', 'user.change_project', 'user.change_reporting', 'user.bulk_upload'],
    gates: ['usersTabBtn'],
    note: 'user.view_team is the narrower read for My Team; user.idle_view reads who is idle.' },

  { id: 'server', label: 'Server tab (office file server)', class: 'A',
    view: 'server.view',
    writes: ['server.upload', 'server.download', 'server.request_delete', 'server.manage_requests',
      'server.submit_upload', 'server.browse_all'],
    gates: ['serverTabBtn'],
    note: 'server.view_audit is a second read grant. The tab also needs the studio switch — '
      + 'the one gate in the page table that reads something other than a permission.' },

  { id: 'chat', label: 'Chat', class: 'D',
    view: 'chat.use',
    writes: ['chat.group_create', 'chat.group_manage_any', 'chat.message_protected'],
    gates: ['chatWrap'],
    note: 'MEMBERSHIP, NOT A VIEW KEY, and deliberately no "view all chats" grant exists. '
      + 'settings.chat_activity is the studio\'s oversight screen and reads only what it '
      + 'already covered.' },

  { id: 'notifications', label: 'Notifications', class: 'D', view: null, writes: [], gates: [],
    note: 'Self scope: my own inbox, read and marked read by me.' },

  { id: 'profile', label: 'My profile', class: 'D', view: null, writes: [], gates: [],
    note: 'Self scope. Changing somebody ELSE\'s photo or password is user.edit / '
      + 'user.reset_password, which are in the users area above.' },

  // ------------------------------------------------------------- the settings
  { id: 'settings_permissions', label: 'Role Permissions', class: 'B',
    view: null, addView: 'settings.permissions_view', writes: ['settings.permissions'],
    section: 'settings.permissions' },

  { id: 'settings_role_groups', label: 'Role Groups', class: 'B',
    view: null, addView: 'settings.role_groups_view', writes: ['settings.role_groups'],
    section: 'settings.role_groups' },

  { id: 'settings_roles', label: 'Designations', class: 'B',
    view: null, addView: 'settings.roles_view', writes: ['settings.roles'],
    section: 'settings.roles' },

  { id: 'settings_working_hours', label: 'Working Hours', class: 'B',
    view: null, addView: 'settings.working_hours_view', writes: ['settings.working_hours'],
    section: 'settings.working_hours' },

  { id: 'settings_recording_hours', label: 'Recording Hours', class: 'B',
    view: null, addView: 'settings.recording_hours_view', writes: ['settings.recording_hours'],
    section: 'settings.recording_hours' },

  { id: 'settings_holidays', label: 'Holidays', class: 'A',
    view: 'settings.holidays_view', writes: ['settings.holidays'],
    section: 'settings.holidays_view',
    note: 'THE EXISTING EXAMPLE this prompt generalises: a view key implied for every '
      + 'designation, a separate manage key, and the section says it is read-only unless you '
      + 'hold the second one. Left exactly as it is.' },

  { id: 'settings_timesheet_options', label: 'Time Sheet Options', class: 'B',
    view: null, addView: 'timesheet.options_view',
    writes: ['timesheet.options', 'timesheet.sub_options'],
    section: 'timesheet.options' },

  { id: 'settings_leave', label: 'Leave & Idle', class: 'B',
    view: null, addView: 'settings.leave.view', writes: ['settings.leave.manage'],
    section: 'settings.leave.manage' },

  { id: 'settings_nudges', label: 'Start-of-day nudges', class: 'B',
    view: null, addView: 'settings.nudges_view', writes: ['settings.nudges'],
    section: 'settings.nudges' },

  { id: 'settings_branding', label: 'Branding', class: 'B',
    view: null, addView: 'settings.branding_view', writes: ['settings.branding'],
    section: 'settings.branding' },

  { id: 'settings_theme', label: 'Theme', class: 'B',
    view: null, addView: 'settings.theme_view', writes: ['settings.theme'],
    section: 'settings.theme' },

  { id: 'settings_email_config', label: 'Email (mail server)', class: 'B',
    view: null, addView: 'settings.email_config_view', writes: ['settings.email_config'],
    section: 'settings.email_config',
    secrets: ['password', 'smtp_password', 'client_secret', 'refresh_token', 'encryption_key'],
    note: 'MIXED: the host, port, sender and whether a password is set are configuration; the '
      + 'password itself is never returned to anybody, view-only or Super Admin.' },

  { id: 'settings_email_delivery', label: 'Email (Gmail) delivery', class: 'B',
    view: null, addView: 'settings.email_delivery_view', writes: ['settings.email_delivery'],
    section: 'settings.email_delivery',
    secrets: ['client_secret', 'refresh_token', 'access_token'],
    note: 'MIXED: the queue, the caps and whether delivery is paused are readable; the Google '
      + 'client secret and refresh token are not.' },

  { id: 'settings_server', label: 'Server (gateway)', class: 'B',
    view: null, addView: 'settings.server.view', writes: ['settings.server.manage'],
    section: 'settings.server.manage',
    secrets: ['shared_secret', 'secret', 'keys', 'token'],
    note: 'MIXED: where the gateway is, the size and extension rules and which folders are '
      + 'shared are configuration; its two secrets are never returned. Not to be confused '
      + 'with server.view, which opens the Server TAB.' },

  { id: 'settings_integrations', label: 'Dev & QA Integration', class: 'B',
    view: null, addView: 'settings.integrations_view', writes: ['settings.integrations'],
    section: 'settings.integrations',
    secrets: ['client_secret', 'secret', 'token'],
    note: 'MIXED, and the one key in the catalogue that is deliberately not grantable through '
      + 'a group: it can issue a credential. The VIEW key is grantable; the manage key stays '
      + 'as it is.' },

  { id: 'settings_chat', label: 'Chat settings', class: 'B',
    view: null, addView: 'chat.settings_view', writes: ['chat.settings'],
    section: 'chat.settings' },

  { id: 'settings_chat_retention', label: 'Chat attachment retention', class: 'B',
    view: null, addView: 'settings.chat_retention_view', writes: ['settings.chat_retention'],
    /* NO SECTION OF ITS OWN, AND THAT IS A BUG THIS PROMPT FOUND. The retention
       panel draws inside the Chat section and gates itself with
       can('settings.chat_retention'), but SETTINGS_SECTIONS — which is what
       decides whether the Settings TAB exists at all — does not list the key.
       So a designation granted the retention key and nothing else holds a
       permission whose screen it cannot reach: exactly the bug the note above
       Working Hours in that list records, repeated. Listing it fixes it. */
    section: 'settings.chat_retention', sectionWasMissing: true },

  { id: 'settings_ip_allowlist', label: 'Allowed IP addresses', class: 'B',
    view: null, addView: 'settings.ip_allowlist_view', writes: ['settings.ip_allowlist'],
    section: 'settings.ip_allowlist' },

  { id: 'settings_ip_blocklist', label: 'Blocked IP addresses', class: 'B',
    view: null, addView: 'settings.ip_blocklist_view', writes: ['settings.ip_blocklist'],
    section: 'settings.ip_blocklist' },

  { id: 'settings_mis_access', label: 'MIS Project Access', class: 'B',
    view: null, addView: 'settings.mis_access_view', writes: ['settings.mis_access'],
    section: 'settings.mis_access' },

  { id: 'settings_reference', label: 'Reference lists', class: 'B',
    view: null, addView: 'settings.reference_view',
    writes: ['settings.asset_types', 'settings.priorities', 'settings.categories',
      'settings.project_categories', 'settings.milestone_types'],
    sections: ['settings.asset_types', 'settings.priorities', 'settings.categories',
      'settings.project_categories', 'settings.milestone_types'],
    note: 'FIVE SECTIONS, ONE READ. Scope of Work, Priorities, Asset Categories, Project '
      + 'Categories and Milestone Types are five panels over one reference table and one '
      + 'route family (/api/reference/:collection), whose read was gated by each list\'s '
      + 'MANAGE key. One view key covers reading the lists; each list keeps its own manage '
      + 'key. They are dropdown vocabularies, not data: a studio that lets somebody read one '
      + 'is not exposed by their reading another.' },

  { id: 'settings_activity_log', label: 'Activity Log', class: 'A',
    view: 'settings.activity_log', writes: [],
    section: 'settings.activity_log',
    note: 'Read-only by nature — there is nothing to write in it.' },

  /* A KEY WITH NO SCREEN. The catalogue lists settings.audit_logs and the page
     deliberately does not: no section has been built for it, and granting it
     alone should not open an empty page. Left exactly as it is — adding a view
     key for a screen that does not exist would be adding a second key nobody
     can use. */
  { id: 'settings_audit_logs', label: 'Audit logs (no screen yet)', class: 'A',
    view: 'settings.audit_logs', writes: [], section: null, noScreen: true },

  { id: 'settings_chat_activity', label: 'Chat Activity (oversight)', class: 'A',
    view: 'settings.chat_activity', writes: [], section: 'settings.chat_activity',
    note: 'Read-only, and already its own key. Covers what the studio may oversee and nothing '
      + 'more: it does not become a way to read a conversation as a member.' },

  // ------------------------------------------------------- not user-facing
  { id: 'integration_api', label: 'Dev & QA API (service credential)', class: 'A',
    view: null, writes: [], gates: [],
    note: 'A machine API behind a service credential, not a role. No view key applies.' },

  { id: 'gateway_api', label: 'Office gateway callbacks', class: 'A',
    view: null, writes: [], gates: [],
    note: 'The gateway\'s own credential. Not a role, and its config route publishes the keys '
      + 'only to the gateway itself.' },

  { id: 'mobile', label: 'Mobile builds', class: 'A',
    view: 'mobile.distribute', writes: [], gates: [], section: 'mobile.distribute' },
];

const BY_ID = new Map(AREAS.map((a) => [a.id, a]));

/* Every Settings section an area governs. Most have one; the reference lists
   have five panels over one route family. */
const sectionsOf = (area) => (area.sections || (area.section ? [area.section] : []));

/* Every view key this table names, existing or added. */
const viewKeys = () => AREAS.map((a) => a.addView || a.view).filter(Boolean);
/* The ones Prompt 61 adds, which is what the migration seeds and the defaults
   test pins. */
const addedViewKeys = () => AREAS.filter((a) => a.addView).map((a) => a.addView);
/* The write keys that must imply a given view key. */
const writesFor = (viewKey) => AREAS
  .filter((a) => (a.addView || a.view) === viewKey)
  .flatMap((a) => a.writes || []);
const areaOfView = (viewKey) => AREAS.find((a) => (a.addView || a.view) === viewKey) || null;
const areaOfWrite = (writeKey) => AREAS.find((a) => (a.writes || []).includes(writeKey)) || null;

module.exports = {
  AREAS, BY_ID, viewKeys, addedViewKeys, writesFor, areaOfView, areaOfWrite, sectionsOf,
  CLASSES: { A: 'already had a view key', B: 'write keys only', C: 'tier or nothing', D: 'self scope' },
};
