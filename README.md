# Zvky Pipeline — backend

A Node.js + MySQL backend for the Zvky Design Studio asset/animation tracker:
password login, JWTs, and the studio's real job designations as the permission
model, enforced server-side rather than in the browser.

Deploying to GoDaddy? See **[DEPLOY-GODADDY.md](DEPLOY-GODADDY.md)**.

## Roles

Every account holds one of the studio's designations. What a designation can do
is defined once, in [`src/roles.js`](src/roles.js) — the routes ask for a
capability rather than naming job titles, so adding a designation is a one-entry
change with nothing else to update.

| Group | Designations | What they can do |
|---|---|---|
| Administration | Super Admin | Everything, plus an override on any review gate |
| | Admin | Creates projects and staffs them; sees only their own projects and the users they added |
| | Production Coordinator | Works across the projects they're attached to; can deliver approved assets |
| Creative Direction | Art Director | Sees the whole studio and holds the final review gate. Cannot edit assets directly — direction goes through the review action so it's recorded as feedback |
| Supervision | Art Supervisor, Associate Animation Supervisor, Senior Team Lead, Team Lead, Associate Team Lead, Associate Art Director, Technical Manager | Run a team, hold the first review gate, create and edit assets — **and can be assigned work themselves** |
| Art | Senior Game Artist, Senior Motion Graphics Artist, Game Artist, Associate Game Artist, Trainee Game Artist | Assigned work, submit it for review |
| Animation | Senior Game Animator, Game Animator, Associate Game Animator, Trainee Game Animator | Assigned work, submit it for review |
| Design | Senior UI/UX Designer, Game Designer, Associate Game Designer, Consultant - Lead Game Designer, Associate - UI/UX Designer | Assigned work, submit it for review |
| Leadership | Managing Director & CEO, Vice President - Global Operations & Business Development | See every project; no pipeline actions. Widen an entry if one of them needs to review, deliver or administer |
| Production | Senior Producer, Producer, Creative Producer, Senior Project Manager, Project Manager, Associate Project Manager, Senior Production Coordinator | Work across the projects they're attached to; create and edit assets; sign off delivery |
| Engineering | Senior/Technical Artist, Associate Technical Artist, Senior/Unity Developer, Associate Unity Developer, Game Developer, Associate Game Developer, Test Engineer, Associate Test Engineer, Trainee - Test Engineer | Assigned work, submit it for review |
| Game Math | Game Mathematician, Associate Game Mathematician, Associate Math Analyst | Assigned work, submit it for review |
| Business & Operations | Senior Business Development Executive, Senior Operations Financial Analyst, Account Manager - Marketing, MIS Analyst, Junior Accountant | Directory only — no access to the asset pipeline |

### Who can be given a task

The Assignee dropdown — on Add Asset, on the reassign panel and on bulk assign,
all three of which read the one endpoint `GET /api/projects/:id/artists` —
offers every designation carrying the `assignable` capability. That is two
tiers: **Contributor** and **Lead / Supervisor**.

Leads were missing from it until recently, and the cause is worth recording
because the flag reads as simpler than it is: `assignable` was set on the
contributor tier and nowhere else, so nothing excluded leads — the capability
was just never given to them.

Three rules hold that together, and all three are tested:

- **A lead being assignable does not make them a contributor.** Two places read
  the flag as "sees only their own work" — `canViewAsset` and the per-project
  asset list. Both ask `isContributor()`, which is `assignable && !leadsTeam`,
  so a lead keeps their team's board and their review queue.
- **Nobody reviews their own work.** A lead has no reporting lead of their own,
  so an asset assigned to them reaches the "no lead recorded, any lead who can
  see it is the gate" fallback. `isTeamLeadOfAsset` refuses anyone as the
  reviewer of an asset assigned to themselves.
- **A reporting line is still a contributor's.** Making a lead assignable does
  not give them a `team_lead_id`; the user routes ask `isContributor()` too.

Designations that are **not** assigned work — Administration, Production,
Creative Direction, Leadership and Business & Operations — are refused by all
three assign routes, not merely hidden from the dropdown.
| People & Culture | People & Culture Partner, Assistant Manager - HR Generalist, Talent Acquisition Specialist | Directory only — no access to the asset pipeline |

Seniority (Trainee → Associate → Senior) is recorded and displayed but does not
by itself change access: a Trainee Game Artist and a Senior Game Artist have the
same permissions and differ in title and reporting line. Change that by editing
the entry in `src/roles.js`.

### Role permissions

**Settings → Role Permissions** configures what a role may do. Every user's
permissions come from their role — there are no per-user grants. Change a role,
and everyone holding it changes together.

The catalogue lives in
[`src/permission-catalog.js`](src/permission-catalog.js) — 90 permissions in
twelve groups — and the settings live in `role_permissions` as
`(role_key, permission_key, enabled)`.

Every key sits in the group its prefix names, and
`tests/role-permissions.test.js` checks that: a `settings.*` key in another
group would be the first exception. That is why the holiday calendar's two keys
are `settings.holidays_view` and `settings.holidays` rather than `holiday.view`
and `holiday.manage`.

**When a change takes effect: the next request.** The permission set is read per
request in `authenticate()` from the user's freshly-read role, so nobody signs
out and in again, and no session has to be refreshed. Moving somebody to another
role takes effect the same way.

### A gate written twice: `can()`, never `caps()`

Several controls are gated in two places — the route that performs the action, and the page
that decides whether to draw the button. When those two consult different things, the API
allows something the app never offers, and nothing fails: there is no error to see, only a
button that is not there. `public/index.html` carries a note about this appearing three
times — Settings, the Users tab, the Add Project button — "always the same way: a screen
asked `caps()` (the role's TIER) about something the API decides from the role's
PERMISSIONS. Switching a permission on does not move the tier."

The rule, and it is worth stating in one line: **if a Super Admin can switch it on in
Settings → Role Permissions, the page gates it with `can('the.same.key')`.** `caps()` is
only for what a checkbox cannot carry — `projectScope`, `reviewStage`, `deleteAsset`.

Both sides then read one source. `authenticate()` resolves
`rolePermissions.effectiveFor(db, user.role)`, puts it on `req.permissions` for
`requirePermission(...)`, and ships the same list to the browser as `user.permissions`,
which the page's `perms()` reads and re-polls every twenty seconds.

**Hold / Resume is audited and pinned.** It is gated in both places —
`requirePermission('asset.hold')` on `POST /:id/hold` and `/:id/resume`, and
`can('asset.hold')` on the page — and `tests/hold-permission.test.js` drives the permission
off and on in Settings, asserting after each change that the server's answer and the list
the page gates on move together. The page's own gate line is lifted out of
`public/index.html` and evaluated by that test, so it checks the real gate rather than a
copy of it. Mutation-tested: removing the page's check, swapping it for a `caps()` tier
read, pointing it at another key, and dropping the server's `requirePermission` are all
caught.

Two things that suite also records, because they are easy to assume otherwise:
`asset.hold` is `impliedBy: () => true`, so **every** designation holds it until a Super
Admin turns it off — there is no role that lacks it by default; and holding the key is
still not permission to hold somebody *else's* task, which the route refuses separately
(a cross-person hold would need its own permission and its own audit line).

### What the tier system still does

### Holidays: two keys, and why one of them is on for everybody

**Settings → Holidays** is the studio's closed-day calendar, and it is gated by a pair:

| Key | Label | Default |
| --- | --- | --- |
| `settings.holidays_view` | View Holidays | **On for every designation** (`impliedBy: () => true`) |
| `settings.holidays` | Manage Holidays | **Super Admin only** (`impliedBy: has('managePermissions')`) |

*View* is on for everyone because knowing which days the studio is shut is
something anybody needs to plan their own work, and withholding it would only
send them to ask somebody who can see it. It is still a key, so a Super Admin
can narrow it — the code has not decided that for them.

*Manage* goes through `managePermissions`, the same front door
`settings.recording_hours` uses, and deliberately **not** through
`manageSettings`. A row saved here is a wider change than any other Settings
list: the priorities and the branding rename a dropdown, a holiday stops the
clock for the whole studio for a day.

**The view key is not what explains a refused timer, and must not be.** The 409
from `POST /:id/start` names the holiday in its body, and the paused label the
asset panel draws comes from `describePause()` in `src/work-log.js`. Neither
consults `settings.holidays_view`, and `tests/holidays.test.js` asserts the
refusal still names the holiday from a session that has had that key revoked.
Somebody told they may not start work is owed the reason whatever else they may
see.

**Both gates read the same key the same way.** The four routes in
`src/routes/holidays.js` use `requirePermission`, *not* `requireSuperAdmin` —
which is the one difference from Recording Hours beside it, and the reason the
page can mirror the server exactly. `requireSuperAdmin` passes on the tier **or**
the key, and `can()` in the browser knows nothing about tiers, so a page written
against it would have been a fourth instance of the `caps()`-vs-`can()` bug
above. Mutation-tested: dropping the server's `requirePermission`, and swapping
the page's `canManage` for a `caps()` tier read, are both caught.

### The Time Sheet's options, and the two ends of the Time Sheet group

`timesheet.own` is **on for every designation** and is the only permission in the
application that starts that way: filling in your own hours is not a privilege
somebody grants you. `timesheet.options` is **Super Admin only**, via
`managePermissions`.

| Key | Default | What it is |
| --- | --- | --- |
| `timesheet.own` | **every designation** | Open the tab, record your own hours |
| `timesheet.team` | `manageAccess` | Read your team's weeks |
| `timesheet.all` | `fullAccess` | Read the studio's |
| `timesheet.options` | **Super Admin** | Decide what the form offers everybody |

A separate key rather than widening an existing one, because nothing about
managing the options should narrow anybody's ability to log their own time — and
the three existing keys are all about *whose week you may read*, which is a
different question from *what the form offers*. Deliberately not
`manageSettings`: a category retired here leaves every person's Add line form,
and a back-dating window set here decides whether last month can still be
corrected.

**One key for both halves of the section.** The policy numbers are
`/api/admin/settings/timesheet`; the category list goes through the ordinary
`/api/reference/timesheet-categories`. `timesheet-categories` is the one entry in
`PERMISSION_BY_PATH` that is not a `settings.*` key, so that a Super Admin
granting the section does not have to find a second switch somewhere else.

### What is actually an option on the Time Sheet

The inventory, because most of the candidates turned out not to exist:

| Option | Was | Now |
| --- | --- | --- |
| Non-project categories | a hardcoded array of five in `src/timesheets.js` | reference data, `timesheet_categories` |
| Length of a normal day (the soft cap) | `TIMESHEET_MAX_HOURS = 8` | `timesheet_settings.max_day_hours` |
| Smallest line | `MIN_LINE_HOURS = 0.25` | `min_line_hours` |
| Largest line | `MAX_LINE_HOURS = 24` | `max_line_hours` |
| Which days hours can be logged on | `isWeekend()`, fixed | `loggable_days`, default Mon–Fri |
| How far back a line may be filed | **did not exist** | `backdate_days`, default no limit |
| How far ahead | **did not exist** | `future_days`, default no limit |
| Project work vs non-project | `tl_kind` | **fixed** — it is what a line *is*, not a setting |
| Line statuses and which lock a day | `STATUSES` / `LOCKED` | **fixed** — the submission cycle keys off them by name |
| Whether a line needs approval | **removed by the studio** | **not re-added** — see the note on `timesheet.approve` |
| Work type, billable flag, entry type | **never existed** | — |

Every default is the constant it replaced, so a deployment that takes the
release and never visits Settings behaves identically. The two windows default
to `NULL`, which means no limit — which is exactly what the application did
before they existed.

**Existing lines are never re-judged.** Tightening a window refuses *new and
edited* lines outside it; nothing walks the table looking for lines that would
now be refused. A rule applied backwards would make a submitted week unopenable
and a figure already reported unexplainable.

**Two couplings worth knowing.** `max_day_hours` is read by the Working Hours
validator, which refuses a recording window too short to hold a full timesheet
day — so raising it past what the windows allow is refused *here*, where the
person changing it can read why, rather than leaving Working Hours unable to save
its own current value. And `loggable_days` is deliberately **not** wired to
`workingDays`: that one drives the Idle Report's expected hours, so coupling them
would mean widening the timesheet silently changed every utilisation figure in
the studio.

### Idle: counted in the hours, named apart from them

`idle` is a seeded `timesheet_categories` row with `is_system = 1` — renameable,
not deactivatable, not deletable, because the week's totals key off it. **The
code says `'idle'` and never `"Idle"`,** so a studio renaming it to "Bench time"
changes the dropdown and nothing else.

`kindOf()` in `src/timesheets.js` is the single classifier — `project`,
`nonProject`, `idle` — and `splitHours()` the single sum, shared by the day
total, the week total and the exports. Idle **counts toward hours logged** (the
week really was that long) and is **shown separately** beside the week total.

**There is no productive-or-billable figure for it to be excluded from, and that
is a finding rather than a decision.** Nothing outside `src/timesheets.js` and
its route reads `timesheet_entries` — the Efficiency report, the Idle Report, the
Admin Dashboard and both P&L tabs all read `work_sessions`, which is *measured*
time between Accept and Submit. The module header has said so from the start:
"Merging them would make Time Spent mean two things at once." So the consumers
changed are the day total, the week total and the week payload; the consumers
deliberately left alone are every report built on `work_sessions`, which already
reads an idle hour as idle *by its absence* — an idle hour produces no session.
`tests/timesheet-options.test.js` greps the tree for new readers of
`timesheet_entries` so that wiring a report to these hours fails there rather
than silently acquiring an Idle bug.

### Two permissions called "Mark as Delivered", and they are near opposites

This is the one pair in the catalogue most likely to be confused, so it is
written down rather than left to be worked out from the labels.

| Key | Transition | Means |
| --- | --- | --- |
| `review.deliver` (Review group) | `deliver`: `approved_for_client` → `delivered` | **The client has the work.** The end of the pipeline. |
| `outsource.deliver` (Outsourcing group) | `outsource_delivered`: `not_started` → `pending_tl_review` | **A freelancer has handed work back.** The start of a review. |

Reusing the first for the second would tell every board, the Assets List's
Active group and both "open work" queries that the client had been sent
something nobody inside the studio had reviewed. The transition table already
refuses it — `deliver` is `from: ['approved_for_client']` — and
`tests/outsource-deliver.test.js` pins that refusal against a running server
rather than leaving it as a thing somebody once checked.

**An outsourced task is in `not_started` ("Not Assigned"), and that is the only
status it can hold.** `src/outsource.js` refuses to send out a task that has an
internal assignee, and `assigned` requires one. So `from: ['not_started']` is
complete: delivering twice, or delivering a task somebody in the studio has
taken on since, is refused by the table rather than by a check somebody has to
remember.

**It lands in an existing status on purpose, and that is what kept the change
small.** `pending_tl_review` is already known to the board's columns, the Assets
List's Active group, the Admin Dashboard's Attention Required count, the status
`CHECK` constraint, and the `NOT IN ('delivered', 'approved_for_client')`
exclusions in `src/routes/idle.js` and `src/routes/projects.js`. A **new** status
would have been a new entry in every one of those, and whichever got forgotten is
where the feature would have half-migrated. The suite greps each of them.

**Who picks it up next: the team lead,** through the review gate they already
stand at. The task has no assignee — `canActAtTlGate()` guards every read of
`assignee_id`, so the project's review team can act, and on a project with no
named team any lead who can see the work can. Nobody reviews their own work
either: the delivery writes no `asset_versions` row, so `submittedCurrentVersion`
is false for everybody.

**No timer is closed, because an outsourced task has none** — verified, not
assumed. A session is only ever opened by `POST /:id/start`, which refuses
anybody who is not the assignee, and an outsourced task has no assignee by
construction.

**Delivery is no longer a field edit.** `PUT /api/outsource/assignments/:id`
refuses a move *into* `delivered` and names the action instead. It used to write
the column directly, which is the "direct status write" this feature replaces: the
act now also moves a task into somebody's queue, records a deliverer and a stamp,
and has its own permission. Only a move *into* the state is refused — a delivered
assignment stays editable, because the form sends its status back unchanged with
every save and the agreed hours may still need correcting.

**Bulk shape, lifted from `POST /assets/bulk/deliver`:** one request, one result
per row, successes kept when a sibling is refused, and an `asset_event_batches`
row recording who, when, how many were asked for and how many landed — under its
own action id, `outsource_deliver`, so the two deliveries stay countable apart.
The endpoint lives in `src/routes/assets.js` beside the other two bulk routes,
above every `/:id/...` route: Express matches in definition order, and it is also
where `contextFor`, `workflow.evaluate` and `applyTransition` live. It takes
**assignment** ids, not asset ids, because the Outsource tab's rows are
assignments and an assignment need not name an asset at all — ad hoc work moves
its own status and reports `movedAsset: false` rather than implying a transition
that did not happen.

**Two gates on the server, and both earn their place.**
`requirePermission('outsource.deliver')` answers 403 once for somebody without
the key — and is the gate the page mirrors with `can()`. The per-row
`canDeliverOutsourced()` is the *reach*: `projectScope` is per project and
middleware cannot ask it, so a lead delivering a mixed batch gets the half on
their own projects and a named refusal on the rest.

### Holidays are part of the schedule, not a check beside it

Worth knowing before adding anything that asks "is the studio open". A holiday
is a day on which the recording windows produce **no spans at all** — which is
exactly what a Sunday already is — and that is decided in one place:
`spansOn()` in [`src/working-time.js`](src/working-time.js). Six consumers then
come out right without any of them mentioning a holiday:

| Function | What a closed day makes it do |
| --- | --- |
| `isRecording` | false, so `POST /:id/start` and `/resume` are refused and both halves of the sweep no-op |
| `stopsAt` | null — there is nothing for a timer on a holiday to run until |
| `lastStoppedAt` | walks back past it, which is where `pauseOverdue` puts a running session down |
| `resumesAt` | walks **forward** past it, which is what stops the overnight resume opening a session on a closed day |
| `workingSecondsBetween` | adds nothing for it, so a session left open across one is not credited with it |
| `workableMinutesPerDay` | 0 for that day |

The last two are the ones that cost money if they are missed: `work_sessions.seconds`
is the single column behind Time Spent, the Efficiency report, the Time Sheet's
suggestions and both P&L tabs. `resumesAt` is the only one of the six that
*writes* a stamp rather than reading one, so it has a case of its own.

**It is deliberately not in `spansFromEntries`,** which is the recurring weekly
shape the Recording Hours screen draws a week from and `work-schedule` derives
`workingDays` from. A studio with one holiday next March must not lose Tuesdays
from its schedule summary.

**Dates are calendar dates in IST.** `studio_holidays.holiday_date` is a `DATE`,
the value moved around is a `'YYYY-MM-DD'` string, and the only conversion
anywhere is `istDateOf()` turning working-time's IST day number into one — so a
holiday begins at 00:00 IST and ends at 24:00 IST on every machine. The
midnight boundary is pinned at four instants (23:59 on the eve, 00:00 and 23:59
on the holiday, 00:00 the day after), and shifting `istDateOf` by the IST offset
is one of the mutants the suite kills.

**The past is read-only, and that is load-bearing rather than tidy.** The
earliest date the screen accepts is **tomorrow**, and a holiday that has begun
or passed can be neither edited nor deleted. Because holidays go into the one
funnel, a holiday dated over a day that already has work on it would change what
that work was worth — a session open since half past nine, with today declared a
holiday at two o'clock, would be put down for nought seconds and the morning
would be gone. Refusing today and earlier makes recorded time safe by
construction instead of by a rule somewhere else remembering to protect it.
Duplicate dates are refused, in `src/holidays.js` and again by a `UNIQUE` key.
There is no annual recurrence: each year is entered explicitly.

**Available-time figures were migrated with it,** because the shape this project
keeps finding is the timer blocked and the report still expecting eight hours.
`src/idle.js` takes closed days out of `workingDaysBetween`, so the Idle
Report's `expectedHours` and the Admin Dashboard's capacity panel — which is
built from the same `buildIdleReport`, by construction — both drop a holiday,
and the report says how many it dropped, as `holidaysInPeriod` beside the
working-day figure it explains. That number is deliberately **not** a caveat
sentence: `tests/team-capacity.test.js` asserts the capacity panel's caveats are
word for word the Idle Report's, and the panel covers three periods at once, so
a period-specific sentence in `caveats()` would have broken that invariant the
moment a studio declared a holiday. A holiday somebody *did* work is
counted rather than measured, the treatment a worked Saturday already gets. The
Time Sheet labels the day and **still offers the row**, which is where a holiday
parts company with a weekend: a weekend is permanent and known, a holiday is a
row an admin added, and hiding it would leave somebody unable to file hours they
really worked. The Efficiency report is deliberately untouched — it is Man Hours
over Time Spent and has no notion of available time at all.

Permissions are booleans; some things are not. `projectScope` (`all` / `owned` /
`team` / `assigned` / `own_work`), `reviewStage` (`tl` / `cd`) and `deleteAsset`
(`any` / `owned`) are **values**, and they stay on the role's tier in
[`src/role-tiers.js`](src/role-tiers.js).

So a permission says *what* may be done and the tier still decides *how much of
the studio it may be done to*. Enabling `asset.edit` for a role lets it edit the
assets its `projectScope` already reaches — not every asset in the studio.

### Migrating without changing anything

On first run each role's permissions are seeded from what its tier already
implied, so the day this went live nobody gained or lost access. A role added in
Settings later is seeded the same way on first use, rather than arriving with
nothing. **Reset to defaults** puts a role back to its tier's set.

That is also how the six full-access designations get everything: their tiers
already implied every permission, so the seed enabled every permission for them.
There is no separate hardcoded rule — they are ordinary rows now, and can be
changed on this screen like any other role.

### Safety

Two permissions **cannot be switched off** for the Super Admin role: *Manage
Role Permissions* and *Manage Roles*. They are the only way back if this screen
is misconfigured, so the API keeps them on whatever is sent. Any other change to
the Super Admin role needs `confirm: true` — the screen asks twice.

*Manage Role Permissions* cannot be switched **on** for any other role: a role
holding it could give itself every other permission, which is a door that only
opens outwards.

Enabling *Manage IP Allowlist* for any role asks for confirmation with the
lockout warning, carried on the permission itself.

*Manage IP Blocklist* is Super Admin only and stays off for every other
designation unless a Super Admin switches it on.

*Manage Email Configuration* is Super Admin only for the same reason — the
screen behind it holds a live password for another system.

Every change is written to `role_permission_audit` — who, which role, which
permission, enabled or disabled, when — readable at `GET /api/permissions/audit`.

### Full access### Full access

Six designations run the studio and hold every permission the Super Admin does,
bar one:

| Designation | Tier |
| --- | --- |
| Managing Director & CEO | `leadership` |
| Vice President – Global Operations & Business Development | `leadership` |
| Head of Production | `full_access` |
| CTO | `full_access` |
| General Manager | `full_access` |
| Account Manager - Marketing | `full_access` |

This is the tier system doing its job rather than a new mechanism: the
capabilities are defined once as `FULL_ACCESS` in
[`src/role-tiers.js`](src/role-tiers.js) and shared by all three top tiers, so
they cannot drift apart. `hasFullAccess()` in
[`src/permissions.js`](src/permissions.js) names the check that the code used to
spell out as `manageUsers && projectScope === 'all'` — which meant "Super Admin"
by coincidence, and would have quietly changed meaning the moment roles were
added at that level. **Super Admin remains a distinct role** for identity and
display; only the access tier is shared.

`leadership` and `full_access` grant identical permissions and are still
separate tiers, because [`src/reporting.js`](src/reporting.js) reads
`leadership` to mean *top of the org chart*. Merging them would give the CEO a
Reporting To field, or take it away from everyone with full access.

### The one thing they do not get

Managing the **IP allowlist** — adding or removing addresses, and switching
between monitor and enforce — is held by the Super Admin tier alone, through its
own `manageAccess` capability.

It was split out of `manageSettings` for this change. A wrong value elsewhere in
Settings misconfigures a dropdown; a wrong value here locks the whole studio out
of the application, and the way back is an environment variable on the server.
Six more people holding every other permission is a different risk from six more
people able to close the front door.

The six **can** create and promote other Super Admins, by decision. Full access
includes handing out full access.

An account at any full-access tier cannot be deleted directly — demote it first,
then remove it. That guard already existed for Super Admin and now covers the
tier rather than the one role.

### Managing roles

Roles live in the `roles` table and a Super Admin manages them under
**Settings** — add, rename, deactivate, delete. No deploy needed.

A role is not just a label: the permission checks read a capability set off it.
That set comes from the role's **tier** (`src/role-tiers.js`), so adding a role
is a matter of naming it and choosing the closest of:

| Tier | Can do |
|---|---|
| Leadership | Sees every project, takes no action in the pipeline |
| Creative Direction | Sees everything, holds the final review gate |
| Lead / Supervisor | Runs a team, holds the first review gate, creates and edits assets |
| Production | Works across attached projects, creates and edits assets, delivers |
| Contributor | Assigned work, submits it for review |
| Staff | In the directory, pipeline closed |

Super Admin and Admin are their own tiers and are marked built in: they cannot
be deleted, deactivated, retiered, or handed to a new role from the UI. That
keeps a settings screen from becoming a way to mint administrators.

Adding a designation to the list a **new** studio starts with is still a code
change — see below.

### Adding a designation to the seed

Add one entry to `DEFINITIONS` in `src/roles.js`, using whichever shape matches
what the role does:

```js
lead_technical_artist: contributor('Lead Technical Artist', ENGINEERING, 55, '#4dd8d8'),
senior_producer:       productionRole('Senior Producer', PRODUCTION, 72, '#39d98a'),
technical_manager:     lead('Technical Manager', SUPERVISION, 74, '#ffa63d'),
junior_accountant:     staffRole('Junior Accountant', BUSINESS, 25, '#8fa3c7'),
head_of_studio:        observer('Head of Studio', LEADERSHIP, 97, '#ffd23d'),
```

The API validates against it, the role dropdown and badges pick it up from
`GET /api/auth/roles`, and the permission checks apply immediately. No database
migration is needed.

### Checking a batch before adding it

Job titles arriving from a spreadsheet tend to carry near-duplicates — a stray
en dash, `Associator` for `Associate`, a trailing `- MIS`. Put the list in
`scripts/roles-to-add.txt` and run:

```bash
npm run roles:check
```

It reports which are new, which already exist (compared case-insensitively and
trimmed), and which look like near-duplicates of an existing designation or of
each other. It only reads — nothing is written — so it is safe to re-run, and
running it after editing `src/roles.js` confirms the batch landed.

## 1. Prerequisites

- Node.js 18+
- A MySQL 5.7+ / MariaDB 10.2+ database

## 2. Set up the database

Fresh install:
```bash
mysql -u root -p -e "CREATE DATABASE zvky CHARACTER SET utf8mb4"
mysql -u root -p zvky < sql/schema.sql
```

Already running the earlier six-role version with live data? The app repairs
the schema itself on startup (`src/migrate.js`): it drops the old
`CHECK (role IN (...))` constraint, which lists only the six roles that existed
then and rejects every current designation with
`ER_CHECK_CONSTRAINT_VIOLATED`. The check is idempotent and does nothing on a
current schema.

It does not rename existing rows. To map old roles onto designations, run:
```bash
mysql -u root -p zvky < sql/migration_role_designations.sql
```

## Review workflow

The pipeline is a state machine in [`src/asset-workflow.js`](src/asset-workflow.js):
one table of transitions saying what an asset may move from, to, who may move
it, and whose desk it lands on. The routes do not decide any of that — they ask
the module and apply the answer. **Anything not in the table cannot happen**,
which is what makes the pipeline checkable rather than a pile of status strings.

```
Not Assigned --assign--> Assigned --accept--> In Progress --submit--> TL Review
                                                      ^                   |
                                                      |         tl_approve|  tl_request_changes
                                                      |                   |         |
                                                      +---- TL Feedbacks <|---------+
                                                      |                   v
                                                      |               CD Review --cd_approve--> Approved for Client --deliver--> Delivered
                                                      |                   |                              ^
                                                      |    cd_request_changes (lands with the lead)      |
                                                      |                   v                              |
                                                      +-- (assignee reworks) <-- relay -- CD Feedbacks   |
                                                                                                         |
             TL Review --tl_send_to_client (needs review.tl_send_client)-------------------------------- +
```

**Approved for Client is reachable two ways.** The ordinary route runs through
the Creative Director; a team lead holding `review.tl_send_client` can skip that
gate outright with the **Send to Client** button. Same destination, so the
dashboard, the stats bar and the Delivered flow need to know nothing about it —
but a different `action` in `asset_events`, so "how often does a lead skip the
CD" stays answerable from history that has already been written.

The permission is deliberately separate from `review.tl`, and off for every role
except the full-access tier: a lead needs the standing to act at the TL gate
*and* the authority to walk around the next one. `review.approve_client` is a
third, different thing — signing off while standing *in* the CD gate.

### Status is not the same as whose desk it is on

`assets.routed_to_id` exists because status alone could not answer "who is this
with". An asset in **CD Feedbacks** sits with the *team lead* until they relay the
notes, and with the *assignee* afterwards — without the status moving. `NULL`
means a review queue that whoever holds that gate picks up.

That distinction is the whole of the relay. Treating "routed to nobody" as
"routed to anybody" let the assignee resubmit straight past the lead who was
supposed to brief them; the states that belong to the assignee by definition are
listed explicitly (`ASSIGNEE_STATUSES`) and CD Feedbacks is not one of them.

### Submissions

A submission is a **link** (required) and a **description** (optional), and
"link" is meant broadly: work does not always live behind a URL. Five shapes are
accepted, and which one it turns out to be decides how it is drawn.

| Shape | Example | Drawn as |
| --- | --- | --- |
| Web | `https://drive.example.com/shot-01`, `http://nas/shots/ep01` | **A hyperlink** — opens as it always has |
| Other schemes | `ftp://`, `ftps://`, `sftp://`, `smb://`, `file://` | A reference with a Copy button |
| Network path (UNC) | `\\fileserver\assets\project1`, or `//fileserver/assets/project1` | A reference with a Copy button |
| Windows folder | `C:\Projects\ProjectX`, `D:\Studio\Assets` | A reference with a Copy button |
| Unix / macOS folder | `/mnt/shared/assets`, `/Volumes/Studio/Assets` | A reference with a Copy button |

Links may point **inside the building**: `http://nas/shots/ep01` and
`http://192.168.1.20:8080/v3` are as valid as a public URL, because refusing a
host without a dot in it would reject the most common case in a studio — and
refusing `\\fileserver\assets\ep01` would reject the second most common.

**A path is a reference, not something this application can open.** This is the
caveat worth reading twice. The app runs on a server and is used through a
browser: it cannot read, fetch, preview or thumbnail a UNC path or a folder on
somebody's machine, and neither can a viewer who has no access to that server.
Those links are a **pointer a colleague acts on by hand**, in Explorer or Finder,
from a machine that can reach the location. Nothing about accepting them gives
the application access to anything.

That is why only `http` and `https` are drawn as hyperlinks. Everything else is
shown as plain monospaced text, labelled *Network path* or *Folder path*, with a
**Copy** button — because a hyperlink that silently does nothing for most of the
people who click it is worse than text that never claimed it would.

**Stored exactly as typed.** Nothing is normalised in either direction: a path is
not turned into a `file://` URL, and a URL is no longer rewritten through
`new URL().toString()` either. There is no normal form for `\\fileserver\assets`
that is still a path somebody can paste into Explorer, and a link that comes back
subtly different from the one that was pasted is a link somebody has to check
twice.

**Nonsense is still refused.** Empty input, bare text (`shot-01.psd`), a relative
path (`assets/ep01`, `./local`), structure with no destination (`/`, `\\`), a
drive-relative path (`C:Projects`), a line break in the middle, and
`javascript:` / `data:` URLs — a reviewer clicks these — all produce a clear
error naming what a link may look like. See
[`src/submission-link.js`](src/submission-link.js).

The same rule governs the asset's **Requirement / Reference Link**, the **Project
Link** column of the asset bulk import, and the **project review** link, so "that
is not a valid link" means one thing in this application.

**One link field deliberately did not change: the asset thumbnail.** That URL is
put into an `<img src>` and fetched by the browser, so it stays **http/https
only** — a UNC path or a local folder cannot be fetched from a web page at all,
and accepting one there would store something guaranteed to render as a broken
image. A submission link is a reference a human acts on; a thumbnail is a
resource the page loads. `tests/asset-workflow.test.js` fails if the two are ever
merged.

Every round is kept. A resubmission after changes **adds** a version; nothing is
overwritten, so the third attempt does not erase what the first one linked to.

### Two decisions worth knowing

**Where a CD-changes resubmission lands** is one environment variable:
`CD_CHANGES_REENTRY=tl` (default — the lead who relayed the request re-checks the
work) or `cd` (straight back to the Creative Director). Both are ordinary states
of the same machine, not one bolted onto the other.

**Who marks an asset Delivered** is anyone whose tier grants `deliver` — Super
Admin, Admin, Production (PM) *and* Creative Direction. It is always a manual
action, never automatic.

### The audit trail

`asset_events` is append-only and records every move: assignment, each
submission, each review decision, the relay, delivery — with the actor, the
from/to statuses, and the feedback or description. `GET /api/assets/:id/history`
stitches it together, and the asset drawer renders it.

It is ordered by an `AUTO_INCREMENT` sequence, not by `created_at`: a review
round is quicker than one second, and DATETIME ties then sort by random UUID,
which scrambled the history into nonsense.

### Final %

The share of assets in **Delivered**. It previously counted `status === 'final'`,
which is not one of the eight states, so it read **0% however much had shipped**.

### The Dashboard's Art / Animation sub-tabs

Two sub-tabs above the board, splitting the project it already shows. They use the same
`.sub-tabs` component as Pending Actions, the Assets List, Reports and the Time Sheet — the
seventh group on the page, wired the same way.

**The field is `assets.type`, and it is the only one that could carry this.** Checked
rather than assumed, because the obvious candidates all fail: `discipline` exists only as
free text on `freelancers`; `projects.category` comes from `project_categories`, which
ships **empty** on purpose; and `milestone_types` does hold exactly `{art, animation}` —
but `project_milestones` joins a type to a **project**, never to an asset, so it cannot
partition a board. Nothing in the app filtered or displayed an Art/Animation split before
this.

**So Animation is `type === 'animation'` and Art is everything else** — a decision, not a
reading. `asset_types` is editable in Settings, so a studio that adds *Rigging* or *Layout*
gets them under Art without being asked. That is the right default, and it is an inference:
the change to make if it stops being true is a discipline flag on the asset type itself,
not a longer list of strings on the page. A test pins the inference so altering it is
deliberate.

**Default: Art. Not remembered.** Art because it is five of the six seeded types, so the
landing screen is most of the project rather than a corner of it. Not remembered because
every other sub-tab group on the page resets the same way — but the reason that matters is
what a remembered lens does on a Monday: somebody who last looked at Animation returns to a
board with their Art work missing, and the only thing on screen saying so is a sub-tab they
did not choose today. A filter that hides work should be one you just set. The header's
project picker *is* remembered, because landing on **no project** is useless; landing on Art
is one click from anywhere. If the studio would rather it stuck, it is one key in
`saveContext()`.

**It grants and hides nothing.** The Dashboard tab has no permission gate and did not
acquire one — it is the only main tab with no `id` and no `display:none`, which is what
makes it everybody's landing screen. The columns are still whatever `visibleStatuses()`
returns, so a role that could not see the CD columns still cannot, under either sub-tab.

**Where the split is applied, and where it deliberately is not.** In `renderBoard()`, over
the pool `filteredAssets()` already returns — *not* inside `filteredAssets()` itself, which
the **Assets List** also reads and which would have silently halved a different tab. The
board's column counts come from the split pool, so cards and headings cannot disagree. The
sub-tab counts describe the whole pool, so each says how many rows clicking it would show.

The one aggregate that does **not** follow the lens is the stats band (`#stats` — Assets,
one tile per status, Final %). It sits *above* the tab row and is drawn on every tab but
Users, so it summarises the **project**, not the Dashboard; it already ignored the board's
search and type filter before this change, reading `state.assets` rather than
`filteredAssets()`. Making it follow a Dashboard sub-tab would make it wrong on the five
other tabs it appears on. That is pinned by a test rather than left incidental — and if the
studio would rather the band followed the lens while the Dashboard is open, that is a
deliberate change with a failing test to answer.



Assets now move through a fixed pipeline instead of a free-form status field:

```
not_started → assigned → in_progress → pending_tl_review ⇄ tl_changes_requested
                                    ↓ (TL approves)
                             pending_cd_review ⇄ cd_changes_requested
                                    ↓ (CD approves)
                             approved_for_client → delivered
```

- The **assigned artist, animator or designer** uploads a file via
  `POST /api/assets/:id/submit` (multipart, field name `file`). Where it routes
  depends on where it came from: fresh work or a lead's rework request goes to
  **pending_tl_review**; an art-director rework request skips the lead and goes
  straight back to **pending_cd_review**.
- Their **lead or supervisor** calls `POST /api/assets/:id/review` with
  `{ decision: "approved" | "changes_requested", text }` while the asset is
  `pending_tl_review`. Approving sends it to the art director;
  requesting changes sends it back to the artist with the note attached.
- The **art director** (or super admin, as an override) does the same on
  `pending_cd_review`. Approving marks it `approved_for_client`.
- Anyone who can manage the project (super admin, admin, production
  coordinator, or the art director) calls `POST /api/assets/:id/deliver` once
  it's `approved_for_client` to mark it `delivered`.

Dashboard/list drag-and-drop in the frontend only works between `not_started`,
`assigned` and `in_progress` — everything past that point has to go through the
actions above, and the API enforces this even if someone calls `PATCH` directly.

Every submission is stored as a version (`asset_versions`) and every
decision as feedback (`feedback`), so the full review history — files and
notes — stays attached to the asset. Files are served back out through
`GET /api/assets/versions/:versionId/download`, which re-checks the same
view permissions rather than being a public URL.

### File storage

Uploads land on local disk in `./uploads` (gitignored, auto-created). That's
fine for a single server. If you deploy across multiple instances or want
durability independent of the box, swap `src/upload.js`'s multer disk
storage for an S3-compatible bucket — it's the only file that needs to
change, since every route just uses `req.file` / `file_path` without caring
where it physically lives.

## 3. Bulk uploads

Two separate uploaders, one per entity. Each has its own button, its own
endpoint, its own validation and its own sample file. They share only the CSV/
Excel reader in `src/import-file.js` — no single parser inspects a file and
guesses which entity it holds, so the asset sample uploaded to the user
uploader is rejected by name rather than half-processed.

| | Bulk Upload Assets | Bulk Upload Users |
|---|---|---|
| Where | Dashboard toolbar | Users tab |
| Endpoint | `POST /api/assets/project/:projectId/bulk` | `POST /api/users/bulk` |
| Sample | `GET /api/assets/import-template.csv` | `GET /api/users/import-template.csv` |
| Who | anyone who can create assets | anyone who can manage users |
| Columns | `src/asset-import.js` | `src/user-import.js` |

Both report failures the same way — `{ row, column, value, message }` per bad
row, `207` when some rows were skipped and `201` when none were — so the
browser renders either in the same table.

### Bulk-uploading users

Required: `name`, `email`, `role`. Optional: `reports_to_email`, `project`,
`password`.

| Column | Notes |
|---|---|
| `name` | Full name |
| `email` | What they sign in with. Must be unique, in the file and against existing accounts |
| `role` | A role key from Settings (`game_artist`), or its label (`Game Artist`) |
| `reports_to_email` | For roles that are assigned work: the lead they report to. That account must actually run a team |
| `project` | For leads and production roles: a project name you can see, which they are attached to |
| `password` | Blank issues the temporary default, which they replace on first sign-in. A value here must meet the password policy |

The form takes ids for the lead and the project; a spreadsheet cannot know an
id, so the file takes an email and a project name and the endpoint resolves
them. An admin cannot create an account more powerful than their own, in bulk
any more than one at a time.

Rows with no password all receive the same temporary one, so it is hashed once
rather than once per row — bcrypt is deliberately slow, and the difference on a
large file is a second against several minutes.

## 3.1 Bulk-importing assets

Once a project exists, anyone whose designation can create assets in it (super
admin, admin, any lead or supervisor, production coordinator) can import a CSV
**or Excel (.xls/.xlsx)** file instead of adding assets one at a time:

```
POST /api/assets/project/:projectId/bulk
Content-Type: multipart/form-data
file: <your.csv | your.xlsx>
```

**Start from the sample.** The Sample format button beside Import downloads a
CSV with the correct headers and three example rows, generated by
`GET /api/assets/import-template.csv` from the same column definitions the
importer validates against — so it cannot describe a format that would then be
rejected. Uploading it unchanged is one of the tests.

Expected columns (`name` and `type` are required, everything else optional).
For Excel files, these are just the header row of the first sheet:

| Column | Notes |
|---|---|
| `name` | Asset name |
| `type` | One of `character, prop, environment, fx, animation, background` |
| `priority` | `low`, `med`, or `high` — defaults to `med` |
| `assignee_email` | Must match the email of someone whose designation can be assigned work, or the row is left unassigned with a warning |
| `man_hours` | Estimated hours, numeric |
| `deadline` | `YYYY-MM-DD` (or an Excel date cell — read correctly either way) |
| `description` | Free text |

### What happens to a bad file

Nothing in a bad file can take the server down, and one bad row never costs
you the rest of the file.

The file is checked before it is parsed — extension, not empty, within the size
limit — then its header row is checked, then the row count against
`IMPORT_MAX_ROWS` (5000 by default). Any of those fails with a `400` naming the
problem: which columns are missing, what was found instead, and what was
expected.

Past that, every row is validated before anything is written, so an error on the
last row is reported the same way as one on the first. A row that fails is
skipped and reported as `{ row, column, value, message }`; the rest still
import. The response is `201` when the whole file went in and `207` when some
rows were skipped, carrying `created`, `skipped`, `totalRows` and `errors`. The
browser renders that as a table of row number, column, value and problem.

Rows are inserted in batches rather than one round trip each, and the loop
yields between batches, so a large import does not hold the event loop and the
server keeps answering other requests throughout. If a batch fails as a unit it
is retried row by row, so a database error is attributed to the rows that caused
it instead of failing the batch.

Duplicates are skipped rather than created twice: within the file, and against
assets already in the project, matched on name and type. Re-uploading the same
file imports nothing and tells you why.

## Artist submission file formats

`POST /api/assets/:id/submit` only accepts the studio's actual working
formats — anything else is rejected before it touches disk:

- Images: `.psd .jpg .jpeg .png .gif .tiff .tif`
- Spine rigging exports: `.json .atlas .skel`
- After Effects: `.aep .aet`

Add or remove extensions in `src/upload.js` (`REVIEW_EXTENSIONS`) as your
pipeline changes — nothing else needs to know about the list.

## 4. Configure environment variables

On a host, set these as the application's **environment variables** (cPanel →
Setup Node.js App → Environment variables); no `.env` file is used there. For local
development you may instead copy `.env.example` to `.env` (it is git-ignored and must
never be committed):

```bash
cp .env.example .env
```

Set:
- `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` — your MySQL
  connection (or a single `DATABASE_URL` instead)
- `JWT_SECRET` — a long random string (`node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`)
- `CORS_ORIGIN` — the URL your frontend will be served from
- `TRUST_PROXY` — number of reverse proxies in front of the app (`1` behind
  cPanel/Passenger, so the login rate limit sees real client addresses)
- `LOGIN_RATE_MAX` — sign-in attempts allowed per address per window. A whole
  office shares one public IP, so this counts the studio together
- `EMAIL_ENCRYPTION_KEY` — a long random string, used to encrypt the SMTP
  password in the database. Falls back to `JWT_SECRET`, but set it separately:
  rotating `JWT_SECRET` would otherwise make the stored mail password
  unreadable. See [Email notifications](#email-notifications)
- `EMAIL_BATCH_MS` — optional; how long assignment emails wait so a bulk assign
  becomes one message rather than forty. Default 1500
- `IP_ALLOWLIST_*` — optional; restricts the app to specific addresses. Read
  [Restricting access by IP address](#restricting-access-by-ip-address) before
  enabling it, and deploy in monitor mode first
- `APNS_*` and `FCM_*` — optional; the push notification keys. Without them push
  is off and nothing else changes. `mobile/README.md` §3 has where each value
  comes from
- `MOBILE_DIST_BASE` — the public `https://` origin, exactly as the team reaches
  it. Required once the iOS app is being handed out: the install manifest names
  the `.ipa` by absolute URL and is fetched by a system daemon, so a guessed
  origin fails silently
- `MOBILE_DIST_TOKEN` — optional; fixes the unguessable path the builds are
  served from. Set it to rotate the install link, or to keep it identical across
  two servers. Generated and persisted to `dist-mobile/.dist-token` otherwise
- `MOBILE_DIST_DIR` — optional; where the built `.apk`, `.ipa` and manifest live.
  Defaults to `dist-mobile/` beside the application

## 5. Install and seed

```bash
npm install
npm run seed
```

The seed script creates:
- 1 super admin — `ava@zvky.studio` / `superadmin`
- 3 art directors, 15 admins, 40 leads spread across the five supervisory
  designations, 44 production coordinators, and 400 contributors spread across
  the twelve artist/animator/designer designations — all
  `<their email>` / `zvky2026`
- 4 sample projects with assets at every stage of the review pipeline (including a couple already sitting in TL/CD review or kicked back with changes requested, so you can see the workflow immediately)

It refuses to run again once the `users` table has data, so it's safe against
accidental double-seeding. To start over, drop and recreate the schema.

**Change the demo passwords before this touches anything real.** They're
deliberately simple for testing the permission model, not for production use.

`zvky2026` is also the standing value used in two live paths: the password a new
account is created with, and the one a Super Admin's **Reset password** sets an
existing account back to. Both lock the account until it chooses a new one, so
the value cannot be used to work — but it can be used to make that change, which
means anybody who knows it and somebody's email could take over a just-created or
just-reset account before its owner signs in. Set `DEFAULT_USER_PASSWORD` in
the deployment's environment variables so the value on your deployment is not the one printed here.

## 6. Run it

```bash
npm start          # production
npm run dev         # auto-restart on change (needs the dev dependency: npm install)
```

The API is served at `http://localhost:4000/api/*`, and the bundled frontend
(`public/index.html`) at `http://localhost:4000/`.

### Working hours, and the three break windows

**Settings → Working Hours** holds the studio's day: hours in a working day,
which days those are, when the day starts and ends, and three break windows —
**Morning break**, **Lunch** and **Evening break**. Each is a start and an end,
and each may be left empty, which means "no such break" rather than an
unfinished form.

Lunch was already stored; the other two are new, and all three now do something
they did not do before.

**Break time does not count as worked time.** A span is a stretch during which
work sat on somebody's desk — it is not a claim they were at it. Leave a timer
running through lunch and, before this change, that hour counted as engaged:
overstating what was worked and understating idle time in the same breath. The
Idle Report and Team Capacity now subtract any part of a break that a tracked
span actually covers.

Only where the span covers it. Subtracting a flat hour a day would take time off
somebody who was not working then anyway.

**It comes off tracked hours and never off expected hours.** `hoursPerDay` is
what the studio *declares* a full day to be — eight hours out of a 09:30–19:00
window that already has lunch in it. Taking the breaks off that as well would
count them twice and quietly raise everybody's idle time.

Worked through: a timer running 09:30–18:30 is nine hours. With no breaks
configured it reads as eight, the standard day's cap. With a 15-minute morning
break, an hour of lunch and a 15-minute evening break inside it, 90 minutes come
off and it reads **7.5 engaged, 0.5 idle**.

> **This changes what your existing reports say.** Anybody whose tracked spans
> ran through lunch will show fewer engaged hours and more idle hours than they
> did before. That is the point of the feature, but it is a real shift in the
> numbers rather than a new column, so expect the Idle Report to read
> differently the first time you open it.

What is refused: a break that ends before it starts, half of one, a break
outside the working day, **two breaks that overlap** (the same minute would come
off twice), and a set of breaks so long the day can no longer hold the hours the
Time Sheet accepts. Every change is in the Activity Log with the full before and
after — *"Lunch 13:00–14:00" → "Morning break 11:00–11:15, Lunch 13:00–14:00"*.

**These are studio-wide.** There is no per-user or per-team schedule anywhere in
this application — `work_schedule` is a single row — so there was no override
mechanism to extend. A timesheet line is a number of hours typed by hand and is
not checked against these times; they apply to tracked hours.

### After a deploy, restart the application

`public/index.html` is a static file, so a browser refresh picks up new frontend
code **immediately**. The API is the running Node process, and on cPanel or
Passenger it keeps serving the old code until it is restarted. Upload files
without restarting and you get a browser running new code against an old server.

That combination used to fail confusingly rather than loudly, and it is worth
knowing why. Any GET that matches no API route falls through to the catch-all
that serves `index.html` — **with status 200**. So a new screen calling an
endpoint the old server does not have got a successful response whose body was a
web page, and the page read it as an empty result: lists rendered **empty**,
looking like a working screen with no data, while the matching POST — which the
catch-all does not answer — failed with a bare `HTTP 404`. A new feature
therefore looked broken rather than undeployed.

The page now detects this: a 2xx whose body is not JSON is reported as *"the
server answered with a web page instead of data … the Node application was not
restarted"*. **If you see that message anywhere in the app, restart the
application and reload — nothing is wrong with the data.** In cPanel that is
Setup Node.js App → Restart, or touching `tmp/restart.txt`.

## API surface

| Method | Path | Who |
|---|---|---|
| POST | `/api/auth/login` | anyone |
| GET | `/api/auth/me` | any logged-in user |
| GET | `/api/auth/roles` | any logged-in user — the role catalogue |
| GET | `/api/auth/password-policy` | anyone — the password rules the API enforces |
| POST | `/api/auth/password` | any logged-in user — change your own password |
| GET | `/api/reference` | any logged-in user — every value list a form needs, in one call |
| GET | `/api/reference/:collection` | any logged-in user — `asset-types`, `priorities` or `roles` |
| GET | `/api/reference/:collection/:key/usage` | Super Admin — how many records hold this value |
| POST | `/api/users/bulk` | anyone who can manage users — CSV/Excel user import |
| GET | `/api/users/import-template.csv` | anyone who can manage users — the user sample file |
| GET | `/api/users/import-format` | anyone who can manage users — the user columns |
| POST | `/api/reference/:collection` | Super Admin |
| PATCH | `/api/reference/:collection/:key` | Super Admin — rename, recolour, activate or deactivate |
| DELETE | `/api/reference/:collection/:key` | Super Admin — refused while the value is in use |
| POST | `/api/auth/bootstrap` | first run only — creates the first super admin while the database is empty, using the token printed to the startup log (or `BOOTSTRAP_TOKEN`) |
| GET | `/api/projects` | scoped per role automatically |
| POST | `/api/projects` | any role that can create projects |
| DELETE | `/api/projects/:id` | a studio-wide role, or the owner |
| GET | `/api/projects/:id/artists` | anyone with access to the project |
| GET | `/api/assets/project/:projectId` | scoped per role |
| POST | `/api/assets/project/:projectId` | any role that can create assets |
| POST | `/api/assets/project/:projectId/bulk` | any role that can create assets — CSV import |
| PATCH | `/api/assets/:id` | whoever can edit that asset (status limited to not_started ⇄ assigned ⇄ in_progress) |
| DELETE | `/api/assets/:id` | super_admin, or admin who owns the project |
| POST | `/api/assets/:id/submit` | the assigned contributor — uploads a file, advances to the right review stage |
| POST | `/api/assets/:id/review` | their lead/supervisor (TL stage) or art_director/super_admin (CD stage) |
| POST | `/api/assets/:id/deliver` | any role that can deliver — once approved_for_client |
| GET | `/api/assets/versions/:versionId/download` | whoever can view the asset |
| POST | `/api/assets/:id/tasks` | whoever can edit that asset |
| PATCH | `/api/assets/tasks/:id` | whoever can edit the parent asset |
| POST | `/api/assets/:id/notes` | whoever can view that asset |
| GET | `/api/users` | super_admin (all), admin (users they added). `status=active` (default), `inactive` or `all` |
| POST | `/api/users` | super_admin (any designation), admin (anything that neither manages users nor sees the whole studio) |
| PATCH | `/api/users/:id` | change someone's designation or reporting line, same scoping as above |
| DELETE | `/api/users/:id` | super_admin (anyone but another super admin), admin (only users they added) |
| GET | `/api/team` | any designation that runs a team — their reports' progress |
| GET | `/api/users/:id/deactivation-impact` | `user.deactivate` — what deactivating would move, changing nothing |
| POST | `/api/users/:id/deactivate` | `user.deactivate` — never yourself, never a full-access account |
| POST | `/api/users/:id/reactivate` | `user.deactivate` — restores the account, not the work |
| GET | `/api/pnl/rate-cards` | either tab permission, or `pnl.manage` — the studio's price list |
| GET | `/api/pnl/role-rates` | either tab permission, or `pnl.manage` — every designation's hourly rate in ₹, unpriced ones included |
| PUT | `/api/pnl/role-rates/:roleKey` | `pnl.manage` — set a designation's rate, or clear it to mark it unpriced |
| POST, PATCH, DELETE | `/api/pnl/rate-cards[/:id]` | `pnl.manage` alone |
| GET | `/api/pnl/projects/:id` | either tab permission — one project's figures and hours, scoped like every other project read (404 outside scope) |
| PUT | `/api/pnl/projects/:id/total-cost` | `pnl.actual` — the Actual tab's entered Total Cost; `null` clears it |
| POST, PATCH, DELETE | `/api/pnl/projects/:id/assignments[/:assignmentId]` | `pnl.manage` alone |
| PUT | `/api/pnl/projects/:id/billing` | `pnl.manage` alone — contract value, billing type, invoiced to date |
| POST, PATCH, DELETE | `/api/pnl/projects/:id/other-costs[/:costId]` | `pnl.manage` alone |
| GET | `/api/pnl/report` | either tab permission — summary, breakdown, hours rollup, trend and client rollup, filterable by `clientId`, `projectId`, `from`, `to` |
| GET, POST, PUT | `/api/integration/v1/*` | not a person at all — a signed request from an active integration credential that lists the action. See [The integration API](#the-integration-api) |

Every route re-checks permissions against the database on each request — a
role change or removal takes effect on the user's very next request, not just
after their token expires.

## Settings is an accordion

The page had grown to roughly ten thousand pixels of continuous scroll, and the
**On this page** list at the top named the sections without going to them —
a table of contents you could not use.

Every section is now collapsible and **collapsed by default**, which takes the
page from about 10,700px to about 1,200px. Each entry in *On this page* is the
trigger for its section: clicking it expands that section and scrolls to it.
**Expand all** and **Collapse all** sit under the list. A section can also be
opened by clicking its own heading.

Two implementation notes worth knowing if you touch this:

* It is a **pass over the DOM, not a rewrite of fifteen sections**. Every
  section already had the same shape — a `.ref-section` whose first child is a
  `.ref-head` containing its `<h3>` — so collapsing is applied uniformly from
  outside and none of the fifteen render functions knows it is inside an
  accordion.
* A `MutationObserver` re-applies the state, because several sections repaint
  themselves independently (the rate card after a save, the IP lists after an
  add, the activity log after a filter) and each replaces its own container's
  contents. Hooking every repaint site instead would work until somebody adds
  the sixteenth section and forgets.

`SETTINGS_SECTIONS` gained a `heading` field, because an index label is not
always the section's heading — *IP Allowlist* in the list is headed *Allowed IP
Addresses* on the page. Matching on that field rather than on text means a
heading can be reworded without silently detaching its index entry.

**Working Hours was missing from that list entirely** — a bug rather than an
omission, since `canOpenSettings()` is built from it: a designation granted
Working Hours and nothing else held a permission whose screen it could not
reach, because the Settings tab was not there to open. It is in the list now.

**Holidays is the one section everybody reaches.** `settings.holidays_view` is
implied for every designation, and `canOpenSettings()` is built from
`SETTINGS_SECTIONS` — so adding Holidays to that list puts the **Settings tab
in front of every user**, with the closed-day calendar on it and nothing else.
That is intended, and it is why the section's note says *read-only unless you
manage holidays*: somebody arriving at Settings for the first time because of
this entry should see at once that reading the calendar is all they can do
there.

## Settings: the value lists behind the dropdowns

Asset types, priorities and roles used to be arrays in the source and CHECK
constraints in the schema, so the studio needed a deploy to add a type. They are
now rows in `asset_types`, `priorities` and `roles`, managed under **Settings**
by anyone whose tier grants `manageSettings` — Super Admin, and only Super Admin.

Reading is open to everyone signed in, because every Add Asset and Add User form
needs the lists to render. Writing is gated by the same capability lookup used
everywhere else, on the API rather than only in the UI: hiding the tab is a
convenience, and the tests call the endpoints directly as an Admin, a lead and a
contributor to prove it.

### Active and inactive

Settings is a management view and lists **everything in the table**, with
retired values greyed out and marked `inactive` so they can be reactivated. The
dropdowns on the forms offer **only active values**. The section heading states
both counts ("60 active · 1 inactive") so the two never have to be guessed at.

Deleting is refused while a value is in use; deactivating is the way to retire
one without disturbing the records that already hold it.

### How values behave

- **Keys never change.** A value is stored by a key generated once from its
  first name. Renaming *Prop* to *Props & Set Dressing* changes what people see
  and leaves every asset holding `prop` untouched.
- **Deleting is only allowed when nothing uses the value.** Otherwise the API
  answers 409 with the count and points at deactivating; Settings asks first, so
  the choice is informed rather than a refusal after the fact.
- **Deactivating** removes a value from the dropdowns while every record already
  holding it keeps rendering and working. This is the route for retiring
  something, and the reason nothing is ever deleted out from under a record.
- **Built-in values** — the Super Admin and Admin roles — are protected from
  deletion, deactivation and retiering.

### Where the lists are read from

Settings and every dropdown are served from the database, not from a snapshot
of it. The API reloads before answering a read, and concurrent callers share one
load, so the three requests the Settings page makes cost a single round trip.

This matters because the same values are also held in a per-process in-memory
mirror, which the permission checks read: those run on every request and are not
async, so they cannot wait on a query. The mirror is refreshed on reads, after
writes, and on a timer (`REFERENCE_REFRESH_SECONDS`, default 30, `0` disables).

The timer is not decoration. Without it a worker that nobody happens to ask for
reference data keeps a stale catalogue, and **refuses every request from anyone
holding a role added since it started** — signed in, then `403` on everything,
depending on which worker took the request. `authenticate()` now reloads once
before deciding a role is unknown, so a miss heals itself instead of locking
somebody out.

If you run more than one Node worker against one database — Passenger and most
cPanel setups do — each worker has its own mirror. That is what these refreshes
are for: without them two workers serve two different lists indefinitely.

### What is deliberately not managed here

Asset **status**, the **review stage** (`tl` / `cd`) and a review **decision**
are not reference data. They are the states of a fixed pipeline whose
transitions are wired to actions — submit, review, deliver. A status added
through a form would be a state nothing could enter or leave, so `status` keeps
its CHECK constraint while `type` and `priority` lost theirs. Making the pipeline
configurable means building a workflow engine, which is a separate piece of work.

Upload extensions are also fixed, on purpose: that list is a security control,
not a preference.

### Collations, and why there is no cross-table string join

`users.role` and `roles.key` were on different collations in production, because
the two tables were created by different MySQL versions — `DEFAULT CHARSET=utf8mb4`
with no `COLLATE` takes the *server's* default, which is `utf8mb4_0900_ai_ci` on
MySQL 8 and `utf8mb4_general_ci` on MySQL 5.7 and MariaDB. Comparing them in SQL
fails the whole statement:

```
Illegal mix of collations (utf8mb4_0900_ai_ci,IMPLICIT)
and (utf8mb4_unicode_ci,IMPLICIT) for operation '='
```

That took the migration down mid-way and left later steps unapplied. So the
orphan-role check is two queries and a set difference in JavaScript rather than
a `LEFT JOIN`, and [`src/db-collation.js`](src/db-collation.js) creates new
tables with the collation `users` already carries instead of the server default.

The second part is defence in depth for new installs; it cannot retro-fix a
database whose columns already disagree. Not comparing string columns across
tables in SQL is what actually makes this safe.

### Migrating an existing database

`src/migrate.js` creates the three tables on startup if they are missing, fills
them from the values the app previously held in code, and drops the `type` and
`priority` CHECK constraints that would otherwise reject anything new.

Each repair is applied **independently**. They used to share one `try`/`catch`,
which meant the first failure skipped every step after it and said so in a
single line that was easy to miss. That is how a deployment ended up without the
IP allowlist tables: an unrelated step above them failed, they were never
created, and the only symptom was a generic database error on one screen. A step
that cannot be applied is now named on its own, the rest still run, and startup
ends with a count of what did not apply. Any role
an account holds that the table does not know about is carried across under an
*Unsorted* group with no pipeline access, rather than leaving that account unable
to sign in. All of it is idempotent.

## "Level 1 Reporting" and "Level 2 Reporting" — and what still reads them

Edit User has **two independent person selectors**. Both list every account
except the person themselves, both are optional, and both are informational.

**Level 1 Reporting IS the original Reporting To field, relabelled.** Same
column, `users.reports_to_id` — so every value a studio had already recorded is
exactly where Level 1 expects it, nothing was copied, and nothing could be
half-copied. The places that read that column (listed below) go on reading it
unchanged. A rename-and-copy would have risked all of them to achieve nothing.

**Level 2 Reporting is a new column**, `users.reports_to_l2_id`, blank on every
existing account until somebody sets one. **Nothing reads it.**

The two are independent in both directions: either can point at a different
person, either can be blank, and changing one never moves the other. Two rules
Level 1 has that Level 2 deliberately does not:

| Rule | Level 1 | Level 2 | Why |
| --- | --- | --- | --- |
| Cannot be yourself | yes | yes | Nonsense either way |
| Must be a real account | yes | yes | Same |
| No reporting loop | **yes** | no | Nothing walks the Level 2 column, so there is no traversal for a loop to hang on |
| Top of the hierarchy has none | **yes** | no | That rule is about the real chain; the second line is an independent note, and a Managing Director may perfectly well have one |

Promotion to the top clears Level 1 — it is a fact about the chain — and
deliberately **leaves Level 2 alone**, so a promotion never deletes a note
nobody asked to delete.

Both are shown wherever the single field used to be: the Users list has two
columns, and the user detail view two rows.

## What still reads Level 1 Reporting

Reporting To on the Edit User screen records who somebody reports to. The
studio's decision is that it is **informational**: no approval routing,
notifications, permission inheritance, task escalation or access control should
depend on it.

**The dropdown lists every other account.** Not filtered by role, designation,
tier or who leads whom. The only account left out is the person being edited —
nobody reports to themselves, and the API refuses it too.

Two kinds of row are **marked rather than removed**:

| Marker | Meaning |
| --- | --- |
| `(Inactive)` | A deactivated account, still offered. Dropping them would be worse than it sounds: editing somebody whose recorded manager has since been deactivated would find no matching option, fall back to *not set*, and **silently clear a reporting line nobody touched** on the next save. Keeping them is what makes the form non-destructive. |
| `(would loop)` | Choosing them would make the hierarchy circular. Still listed, because the studio asked for every account; still refused on save, because a cycle is not a hierarchy. Marked so nobody picks an option that can only come back rejected. |

One account type still gets no dropdown at all: a designation at the top of the
hierarchy does not report to anyone, and promoting somebody into one clears
their line. That rule predates this change and is untouched.

### Two places DO read it today — flagged, not changed

The intent above is not yet true of the code, and these are left working exactly
as they are rather than quietly rewired:

| Where | What it does |
| --- | --- |
| `src/routes/timesheets.js` — `mayRead` and `readableUserIds` | **Access control.** "Your team" is resolved as `reports_to_id = you OR team_lead_id = you`, so setting this field decides whose timesheet a holder of *View Team Timesheets* may open, and who appears in their picker and approval queue. Demonstrated: the same request returns **403 before** the line is set and **200 after**. |
| `src/permissions.js` — `isTeamLeadOfAsset` | **A review-gate fallback.** When an assignee has *no* lead recorded at all — neither `reports_to_id` nor `team_lead_id` — any lead who can see the work may act as the TL review gate, so that submitted work does not get stuck with nobody able to approve it. Setting Reporting To removes that fallback for that person. |

Both are pinned by a test that documents the contradiction on purpose, so making
the field genuinely informational later is a deliberate act that fails the test
and forces the decision, rather than a behaviour that drifts unnoticed.

**What does not read it**, checked in the same audit: project and asset
visibility, the Dashboard and Assets List, notification recipients, task
assignment defaults, the Admin Dashboard, Team Capacity, the Idle Report, and
the *My Team* tab and the ordinary TL review gate — those two use
**`team_lead_id`**, which is a different field set elsewhere. Changing Reporting
To raised no notification and moved no project or asset access in testing.

## Deactivating an account

Somebody leaves. Deleting them destroys the record of what they did; leaving
them active leaves their work sitting on a desk nobody is at. **Deactivate** is
the third thing: the account stops working, everything it did stays.

**Nothing is deleted.** Not a timesheet line, not a work session, not an
activity log entry, not a delivered asset. The only rows deactivation touches
are the ones whose *meaning* changes when somebody stops coming in.

| What | What happens |
| --- | --- |
| Signing in | Refused, with a message saying the account is deactivated — not "wrong password", so they know to ask an administrator rather than keep retyping. |
| A session already open | Ends on their next request. Checking only at sign-in would leave a suspended account usable for as long as a tab stayed open, which is the window somebody is deactivated to close. |
| Unfinished work assigned to them | Returned to **Not Assigned**, so it shows up for reassignment. Covers *assigned*, *in progress* and both *changes requested* states — the ones where the studio is waiting on that person. |
| Finished work | **Stays attributed to them.** Delivered, approved, with a reviewer or with the client is a record of who did it; reassigning it would rewrite that record. |
| People who report to them | **Reported, not changed.** See below. |

### Direct reports are named, not rehomed

The confirmation lists everybody whose Reporting To points at this person —
*"2 users report to this person. Reassign the reporting manager before or after
deactivating"* — and then does nothing about it.

That is deliberate. Choosing somebody's new manager is a decision about their
team, and this screen has no basis on which to make it. Silently moving them to
the deactivated person's own manager would look tidy and would quietly
restructure the studio.

### The confirmation says what will happen before it happens

It is a dialog rather than a yes/no prompt because what deactivation does
depends on what the person is holding at that moment. It fetches and lists the
unfinished tasks about to change hands — by code and status, not just a count —
alongside what is being kept. "3 tasks will be unassigned" on its own reads as
though the rest were being thrown away.

### Reactivating does not give the work back

The account comes back; the work does not. Those tasks were unassigned and
somebody else may be doing them by now, and taking live work off them would be
worse than leaving it. The studio reassigns what it wants to reassign.

### The Users list

Active accounts by default — the roster is who works here. **Active / Inactive /
All** switches the view, each carrying its count, and the footer says how many
deactivated accounts are not shown, so "we have 12 staff" cannot quietly go
wrong the first time somebody leaves. A deactivated row is dimmed and carries an
**Inactive** badge whose tooltip names who deactivated it and when.

### The permission, and two things it will not let you do

*Deactivate Users* (`user.deactivate`) is **on by default for Super Admin only**
and grantable to any designation in Settings → Role Permissions. Without it the
Deactivate and Reactivate actions are not rendered at all, and all three
endpoints refuse.

Two refusals are built in whatever the permission says:

* **You cannot deactivate yourself.** You would be signed out on the next
  request, and if you were the last person who could turn accounts back on,
  nobody could undo it from inside the application.
* **You cannot deactivate an account with full studio access.** Change the
  designation first — the same rule that already governs removal, and what stops
  one full-access account locking out another.

Deactivation and reactivation are both in the Activity Log, with how many tasks
moved and how many people were left reporting to the account.

## The reporting hierarchy, and a user's project

**Edit** on any row of the Users screen opens Role, Project and Reporting To.
Clicking a name opens the read-only detail view, which shows the same three.

### Three columns that all look like "manager"

`users` carries three self-references and only one of them is the org chart:

| Column | Means | Set by |
| --- | --- | --- |
| `manager_id` | Who *created* the account. Gates who may edit or remove them ("you can only change users you added"). | Account creation |
| `team_lead_id` | Who reviews a contributor's assets. Drives team-scoped permissions. | Add/Edit User |
| `reports_to_id` | **The org chart.** | Edit User |

Reporting is its own column precisely because the other two carry permission
meaning. Moving somebody in the hierarchy must not change what anyone can see or
do, and repurposing `manager_id` would have meant that editing a reporting line
silently transferred — or destroyed — an administrator's right to manage that
person.

### Top of the hierarchy

Roles in the **Leadership** tier report to nobody. The field is *absent* for
them, not disabled or blank: a greyed-out control still says "there is a value
here you have not chosen". The detail view shows *Top of hierarchy*, and the API
refuses a reporting line for them whatever the form sends.

That tier currently holds exactly the two designations this was written for —
Managing Director & CEO, and Vice President, Global Operations & Business
Development. Reading it from the tier rather than from two hardcoded keys means
renaming one in Settings cannot quietly hand the person running the studio a
Reporting To field.

Changing someone's role to a Leadership one **clears** their existing reporting
line, in the database, without the form having to send anything.

### Loops

One walk answers all three rules — you cannot report to yourself, to someone who
reports to you, or around a longer circle: walking up from the proposed manager
must not reach the person being edited. Depth-bounded, so data that is already
circular stops the walk instead of hanging it. Refusals name the path
("`Sam Iyer already reports to Rohit Nair through Priya Menon`") rather than just
saying no. `GET /api/users/:id/manager-options` pre-filters the dropdown to the
same rule, so the form cannot offer a choice the API would refuse — the server
checks again regardless.

**Reporting To is optional.** An edit is never blocked because the right manager
does not exist yet, and nobody has to invent a reporting line to save an
unrelated change. Unset shows as *Not set*, which is distinct from *Top of
hierarchy*.

### A user's project

Membership is stored per role, matching how the permission checks already read
it: `project_coordinators` for `projectScope: 'assigned'`, `project_team_leads`
for `leadsTeam`, and `project_members` for everyone else. That third table is
new — contributors, most of the studio, previously had no link to a project at
all, so an artist could not be assigned to one.

Setting a project clears the other two tables, so a designation change *moves*
the membership rather than leaving a stale row that the permission checks would
still honour. Changing only the role moves it automatically.

## The Admin Dashboard

A second tab called **Admin Dashboard**, beside the per-project **Dashboard**.
Two screens, two questions: that one asks what is on *this* project, this one
asks what is going on across all of them, without picking a project first.

It is **read-only**. There is not one control on it that changes anything —
every figure is a link into the tab that already owns that work. The API behind
it has a single verb.

### What the four cards mean

`projects` carries no status column — only `is_active`, `archived_at`,
`closed_at`, `start_date` and `end_date` — so all four are **derived**, and
nothing in this application had a notion of "late" before this screen. The
thresholds below are therefore new, and stated on the screen itself:

| Card | Derivation |
| --- | --- |
| **Active** | Not archived, not closed. |
| **On Track** | Active, and neither of the two below. |
| **At Risk** | Active with unfinished work due inside **7 days**, *plus* the overdue ones — "flagged behind or at risk" is one question. |
| **Delivered** | Closed with the client (the studio's own *Mark Client Closed*). |
| *Overdue* | Not a card. Active and past its end date, or holding unfinished work already past its due date. Shown in Attention Required. |

**Active always equals On Track plus At Risk**, because every project lands in
exactly one bucket. That arithmetic is asserted in the tests — two cards that
disagree would give no way to tell which one was lying.

A **delivered** asset stops counting as late, which is what lets the studio get
back to zero. `AT_RISK_DAYS` is one constant in `src/admin-dashboard.js`.

### The panels

- **Production Pipeline** — one bar per stage of the real asset workflow (Not
  Assigned through Delivered), counted over *open* projects only. A closed
  project's assets are all delivered, and including them would make the last bar
  dwarf every other one for the rest of the studio's life. Every stage is drawn
  including the empty ones, so the panel does not change shape as work moves.
- **Delivery Calendar** — the next five dates something is due, grouped by day.
  Two assets due Thursday is one row saying two, because the question is how
  heavy Thursday is.
- **Attention Required** — overdue projects (brand accent), at-risk projects and
  work waiting on review (amber), work out with the client (teal). These are the
  app's existing status colours, not a new traffic-light set.

Every Attention row **names the projects it is about**, heaviest first, and each
is a link. That is not decoration: this application has no studio-wide list of
assets — the board and the Assets List are both scoped to one project — so a row
saying "6 assets waiting on review" with nothing to click would be a dead end.

### Team Capacity

A right-hand panel: **Available**, **Consumed** and **Idle** hours across the
people the studio gives work to, with a utilisation percentage and the headcount
the figures cover, in three period views — **Daily**, **Monthly**, **Annually**.

**It is not a second calculation.** Every figure comes from `buildIdleReport()`
in `src/routes/idle.js` — the same function the Idle Report tab, its spreadsheet
and its PDF are drawn from — called once per period with an explicit range.
`src/team-capacity.js` does no arithmetic on hours at all. Two implementations
of one calculation agree until somebody changes one of them, and the
disagreement then surfaces as a studio-wide capacity figure that is quietly
wrong; this way the two screens match **by construction**, and the test asserting
it is checking the wiring rather than the maths.

**Consumed is coverage, not a sum.** Time Spent is wall-clock between Accept and
Start and Submit for Review. Spans overlap when somebody holds three assets open
through one afternoon, and they run across nights and weekends — summing them
credits one person with 208 hours in a 40-hour week. The union-of-intervals in
`src/idle.js` is what makes the number mean anything. Two tests pin it: two
assets open across one afternoon count once, and a span from Friday evening to
Monday morning contributes 16 hours, not 66.

**Consumed + Idle = Available, exactly**, because coverage is capped at one
standard day per working day — nobody can be engaged for longer than they were
available. Asserted for all three periods.

**All three periods are period-to-date.** "Available hours this year" for a year
three-quarters elapsed blends capacity already spent with capacity not yet
reached: it reads as enormous idleness every January and none at all every
December. Monthly runs from the 1st to today, Annually from 1 January to today,
and the panel says so.

**Who is counted** comes from the Idle Report too: designations whose tier
carries the `assignable` capability — the ones given work. Not a list of role
names, which would go stale the first time somebody adds a designation in
Settings. Administrators are not assignable and are not counted, which is why
the headcount is shown beside the hours.

The `idle.caveats()` text travels with the numbers, in a disclosure under the
panel. An annual available-hours figure silently assumes nobody took a day off
all year, and leave, public holidays and sickness are recorded nowhere in this
app — the panel says that rather than leaving somebody to discover it.

#### It needs View Idle Report as well

The block shows exactly what `report.idle` gates. A studio that withheld the
Idle Report from a designation and then granted them the Admin Dashboard would
have handed over the same numbers by another door — so the payload carries the
`capacity` key **only** when the caller holds both permissions, and the panel is
absent rather than empty otherwise. An empty capacity block asserts the studio
has no capacity, and a zeroed one would still disclose the headcount.

### At narrower widths

Three breakpoints, and the panels rearrange rather than shrink:

| Width | Stat cards | Panels | Pipeline |
| --- | --- | --- | --- |
| Above 1200px | four across | three across, with Team Capacity | label beside the bar |
| 900–1200px | four across | two across, capacity on its own row | label beside the bar |
| 560–900px | two across | stacked | label beside the bar |
| Below 560px | one per row | stacked | label **above** its bar, full-width track |

The pipeline's label column is a fixed 132px so all ten bars start at the same
x — which is what makes them readable as one shape — but on a phone that leaves
the track about 110px, and a bar chart squeezed to a third of the row stops
carrying its comparison. Below 560px the label moves above.

`tests/admin-dashboard.test.js` asserts these by resolving the CSS cascade the
way a browser does, not by searching for the media query. The distinction is the
whole point of that test: the first version of this stylesheet had the @media
block sitting *before* the rules it overrides, so every declaration sharing a
selector with an earlier rule silently lost on source order — the screen looked
almost right, with the calendar rows centred instead of left-aligned. A test
that grepped for the breakpoint would have passed on the broken version.

### Who sees it, and how much

*View Admin Dashboard* (`report.admin_dashboard`) is **on by default for Super
Admin, Admin, Leadership and Full Access**. The brief asked for Admin and Super
Admin; the other two are the tiers that already outrank Admin — full access to
every project — and withholding an overview from Leadership while granting it to
Admin would be incoherent. Everyone else is off until a Super Admin says
otherwise, in Settings → Role Permissions.

**Holding the permission opens the tab. It does not widen anybody's reach.**
What the screen counts is scoped by the role's existing `projectScope`, the same
rule the rest of the app runs on. That matters because the **Admin tier is
`projectScope: 'owned'`** — it sees the projects it created, not the studio — so
a studio-wide total shown to an Admin would be full of projects they could not
open. A Super Admin sees the whole studio; an Admin sees their own; the subtitle
says which. Nobody is shown a number they cannot click into.

## Profit & Loss

The first money in this application. Its own tab, **Profit & Loss**, carrying two
sub-tabs — **Fixed P&L** and **Actual P&L** — and two Settings sections,
**Rate Cards** and **Role Rates**. All figures are in **₹ INR**. No existing
dashboard, task workflow or unrelated permission changed.

### Where every figure comes from

The two tabs are costed from **different sources on purpose**, because they
answer different questions. Nothing on either is typed twice.

| Figure | Tab | Source |
| --- | --- | --- |
| **Revenue** | Actual | Invoiced to date, from Client Billing |
| **Total Cost** | Actual | **Entered by hand**, in ₹, per project |
| **Total Hours Consumed** | Actual | Every work session on the project, **whatever state** the task is in |
| **Profit / Margin** | Actual | Revenue − Total Cost, over revenue |
| **Cost / Hour** | Actual | Total Cost ÷ hours consumed |
| **Fixed Contract Value** | Fixed | Contract value, from Client Billing |
| **Total Hours** | Fixed | The project's **Total Bid Hours** — every asset's Man Hours estimate, summed |
| **Total Consumed Hours** | Fixed | Work sessions on tasks that have reached **Delivered** only |
| **Actual Cost** | Fixed | Those delivered hours × each person's **role rate** |
| **Budgeted Cost** | Fixed | Bid hours at the same blended rate the delivered work ran at |
| **Profit / Margin** | Fixed | Contract value − actual cost − other costs, over contract value |

**Total Hours is not a field anybody types.** There is no total-hours box on the
New Project form; the project's budgeted hours are the sum of its assets' Man
Hours, which is exactly what the Projects tab has always shown as *Total Bid
Hours*. One number, one definition, two screens — and nothing entered in P&L can
move it.

**Total Cost is the one figure that is typed**, and deliberately so: a project's
real cost includes salaries, software and studio time this application has no
idea about. A figure somebody takes responsibility for is worth more than a
precise-looking sum of the parts the app happens to know. It is **NULL until
entered**, and the screen shows a dash — "this project cost nothing" and "nobody
has said what this project cost" are different facts and only one is ever true.

### Delivered is a filter, not a tally

A task's hours reach Fixed P&L's *Total Consumed Hours* the moment it reaches
**Delivered**, and not before. Hours on work in progress are counted on the
Actual tab (which counts everything) and not on the Fixed one.

Nothing increments when a task is delivered. The figure is **derived from each
asset's current state on every read**, so it is right after a delivery, right
after an override moves an asset back out of Delivered, and right when a work
session is added to something already delivered. A stored counter would have to
be correct at every one of those moments and would be wrong the first time one
was missed. "Updates automatically" is satisfied by never being stale.

### Role Rates — what prices an hour

**Settings → Role Rates** gives every designation an hourly rate in ₹. That is
what Fixed P&L costs delivered work at: a work session records a **user**, a user
holds a **designation**, so a designation is the only thing an automatically
recorded hour can be priced against.

This is **not** the Rate Cards section beside it. Rate Cards is the studio's
free-text price list (Artist / Senior Artist) for team assignments somebody types
in; Role Rates prices the hours people actually logged. Merging them would mean
inventing a mapping from `game_artist` to "Mid Level Artist" that nobody asked
for. Both remain; neither replaced the other.

**Clearing a rate is a separate action from saving one.** Each row has Save and
Clear. Emptying the box and pressing Save is **refused** — it used to delete the
rate and report "Rate saved.", a wipe dressed up as a write. Clear is the
deliberate way to mark a designation unpriced, and zero is a real rate meaning
"this costs nothing", which is not the same thing.

**An unpriced designation is not free.** A role with no rate contributes its
hours and no cost, and those hours are **reported separately** — on the card, in
the breakdown, and in the client rollup. Costing them at zero would understate
what a project cost, which is the direction of error that makes a loss look like
a profit. The Fixed tab shows a banner naming the unpriced hours and where to set
the missing rates.

### Three permissions, one per thing

| Permission | Covers | Default |
| --- | --- | --- |
| *Access Actual P&L* (`pnl.actual`) | The Actual tab, **and** entering/editing its Total Cost | Super Admin only |
| *Access Fixed P&L* (`pnl.fixed`) | The Fixed tab | Super Admin only |
| *Manage P&L Rate Cards & Billing* (`pnl.manage`) | Role rates, rate cards, team assignments, client billing, other costs | Super Admin only |

`pnl.view` was **replaced** by the first two — it is gone from the catalogue
rather than left as a grant that no longer gates anything.

**None implies another**, so all eight combinations are grantable. Somebody with
only *Access Actual P&L* does not see the Fixed tab at all, and the reverse;
holding neither means the **Profit & Loss nav entry does not appear**. The screen
opens on whichever tab the viewer actually holds, so a single-permission user
never lands on a blank page.

`pnl.manage` on its own opens **neither** tab: setting the price list and reading
what it produces are different authorities. The one place they are joined is the
Actual tab's Total Cost — that figure is behind `pnl.actual`, not `pnl.manage`,
because it is the only thing on that tab anybody types and whoever is given the
tab is being asked to keep it right.

### Everything is in the Activity Log

Role rates, the entered Total Cost, rate cards, assignments, billing and cost
line items all write to the Activity Log under a **`pnl`** module of its own,
each entry carrying old value to new.

## Project milestones

A project has one start and end date, but the work inside it has stages that run
on their own dates — art finishing weeks before animation starts, say. The
**Milestones** column on the Projects list under a client shows those stages
stacked one per line for each project:

```
Art: 12 Jan 2026 – 06 Feb 2026
Animation: 09 Feb 2026 – 20 Mar 2026
```

Milestones are added on the Add and Edit Project forms, a row at a time: pick a
type, give it a start and an end. Nothing else about a project changed — the
column is additive, and a project with no milestones reads as it always did.

### The types come from one list

*Art* and *Animation* are not special. They are rows in the `milestone_types`
reference list, managed under **Settings → Milestone Types** like every other
value list, with the same rules: renaming one leaves the projects holding it
untouched, a type in use cannot be deleted, and retiring one deactivates it so
it disappears from the dropdown without disturbing the milestones already on it.

Milestones are **selective**, not compulsory: a project takes the stages it
actually has. Each type can appear at most once per project, so the stacked
lines never repeat a stage, and a project is capped at 20 of them.

### What is refused, and what is only a warning

A milestone whose end falls before its start is **refused** — it is not a
schedule, it is a typo. So is a duplicate type, an unknown or retired one, and a
milestone on a project that has no dates of its own to judge it against.

A milestone falling outside the project's own start and end dates is a
**warning**, not a refusal. Stages genuinely do run past a project window while
the dates are being renegotiated, and a hard refusal there would mean the
schedule could not record what is actually happening.

### Two permissions

| Permission | Covers |
| --- | --- |
| *Set Project Milestones* (`project.milestones`) | Adding, changing and removing milestones on a project. |
| *Manage Milestone Types* (`settings.milestone_types`) | The list of stages in Settings. |

They are separate on purpose: deciding which stages the studio plans in is a
different decision from planning one project with them. The API refuses a save
that touches milestones without the first, whatever the form sent.

## Email notifications

Two events send email, alongside — never instead of — the notification bell and
Pending Actions, which are untouched by this feature:

| When | Who is written to | What it says |
| --- | --- | --- |
| A task is assigned or reassigned | The person it is now assigned to | The task, who assigned it, the project, and the due date if there is one. |
| A task is submitted | Whoever assigned it, and the submitter's team lead | The task, who submitted it, and when. |

Nobody is told about their own action: assigning something to yourself sends
nothing, and neither does submitting work you assigned to yourself. The person a
task moves *away* from gets a bell entry and no email — it is not something they
have to act on, and mail nobody needs to act on is how a studio learns to ignore
mail it does.

### Assignment email is raised from one place

Four routes change who holds a task — creating one with somebody on it, editing
the assignee, bulk assigning, and the hand-over out of review — and all four go
through `assignments.open()`. The email hangs off that choke point, so the fifth
route somebody adds next year is covered without them remembering, exactly as
the bell already is.

Submission email is raised from the submit route instead, and deliberately does
**not** add a notification kind. Adding one would have put a new row in
everybody's bell, and the bell was to be left alone.

### A bulk assign is one email

Assignment emails wait a moment (`EMAIL_BATCH_MS`, default 1500) so that
assigning forty tasks to one person produces one message listing all forty
rather than forty messages. A single assignment still reads as a single
assignment, not as a digest of one.

### Nothing about email can fail the thing that caused it

A task must be assignable when the mail server is down. Every send is queued and
happens after the response has gone; every path swallows its own errors; and the
failure is recorded on the Settings screen rather than thrown. The worst case is
an email that does not arrive, which is a much smaller problem than a
reassignment that refuses to happen.

### Configuring it

**Settings → Email Configuration**, behind *Manage Email Configuration*
(`settings.email_config`) — **Super Admin only by default**, the same front door
as the two IP lists and for a related reason: this screen holds a live password
for another system, and whoever holds it can change where the studio's
notifications appear to come from. It is deliberately *not* implied by
*Manage Settings*.

The form takes the mail server, port, encryption (STARTTLS, SSL/TLS or None),
username, password, and the From name and address, plus a master on/off switch.
**Send Test Email** sends a real message using the values **currently on the
form**, saved or not — so a server can be proved before it is committed, which
is the difference between finding out now and finding out in a month.

A failure says what to do about it rather than reporting an error code. On
shared hosting the likeliest cause by a distance is that outbound SMTP is
blocked at the host, not that anything on the form is wrong, so the message says
so and points at `scripts/check-outbound.js`, which tells the two apart.

### The password

It is the only reversibly-stored secret in this database — every other one is a
bcrypt hash — because a mail server wants the actual characters on every send.
So it gets more care rather than less:

- **Encrypted at rest** with AES-256-GCM, a random IV per save, under a key from
  `EMAIL_ENCRYPTION_KEY` (falling back to `JWT_SECRET`). Authenticated, so a
  tampered value fails to decrypt rather than being handed to a mail server.
- **Never returned.** No route selects it, and it is dropped at the cache
  boundary rather than deleted per response — a field that never enters the
  cache cannot leak from one. The screen shows a fixed-length mask, which is
  deliberately not the real length.
- **Never logged.** The Activity Log records `password: set`, and the value
  appears in no summary, no diff and no response.
- **Leaving the box empty means "keep it"**, not "clear it". Otherwise every
  unrelated edit would silently stop all mail.

Set `EMAIL_ENCRYPTION_KEY` rather than relying on the `JWT_SECRET` fallback.
Rotating `JWT_SECRET` is something you *should* do, and if it is also the mail
key that rotation silently makes the stored password unreadable. A fingerprint
of the key is stored beside the ciphertext, so this case produces "enter the
password again" on the screen instead of mail quietly not arriving.

What this does **not** protect against is somebody who can read both the
database and the environment on the same host. It protects against the realistic
case — a database dump, a stray backup, a support person given read access to a
table.

### Turning it off for yourself

**Profile → Email notifications** switches both emails off for one person. It
needs no permission and cannot be taken away: somebody who could be denied the
ability to stop mail arriving would have no way to stop it except a spam filter,
which would swallow the mail that mattered too.

The column is an opt-*out*, defaulting to off — so everybody receives email when
the feature arrives. An opt-in default would deliver nothing at all until each
person went and found the switch, which is indistinguishable from email being
broken.

The switch stops **email only**. The bell, desktop notifications and Pending
Actions carry on exactly as before.

## The mobile apps

There are native iOS and Android apps for the studio's own team — **not on the
App Store or Google Play**, installed from a link on this server. They live in
`mobile/`, and `mobile/README.md` is the full runbook: signing keys,
provisioning, adding a new employee's phone, hosting the builds, and the annual
iOS rebuild.

Both are **shells**: a native app whose screen is a web view pointed at this
application. A change deployed to the website is on every phone the next time
somebody opens the app — no rebuild, no redistribution, nobody stuck on an old
version. The trade is that the app needs the network to show anything, which it
handles with a proper offline screen rather than a blank one.

What the shell adds that a browser cannot: push notifications on the lock screen
with the app closed, a camera button beside every file picker, session
persistence across the system evicting the web view's storage, Android's back
button, safe areas around the notch, and pull-to-refresh.

### Push notifications

Push hangs off `notifications.raise()` — the same single funnel the bell already
uses — so every notification the bell shows reaches the phone, built from the
same sentence. Chat is the one addition: it deliberately raises no bell
notification, so `src/routes/chat.js` pushes separately, and **never sends the
message body** — only "*Ana* sent you a message."

`src/push-notifications.js` talks to APNs and FCM **directly, over plain HTTPS
with a signed JWT, and adds no dependencies**. Both services are reachable that
way with what Node already has, and every dependency added is a thing that can
fail to install on a host nobody can SSH into.

It is silent until configured. A deployment with no keys works exactly as it did
— `status()` reports that, the app checks it before prompting anybody for
permission, and Settings and Profile both say so rather than showing a switch
that does nothing.

Each person has their own **"Notify me on my phone"** switch in Profile, beside
the email one and independent of it: somebody who wants a buzz for a new task
very often does not want an email about it too, and the reverse is just as
common. Like the email switch it needs no permission — whether your own phone
buzzes is not an authority the studio grants.

### Handing the builds out

**Settings → Mobile Apps** (permission `mobile.distribute`, Super Admin only)
shows what is on the server and the install link to send the team. Uploads go to
`dist-mobile/`.

The download paths are **not behind the sign-in**, and cannot be. Tapping an
`itms-services://` link hands the manifest URL to a *system daemon*, which
fetches the manifest and the `.ipa` itself with none of the browser's session —
an authenticated path gets a login page instead of a plist and the install fails
with a message naming neither. So the path carries an unguessable token
instead: 24 random bytes over HTTPS, compared in constant time.

Stated plainly: **anybody with the link can download the builds.** The builds
are shells — no studio data, no credentials, and everything inside them is still
behind the same sign-in as the website — so a stranger with the link gets an app
showing them a login screen. Keep it inside the studio anyway; `MOBILE_DIST_TOKEN`
rotates it.

`mobile.distribute` gates that screen because **the response contains the
token**. Everything else on it is a file size and a date.

## Restricting access by IP address

The whole application can be limited to a set of addresses. The check runs on
**every request, before authentication** — a blocked address does not reach the
sign-in form, so it cannot try passwords. That ordering is the point of the
feature; checking after sign-in would leave the interesting endpoint exposed.

A Super Admin manages the list under **Settings → Allowed IP Addresses**.
Entries are single addresses (`106.51.81.61`) or CIDR ranges
(`106.51.81.0/24`, `2001:db8::/32`), and take effect on the next request — no
restart. Every change is recorded with who made it and from where, under
*Change history* on the same screen.

There are two lists, and they are not symmetrical. The allowlist says who may
come in; the **blocklist** says who may not, and is checked first — see
[Blocking specific addresses](#blocking-specific-addresses).

### It does not block anything until you say so

**Monitor is the default**, and enforcing takes the exact word `enforce` —
nothing else turns it on. The address the app sees is the one your proxy
reports, which is often not the one you expect, and a list holding the wrong one
locks out everyone the moment it starts blocking.

1. Deploy. Nothing is blocked; what *would* have been blocked is logged.
2. Open **Settings → Allowed IP Addresses** and read the *You are connecting
   from* line. That is the address the gate will judge — add it if it is not
   already there.
3. Confirm the log flags no addresses you care about, then set
   `IP_ALLOWLIST_MODE=enforce`.

`TRUST_PROXY` decides which address that is: too low and every visitor looks
like the proxy, too high and a client can name its own address. `1` is right
behind cPanel/Passenger or a single load balancer.

### Reading a monitor-mode rollout

Monitor mode exists to answer one question before enforcement goes on: *if this
were enforcing, who would it have turned away?*

The gate writes each verdict to the process log — `console.warn`, so **stderr**,
which on this host is the platform's application log; there is no log file on
disk. Repeats from one address are rate-limited to a few lines per ten minutes,
so a scanner cannot bury the line that matters.

But a log is a stream, and the address you most need to see is often the one
that appeared once, an hour ago. So the gate also keeps a running tally, shown
under **Settings → Allowed IP Addresses → What enforcing would do**:

- **Would be refused** — every address enforcement would turn away, with a
  request count, when it was last seen, and an **Allow this** button.
- **Currently getting through** — which addresses the list is letting in.
- A verdict line naming how many addresses stand between you and enforcing.

`GET /api/ip-allowlist/observed` returns the same thing as JSON.

**An address that never appears has not been checked — it has just never
connected.** That distinction is the whole risk in this rollout: "my address is
not in the refusal log" is not evidence it is allowlisted, and reasoning from it
is how a studio locks itself out. Confirm from *Currently getting through*, or
from the *You are connecting from* line, that the address you rely on is
actually matching an entry.

The tally is in memory and per-process: it covers one worker since it last
restarted, and a host running several workers gives each its own view. Writing a
row per blocked request would let anyone scanning the internet drive database
load, which is a poor trade for data that only matters during a rollout.

### The platform's health check is never blocked

Requests arriving over **loopback** are exempt, always — ahead of every other
decision, fail-closed included. This host health-checks the app with a plain
`GET /` from inside the container, not a request to a health path, and refusing
it marks the release unhealthy and rolls it back.

A remote visitor cannot arrange to look like loopback: with a proxy in front,
the address judged is the one that proxy wrote, so anything a client prepends is
ignored. Set `IP_ALLOWLIST_ALLOW_LOOPBACK=false` only if the app is reachable
directly rather than through a proxy — the startup log warns when you have. If
your host probes from a container-network address instead, set
`IP_ALLOWLIST_ALLOW_PRIVATE=true`.

### It cannot lock you out permanently

The ways back in live in the environment rather than in the table they protect —
a safeguard editable through the thing it safeguards is not a safeguard. All of
them are set on the server by whoever would be fixing the lockout, and every use
is logged.

| Setting | Effect |
| --- | --- |
| `IP_ALLOWLIST_ENABLED=false` | Turns the restriction off entirely. |
| `IP_ALLOWLIST_MODE=monitor` | Blocks nothing; logs what it would have blocked. |
| `IP_ALLOWLIST_EMERGENCY=1.2.3.4,10.0.0.0/8` | Addresses allowed whatever the database says. |
| `IP_ALLOWLIST_BYPASS_TOKEN=…` | A request carrying this in `X-Allowlist-Bypass` passes from any address. |
| *(an empty list)* | Treated as "not configured", so the app stays open. |
| *(unreadable storage)* | Also stays open, loudly — see [When its storage breaks](#when-its-storage-breaks). |

Set at least one of `IP_ALLOWLIST_EMERGENCY` or `IP_ALLOWLIST_BYPASS_TOKEN`
before enforcing. Without one, a wrong entry means editing the database by hand.
The startup log says so if neither is set.

An **empty list means open, not closed**. Deleting the last entry, or deploying
against a fresh database, leaves the app reachable rather than reachable by
nobody. The Settings screen states which of the two you are looking at rather
than letting you believe the app is locked down when it is not.

`/api/health` is never blocked. If the host cannot reach it the deployment is
marked unhealthy and restarted, which would turn a bad allowlist into a restart
loop. It exposes nothing but whether the database answers.

### Every worker keeps its own copy, and catches up

The gate runs ahead of everything, on every request, so it reads the list from
memory rather than from the database. Passenger and most cPanel setups run
**several Node workers against one database**, and each worker has its own mirror —
so a write refreshes the copy belonging to the worker that handled it, and does
nothing for any of the others.

Left there, that means the answer to *is this address allowed* depends on which
worker took the request:

- an address you just **added** gets in only sometimes, and
- an address whose access you just **revoked keeps working** — which is the
  restriction silently not being applied, and nobody reports that, because from the
  outside it looks like it is working.

This is the same class of bug the reference-data refresh exists to fix (a role added
on one worker used to mean `403` on everything from the others), and it is answered
the same way rather than with a new mechanism: every worker reloads the list every
`IP_ALLOWLIST_REFRESH_SECONDS` (default 30, `0` to switch off on a single-process
deployment). The reload is one indexed read of a table with a handful of rows; it is
logged only when the list actually changed.

The same interval governs the **integration's** separate address list, from the same
timer. `tests/ip-allowlist.test.js` and `tests/service-auth.test.js` each run two
real servers against one database and assert both directions — added, and revoked.

### Removing the entry that lets you in

Removing or deactivating the entry covering your own address is refused unless
you confirm it. The browser asks first; the API refuses a `DELETE` without
`?confirm=yes` regardless, so a script or a stale tab gets the same protection.
The message distinguishes the two cases — whether another entry still covers
you, or whether this is the one thing keeping you in.

### Blocking specific addresses

The allowlist answers "who may reach this app". The blocklist answers the other
question — "who may not" — and a Super Admin manages it under **Settings →
Blocked IP Addresses**, below the allowlist on the same screen. Entries are
single addresses or CIDR ranges, take effect on the next request, and every
block and unblock is written to the **Activity Log** under *Settings*, naming
the address, the reason and who did it.

Three of its rules are deliberately **not** the allowlist's. Each is stated on
the screen itself, because somebody who has read the allowlist panel will
otherwise carry the wrong assumption across:

- **A block beats the allowlist.** It is checked first, so an address on both
  lists is refused. Carving one machine out of an allowed range is what the
  feature is for, and the screen says so when you block an address the allowlist
  covers.
- **A block applies in monitor mode.** Monitor mode exists because an
  *unfinished* allowlist should not lock a studio out. A blocklist entry is not
  unfinished — somebody named one address and said keep it out. Honouring it
  only under `enforce` would mean blocking a compromised device on a
  monitor-mode deployment did nothing at all, while looking exactly like it had
  worked.
- **A block never beats the escape hatches.** Loopback,
  `IP_ALLOWLIST_EMERGENCY` and `IP_ALLOWLIST_BYPASS_TOKEN` are all checked
  before it, so a mistaken block is always recoverable from the server
  environment rather than by editing the database. A blocked address that is
  also an emergency address still gets in, and that ordering is the design.

Blocks are **permanent by default**. Leave *Expires* empty and the entry stands
until somebody removes it; set a date and time and it lapses on its own. Expiry
is a comparison made on every request rather than a scheduled job, so nothing
has to run for a block to end. A lapsed entry stays listed, marked *expired*,
because somebody looking for why an address was blocked last week needs to find
it.

Addresses can be added by hand, or with the **Block** button beside any address
in *What enforcing would do* — on both halves of that table, since the address
worth blocking is usually one that is currently getting through. A row already
covered by a block is marked instead of offering the button.

Unblocking deletes the row rather than deactivating it, which is the opposite of
the allowlist's choice. An allowlist entry is often taken off for a week and put
back; an unblocked address is a decision that it is fine now, and a switched-off
block left on the screen invites somebody to switch it back on without knowing
why it was lifted. The Activity Log holds the history.

#### You cannot block yourself

Blocking an address that covers your own is **refused outright** — a 409 with no
confirm-and-proceed, which is stricter than the allowlist's equivalent guard.
The difference is the recovery path. Removing your allowlist entry locks you
out, but the list is still there and a colleague on another allowed address can
put it back. Blocking your own address locks you out of the screen that would
undo it, immediately, and the only way back is an environment variable on the
server. Blocking a *range* that happens to include you is refused for the same
reason and is the likelier of the two mistakes.

There is no legitimate use for it either: an administrator who wants to stop
using an address takes it off the allowlist instead.

#### Its own permission

*Manage IP Blocklist* (`settings.ip_blocklist`) is **Super Admin only by
default** and is not implied by *Manage Access* or by the allowlist permission —
allowing an address and barring one are different powers. The API refuses every
route without it, signed in or not.

If its table cannot be read, **nothing is blocked** — the same failure direction
as the allowlist, for the same reason, and announced just as loudly, with a
**Repair now** button on the panel.

### When its storage breaks

The allowlist lives in two tables. If they cannot be read — they were never
created, or the database user cannot see them — the gate **opens rather than
closes**, because closing would strand the one person who could fix it behind
the gate that broke.

That is the safe failure, but it is not a quiet one:

- Startup prints `*** IP ALLOWLIST STORAGE IS UNAVAILABLE ***` with the database
  error and the remedy.
- The moment the fault is discovered, the log says `NOT ENFORCING`, and repeats
  it every ten minutes for as long as it lasts.
- **Settings → Allowed IP Addresses** replaces the list with a red panel naming
  the error, the likely cause, and the fix — with a **Repair now** button that
  creates the missing tables and reloads, no redeploy needed.

`IP_ALLOWLIST_FAIL_CLOSED=true` reverses the choice for a deployment that would
rather be unreachable than unrestricted. It is *ignored* unless
`IP_ALLOWLIST_EMERGENCY` or `IP_ALLOWLIST_BYPASS_TOKEN` is also set, since
without one of those it would turn a storage fault into an outage with no way
back in. Blocked visitors then see "Access temporarily unavailable" rather than
"Access denied", because the two mean different things.

An empty list and an unreadable one look identical from the cache and mean
opposite things — a gate nobody configured versus a gate that lost its
configuration. Only the first is treated as "open by choice"; the second is a
fault and is reported as one.

### Cost per request

The gate reads an in-memory mirror of the table, refreshed at startup and after
every write. It issues **no database query per request** — measured at zero
across 200 requests, allowed and blocked alike — so it cannot exhaust the
connection pool however much traffic arrives.

### Spoofing

`X-Forwarded-For` is a header anyone can send. Express resolves the client
address from it according to `TRUST_PROXY`: with one proxy in front, it takes
the entry that proxy wrote, and anything a client prepended sits to the left of
it and is ignored. No other header (`X-Real-IP`, `CF-Connecting-IP`, `Forwarded`)
is consulted at all. `tests/ip-allowlist.test.js` asserts each of those.

Matching lives in [`src/ip-match.js`](src/ip-match.js), written out rather than
pulled in. It is deliberately strict: leading-zero octets (`010.1.1.1`, octal to
some parsers and decimal to others), hex forms, `/33`, and anything it cannot
parse with certainty are refused rather than guessed at. An IPv4-mapped IPv6
address (`::ffff:106.51.81.61`) is treated as the same host as its IPv4 form, so
one entry covers both spellings.

## The integration API

Another system in the studio can call Forge under `/api/integration` — a Dev & QA
tool, a build server, a script on somebody's machine. It is a separate door with
its own locks, and it is the only part of the application no person signs in to.

**The caller is a machine, not an account.** No `req.user`, no `req.permissions`,
no `authenticate()`, no `requirePermission`. Nothing about it appears in the user
list or on **Settings → Role Permissions**. Every ownership and `projectScope`
rule in this codebase is written about a person, and routing a build server
through them would make each of those checks start answering a question it was
never written to answer. What a credential may do is written on the credential:
`integration_clients.allowed_actions`, a CSV checked against the first path
segment under `/api/integration`.

Four locks, in this order, each able to refuse on its own:

| Lock | Where | Refuses with |
|---|---|---|
| Address | [`src/middleware/integration-ip-allowlist.js`](src/middleware/integration-ip-allowlist.js) | `403` — and only in `enforce` mode; see below |
| Rate limit | `src/server.js`, the same library as sign-in | `429` |

The rate limit is **counted per worker process**, not across the deployment.
`express-rate-limit` is used with its default store, which keeps its counters in
memory and states that keys in one instance cannot affect another — so with several
Passenger workers the effective ceiling is `INTEGRATION_RATE_MAX` multiplied by the
number of workers, and which counter a request increments depends on who answers.

This is stated rather than fixed because it is exactly how the two sign-in limiters
have always behaved here; the integration API is no weaker than the rest. Tightening
it properly means a shared store — Redis, or a database-backed one — which is an
infrastructure decision rather than a code change, and it would want doing for all
three limiters at once. Size `INTEGRATION_RATE_MAX` with the multiplier in mind.
| Signature | [`src/middleware/service-auth.js`](src/middleware/service-auth.js) | `401`, or `503` if the secret is unset |
| Credential and action | the same module | `401` unknown or inactive; `403` action not allowed |

### The signature

`X-Integration-Signature: t=<unix seconds>, v1=<hex HMAC-SHA256>` over
`"t.METHOD.path.rawBody"`, keyed on `INTEGRATION_INBOUND_SECRET`. The HMAC is
taken over the **exact bytes that arrived**, so the body is read raw by
[`src/middleware/integration-body.js`](src/middleware/integration-body.js),
mounted on `/api/integration` ahead of the global `express.json()`. `express.raw()`
sets `req._body` once it has read the stream and every later body parser returns
immediately on that flag, which is what keeps every other route's parsing exactly
as it was — including multipart uploads, which
`tests/service-auth.test.js` exercises for that reason.

A timestamp more than **300 seconds** from the server clock is refused, in either
direction: one far in the future is as much a replay as one far in the past. The
check runs before the HMAC, so an expired request costs nothing to refuse. The
comparison is `crypto.timingSafeEqual`, via a wrapper that answers a length
mismatch as an ordinary mismatch rather than throwing — throwing would be both a
500 and a timing signal.

This secret is **separate from the one Forge signs its outbound calls with**, so
a leak in one direction is not a leak in both. Unset, every integration request
answers `503` and does no work: treating "no secret" as "no signature required"
would turn an unfinished setup into an open door, quietly, and only on the
deployment where it mattered.

### The credential

Issued as a key, stored only as its SHA-256 hash, so the key exists nowhere in
the database and cannot be read back out of it — only replaced. An **unknown key
and a deactivated one answer the same sentence**, deliberately: telling them
apart would let anybody enumerate which credentials the studio has issued by
watching which of two messages comes back. A successful call stamps
`last_used_at`, recorded but never awaited — whether the request worked is not
contingent on a bookkeeping write.

Every state-changing integration call lands in the Activity Log with the actor
shown as `integration:<name>`. That actor is passed as an **object**, not a
string: `src/activity.js` reads `.name`, `.id`, `.email` and `.role` off whatever
it is given, so a bare string there is not an error — it simply records a NULL
actor, which is the blank line naming the actor exists to prevent.

### A second address list, and why

`/api/integration` is **exempt from the sign-in gate** ([`DELEGATED_PREFIXES` in
`src/middleware/ip-allowlist.js`](src/middleware/ip-allowlist.js)) and has its own
list in `integration_ip_allowlist`, with its own mode and its own escape hatches.
Two different questions — which offices may sign in, and which machines may call
the API — and answering both from one list would mean whoever maintains the
studio's offices silently decided whether a build server could reach Forge.

It is the same architecture as the sign-in list: tables declared in the module,
an in-memory mirror reloaded on every write, the same four readiness states, and
switches that live only in the environment. **It ships in `monitor` mode**: it
writes down what it would have refused and refuses nothing, until somebody
confirms the address the app actually sees and sets
`INTEGRATION_IP_ALLOWLIST_MODE=enforce` deliberately. An empty list is treated as
"not configured" and stays open, as is unreadable storage — there is no
fail-closed switch here, because the signature and the credential are the locks
that hold either way, and an address list is not one of them.

### Idempotency

Every `POST`, `PUT` and `DELETE` under `/api/integration` must carry an
`Idempotency-Key` header. A caller whose request times out cannot know whether
the work happened, so retrying is the only safe thing it can do — and recognising
the retry is the only safe thing this end can do.

| The caller sends | It gets |
|---|---|
| a new key | the work runs; the response is recorded |
| the same key, same body, first one finished | the stored response, with `Idempotent-Replay: true`; **the handler does not run** |
| the same key while the first is **still running** | `409` with `code: idempotency_in_progress` and `Retry-After`; the handler is not entered |
| the same key, a different body | `422` with `code: idempotency_key_reused`, logged; nothing runs |
| no key at all | `400` |
| the same key after a failure | the work runs, because a failed attempt keeps no answer to replay |

The two 4xx answers carry **distinct codes** because they mean opposite things to
the machine reading them: `idempotency_in_progress` says wait and come back,
`idempotency_key_reused` says you have a bug. A client matching on the status
number alone cannot tell them apart, and the one that looks more like a failure is
the one it must *not* keep retrying.

**The record commits with the change, or neither does.** If the change committed
and the record did not, a retry would do the work twice; if the record committed
and the change did not, a retry would be answered with a success for work that
never happened. Both are worse than no idempotency at all, because both are
silent.

A middleware cannot give that. It runs before the handler and again after it,
while the handler's writes commit in between on a connection the middleware does
not hold. So the transaction is opened by
[`src/integration-idempotency.js`](src/integration-idempotency.js) and handed to
the handler:

```js
router.post('/thing', (req, res) => idempotency.withIdempotency(req, res, async (trx) => {
  await trx.query('INSERT INTO …');        // on trx, or it is not in the transaction
  return { status: 200, body: { … } };
}));
```

What the middleware still does is the part that must not be forgettable: refusing
a keyless mutation, and writing a line to the log when a handler changed something
without going through the helper at all.

### Reserve, run, record

The key is **claimed before the handler runs**, by an `INSERT` that commits on its
own. A duplicate's `INSERT` then violates the primary key and it is turned away
without ever entering the handler. The claim is what makes the key exclusive; the
primary key is what makes the claim atomic. Only the claim moved earlier — the
record that stores the response is still written inside the handler's own
transaction.

This replaced a check-run-record order, where the "check" was a read, and a read
cannot exclude anybody: two duplicates both found nothing, both ran, and only
their *commits* were deduplicated. Database writes were safe; everything the
handler did outside its transaction happened twice.

So `fn` now runs **exactly once** per `(client, key)`. The one exception is a claim
left behind by a process killed mid-handler — nothing exists to finish or release
it, and without a way out one crash would poison that key forever. A claim
therefore goes stale after `INTEGRATION_IDEMPOTENCY_STALE_SECONDS` (default 120)
and the next retry takes it over. Two minutes is two of the outbox's minimum
one-minute retry intervals: the first retry after a crash is still told to wait,
the second takes over. Setting it *below* a caller's retry interval would let a
merely-slow request have its key stolen by its own retry — which is the duplicate
execution all of this exists to prevent, so the direction of that risk is
asymmetric.

The row is a small state machine, in the `status` column that every other table in
this schema spells the same way:

| `status` | Means |
|---|---|
| `pending` | claimed; the handler is running, or was when its process was last alive |
| `complete` | finished, with the answer stored — the only state a replay is served from |
| `failed` | the handler threw, or returned a refusal of its own. Kept for diagnosis, and takeable at once |

A failed claim is takeable **whatever the body**, because `status` is checked
before the hash: a hash mismatch is only a conflict against a row that *answered*
something. A failed attempt answered nothing, so a caller correcting the body that
just failed may reuse the key — which is the normal way a caller recovers, and
checking the hash first would refuse exactly that.

The key is **scoped to the credential that chose it**. Two clients picking the
same string are two different requests; without the scoping the second would be
handed the first one's response, which is a cross-tenant leak wearing a cache's
clothes. The `integration requests` table was created with `idempotency_key`
alone as its key and its own DDL called the scoping a decision about the API
rather than about storage — the `integration idempotency scope` migration step is
that decision.

Keys are forgotten after seven days, by a sweep with the same shape as the chat
attachment sweep in [`src/chat-files.js`](src/chat-files.js): a pass at startup,
then a timer, `unref`'d so a stopped server is not held open by it. The startup
pass is the one that matters — a process restarted after a week down comes back
holding keys no timer ever fired for. A key reused after the window is treated as
new, so the window has to outlast any retry a caller will really make.

### The outbox: what Forge sends out

The other direction. A change that Dev & QA needs to know about writes a row in
`integration_outbox` **inside its own transaction**, so the fact and the intention
to tell somebody about it commit together or neither does. A worker in
[`src/integration-outbox.js`](src/integration-outbox.js) delivers it afterwards.

**Nothing about delivery can reach the request that caused the row.** The writer's
only involvement is an `INSERT`; it does not wait for delivery, learn whether it
succeeded, or slow down when the receiver is unreachable. There is no code path
back. `tests/integration-outbox.test.js` asserts that against a socket that
*accepts connections and never answers* — the shape that would actually hurt, since
a refused port fails in a millisecond and would prove nothing — and measures that
requests issued while the worker is stuck in an 8-second delivery still return in
well under a fifth of that.

The signature is the **same envelope** the inbound side verifies —
`t=<unix seconds>, v1=<hex HMAC-SHA256 of "t.POST.path.rawBody">` — so the other end
implements one verifier rather than two. Different key, same shape. Each attempt
also carries `X-Integration-Delivery` (the row's id, identical on every retry of
it) and `X-Integration-Attempt`, so the receiver can recognise a retry as one; we
cannot assume they deduplicate, but we can make it possible.

`INTEGRATION_OUTBOUND_SECRET` **must not equal** `INTEGRATION_INBOUND_SECRET`, and
Forge refuses to deliver anything at all if they match rather than warning and
carrying on. One secret for both directions means whoever can verify a message can
also forge one, which removes the only thing a signature proves — and it would look
like it was working.

#### The retry schedule

Fixed in code, not configurable, because the other end has been told what to
expect: **1 min, 5 min, 30 min, 2 h, 6 h, 24 h**, then the row is marked `failed`.
Seven attempts in all, spanning a little over a day — enough to ride out an
afternoon's outage with nobody intervening, short enough that a week-long one
becomes something somebody is told about rather than something quietly hammered.

Written as the delays themselves rather than as a formula: a doubling with jitter
would be fewer characters and would not be *this* schedule.

| Receiver said | What happens |
|---|---|
| 2xx | `sent` |
| 5xx, or 429 | retried on the schedule |
| any other 4xx | `failed` at once — retrying cannot fix a malformed payload, and six more copies is noise on their end |
| nothing, within the deadline | retried; the deadline is explicit because `fetch` has none of its own |

`attempts` is incremented when a row is **claimed**, not when the outcome is known.
A worker killed mid-delivery has still used an attempt — counting only completed
ones would let a row that crashes the process every time be retried forever.

#### The v1 surface

Everything is mounted at **`/api/integration/v1`**, and that prefix is load-bearing
rather than decorative. The action a credential needs is the first path segment *after
the mount*, so mounting at `/api/integration` and nesting a `/v1` router would make the
action `v1` for every call — a capability no credential will ever hold. Mounting at both
prefixes is worse still: the broader mount matches the narrower path too, so a `/v1`
request would run the whole chain twice and be refused by the first pass. One mount, at
the versioned prefix. `ping`, `counter` and `events` moved there with everything else.

| Route | Action it needs |
|---|---|
| `GET /projects` | `projects` |
| `GET /projects/:id/assets?updated_since=` | `projects` |
| `GET /assets/:id` | `assets` |
| `GET /files/:id` | `files` |
| `POST /handoffs/:id/ack` | `handoffs` |
| `PUT /assets/:id/in-game` | `assets` |
| `GET /events?since=` | `events` |

Path parameters do not disturb that — checked against a running Express, not assumed.
**`/projects/:id/assets` needs `projects`, not `assets`**, because the resource family it
enters is projects: a credential granted only `assets` can fetch one asset by id and
cannot list a project's. That follows from the rule rather than from a decision, and
special-casing it would mean the permission a URL requires could no longer be read off
the URL. If the studio would rather that call needed `assets`, the thing to move is the
route — to `/assets?project_id=` — not the rule.

`GET /projects` is **unpaginated**, matching the internal `GET /api/projects`: a studio
has tens of projects, and a second cursor shape for this would be machinery for nothing.

**`updated_since` is a sequence, not a timestamp**, and it has to be: `assets` has no
`updated_at` column, and inventing one would be a second answer to a question this schema
already answers. `asset_events` carries every transition with a `seq BIGINT
AUTO_INCREMENT`, and its own DDL says why that exists instead of a timestamp — `created_at`
is accurate only to the second, and submit/approve/relay land in the same second
routinely. So an asset's change marker is `MAX(asset_events.seq)`, which is the same
cursor kind `/events` uses. One consequence, stated rather than discovered: creating an
asset writes no `asset_event`, so an untouched asset has marker 0 and appears only on a
full sync. That is right for this consumer — nothing has happened to it.

`GET /files/:id` takes an `asset_versions` id and reuses the internal
`/api/assets/versions/:versionId/download` convention, with two deliberate differences:
it does not call `canViewAsset` (there is no `req.user` to pass it — a credential's
authority is `allowed_actions`), and it resolves against `UPLOAD_DIR` exported from
[`src/upload.js`](src/upload.js) rather than rebuilding that path by hand. The stored name
is never trusted as a path.

##### The two business-level guards

These are **in addition to** the idempotency-key replay, not instead of it. That handles a
repeated *call*; these handle a repeated *fact*, from a caller with a fresh key that lost
its own bookkeeping.

**Acking a hand-off.** Same build again → `200` with the record as it stands and
`alreadyAcked: true`; nothing is written and the note is not overwritten. A **different**
build → `409` with `code: handoff_build_mismatch`, naming the build that actually took it.
One drop cannot have landed in two builds, and overwriting the first would destroy the
only record of which did.

**Reporting in-game state.** The body carries `build_seq`. An older *or equal* sequence
→ `200 { applied: false }` and nothing changes. Not a `4xx`: the caller did nothing wrong,
the report simply arrived after a newer one, and a retrying client would treat a `4xx` as
something to fix.

Two things about that guard are worth knowing, both found by testing rather than reasoning:

- `applied` is decided from a read inside the handler's transaction, **not** from
  `affectedRows`. The documented reading of `INSERT ... ON DUPLICATE KEY UPDATE` is 1 for
  an insert, 2 for a change and 0 for a no-op — but on this MariaDB a no-op reports **1**,
  the same as an insert, so the statement cannot tell a row it created from one the guard
  held back. A first version of this told a caller its stale report had taken effect.
- That read is a plain `SELECT`, **not** `SELECT ... FOR UPDATE`. `FOR UPDATE` on a row
  that does not exist yet gap-locks, so two concurrent first reports deadlocked into a
  `500`. Without the lock two reports can both decide they apply — which is exactly why
  the `IF(VALUES(seq) > seq, …)` guard in the statement is the authority on what is
  *stored*, while the read only decides what is *reported*.

#### Pulling instead: `GET /api/integration/v1/events?since=<seq>`

A push that never arrived looks, from the far end, exactly like nothing having
happened. So the same rows can be **asked for**, in ascending `seq` order, reading
the same table the worker delivers from — two sources of truth for what happened is
how a replay ends up disagreeing with the original.

```
GET /api/integration/v1/events?since=1024&limit=50
{
  "events": [ { "seq": 1025, "id": "…", "payload": {…},
                "status": "failed", "attempts": 7, "lastError": "…", "createdAt": "…" } ],
  "since": 1024, "limit": 50, "hasMore": true,
  "lastSeq": 1074, "highWater": 3312,
  "statusesIncluded": ["pending", "sending", "sent", "failed"]
}
```

Keep calling with `lastSeq` until `hasMore` is false. `highWater` is the newest `seq`
that exists, so a caller can tell *caught up* from *one page behind* without a second
request. A `since` past the end is **empty, not an error** — being up to date is not
a failure — and it hands the cursor back so a caught-up caller can keep polling with
the same value. A *malformed* `since` is a `400`, deliberately not treated as zero: a
client whose cursor arrived as `"undefined"` would otherwise be handed the whole table
with no indication anything was wrong.

Paging follows the shape [`src/chat.js`](src/chat.js) already uses for exactly this —
a `seq` cursor, ascending, `hasMore: rows.length === limit` — rather than a new one.
`limit` defaults to 50 and caps at 200, matching `activity.js` and
`chat-oversight.js`; no more generous than those, because an outbox payload is
`MEDIUMTEXT` and a row here can be larger than a chat message.

**Every row is returned, whatever its status.** A row we gave up pushing is precisely
the one most worth being able to pull: if a permanently failed delivery also made the
data unreachable by replay, the failure would be doubled rather than recovered from.
Deduplication is the caller's, by the last `seq` they have seen, which is why status
has no bearing on what comes back.

It needs `events` in the client's `allowed_actions`, by the same rule that makes
`/ping` need `ping` — the action is the first path segment. **No exception is made
for it being a read**: `serviceAuth` has no method conditional, so the signature,
the credential and the action check all apply, with `GET` as the signed method and an
empty body. The idempotency middleware covers only `POST`, `PUT` and `DELETE`, which
is right — repeating a read changes nothing.

One thing to get right in the client: **the query string is signed**, because the
signature covers `originalUrl` rather than the path alone. Sign the URL you actually
request, `?since=` and all. It also means `since` cannot be altered in flight.

#### Why this worker claims its rows, and the chat sweep does not

This deployment runs **several Node workers against one database** — Passenger and
most cPanel setups do, which is what the studio deploys on, and this README says so
under [Settings: the value lists behind the dropdowns](#settings-the-value-lists-behind-the-dropdowns). [`src/chat-files.js`](src/chat-files.js) sweeps safely
under that with no claim at all, but the reason does not carry over: its work is
deleting a file, and a file another worker already deleted raises `ENOENT`, which is
the outcome it wanted anyway. **Idempotent work needs no claim.**

Delivering a webhook is not idempotent. Two workers picking up the same due row
send the same POST twice, to a system whose deduplication is not ours to assume. So
a row is claimed before it is sent, by the same conditional-`UPDATE` mechanism the
inbound side uses for idempotency keys: whoever the row matches for first has
already changed it by the time the other's `WHERE` is evaluated. Same problem, same
shape, opposite direction.

A claim can outlive its worker, so `sending` rows untouched for
`INTEGRATION_OUTBOX_CLAIM_SECONDS` (default 120, comfortably more than one
10-second delivery) are returned to the queue — with `attempts` left alone, since
that attempt was already counted, and with a fresh backoff rather than an immediate
retry: a row that took a worker down is exactly the one not to try again at once.

The periodic part follows the chat sweep exactly, which is still the right pattern
for it: a pass at startup before the first timer, `unref()` so a stopped server is
not held open, and a missing table treated as nothing to do. The startup pass is the
one that matters — a restarted process comes back holding rows that came due while
it was down.

No migration was needed for any of this. `integration_outbox` already had `status`,
`attempts`, `next_attempt_at` and `last_error`, and its DDL said a fourth state
would be "a row's value and not a schema change" — `sending` is that fourth state.

### There is no screen for it, yet

Credentials and addresses are set on the server by whoever runs the deployment.
That is not an omission: a door the application can open for itself is not a
door. A management screen would need its own permission on **Settings → Role
Permissions**, and that permission lands with the screen rather than ahead of it
— a toggle a Super Admin can flip that controls nothing is worse than no toggle.

Settings are in [`.env.example`](.env.example) under *The integration API*.

## Game Feedback: storage, and what a "round" already means

Storage only so far — four tables, one column and one status. Nothing reads them yet,
deployed on their own so the schema change and the behaviour that uses it are separate
releases.

### Rounds were already solved, and not where you would look

**A revision round in this application is a submission.** There is no rounds table and
no round counter:

- `currentRound()` in [`src/work-log.js`](src/work-log.js) is
  `COUNT(*) FROM asset_versions + 1`
- the Efficiency report's `rounds` column is
  `(SELECT COUNT(*) FROM asset_versions v WHERE v.asset_id = a.id)`
  ([`src/routes/reports.js`](src/routes/reports.js))
- `work_sessions.round` stores which submission a stretch of work belongs to

TL and CD feedback do **not** create rounds. Feedback sends the asset back, the artist
submits again, and *that submission* is the new round. So a fix for a game bug counts
as its own round by being submitted like any other work — the Efficiency report already
counts it, with no change to the report.

That is why `handoff_assets.round` and `external_feedback.round` **record** which round
they concern and never generate one. A second rounds mechanism here would have made the
Efficiency report wrong for exactly the work this feature exists to track, and wrong
silently, because the report would keep returning a number.
`tests/game-feedback-tables.test.js` guards that: an `AUTO_INCREMENT` on either column
fails it.

### The tables

| Table | What it holds |
|---|---|
| `handoffs` | one partial drop or Tech Art pass to Dev & QA — kind, build, CP stage, its own `status` |
| `handoff_assets` | what is in it: asset + round, the bug refs a fix resolves, and Dev & QA's `status` (`queued` / `received` / `integrated` / `returned`) |
| `external_feedback` | a bug from outside — source, reference, severity, note, sender, build, CP stage, link, plus `prev_status` and `prev_routed_to_id` |
| `asset_ingame` | one row per asset: build, CP stage, engine status, open bug count, link, `in_game_build_seq` |
| `assets.needs_tech_art` | boolean, default false |

Every status column is `VARCHAR` with a default, matching the eight others in this
schema — not `state`, not an `ENUM`, so a fifth value later is a row's value rather
than a migration.

**Two guards worth knowing about.** `external_feedback` has
`UNIQUE (asset_id, round, source, bug_ref)`: a retried call — the normal behaviour of
every integration that ever times out — must not raise one defect twice and send the
asset round twice for it. `bug_ref` is `NOT NULL DEFAULT ''` *because of* that key, not
for tidiness: MySQL permits any number of rows whose unique-key columns are `NULL`, so a
nullable `bug_ref` would leave feedback without a reference — the commonest kind — with
no guard at all.

`asset_ingame.in_game_build_seq` is the staleness guard. Reports about a build arrive
over a network from a system that retries, so they arrive out of order, and a write
describing build 41 can land after one describing 42. Every write is applied only when
its sequence is **newer** than what is stored — the same protection
`integration_outbox.seq` gives ordered replay, which `DATETIME` cannot, two writes in
one second having no order between them.

### The status vocabulary lives in five places, not three

`game_feedback` (amber `#d9822b`, deliberately not the `#e8402c` the two internal
feedback states share, and distinct from the brand red) had to be added to:

1. `STATUS_VALUES` in [`src/migrate.js`](src/migrate.js) — drives the CHECK repair on an
   existing database
2. the `chk_assets_status` CHECK in [`sql/schema.sql`](sql/schema.sql) — builds a fresh one
3. `STATES` in [`src/asset-workflow.js`](src/asset-workflow.js) — what the server reasons with
4. `STATUSES` in `public/index.html` — pinned to match the server's list exactly
5. `ASSET_LIST_GROUPS` in `public/index.html` — every status must appear in exactly one tab

While doing that: **the CHECK in `sql/schema.sql` had already fallen behind** — it was
missing `tl_approved`. Only a database built fresh from that file was affected, because
the startup repair fixes an existing one, which is precisely why it went unnoticed. Both
lists are now asserted to hold the same set.

It introduces no *transition*, so it owes nothing yet to `actors`, `refusal()` or the
`PHRASE` map — those are keyed by transition, not status. When the transition is built it
owes all three, plus `REWORK_STATUSES` in [`src/permissions.js`](src/permissions.js),
which is pinned to exactly two values and will fail until updated deliberately.

### The three screens that read it

**The asset panel** carries an **In game** line and a **Game feedback** list, both filled
by one call to `GET /api/assets/:id/game-feedback`. The line is the single `asset_ingame`
row — engine state, build, checkpoint, open bug count, and the link out to Dev & QA — and
it appears only once the build has reported something: an asset that has never been in a
build gets no heading rather than a heading saying so. Every `external_feedback` row is
listed, newest first, including the ones taken as notes against work already in flight,
and the fields shown are the ones that *source* supplies. QA and Dev work out of a bug
tracker, so the reference is the row's identity; Tech Art refers to a pass; a client has
no tracker of ours, so drawing "Bug —" against their note would invent a field they never
filled in.

**Pass to artist** and **Decline with reason** sit under it, and how they are gated is the
part worth reading. Everywhere else in that panel a control is gated locally, against the
`can_review_tl` flag the assets list decorates each row with — right for a board of forty
cards, and deliberately a *conservative approximation* of `canActAtTlGate`: it answers the
project half of the gate, skips the submitted-the-current-version guard, and answers true
on a project with nobody on its team. The standing to answer a bug report is that gate in
full, so the endpoint asks the state machine instead — `availableActions()` over the same
`contextFor()` the POST uses — and the page renders what comes back. There is no `can()`,
no `mayActAtTlGate` and no status comparison in `renderGameFeedbackBlock()`, and a test
fails if one appears: a second copy of the rule on the page fails silently, because
nothing goes red when a button is offered to somebody the server then refuses.

This is also the first caller `availableActions()` has ever had. It has been in
[`src/asset-workflow.js`](src/asset-workflow.js) since the machine was written, with "The
UI renders from this rather than keeping its own copy of the rules" above it.

**The board** needs nothing: the column is whatever `visibleStatuses()` returns, so adding
`game_feedback` to `STATUSES` was the whole of it. It is not in `RESTRICTED_STATUSES`, so
every role that can see the board sees the column — the artist about to be handed the bug
as much as the lead answering it.

**Pending Actions** gained one group, `game_feedback_lead`, which is the extension point
that route was written for ("`groups` is a list on purpose … another kind of pending item
is another entry in it"). Two things about it are easy to get wrong:

- A raised bug is **not routed to anybody**. `routed_to_id` is `NULL`, because Game
  Feedback is a *queue* like TL Review and `canActAtTlGate` is a predicate, not a resolver.
  So "waiting on me" is `status = 'game_feedback' AND routed_to_id IS NULL` plus the gate,
  asked per asset — not a routing column, which would have matched nothing ever, on a
  screen that looked like it worked. Passing to the artist routes the asset and takes it off
  the list; the status stays `game_feedback`, so a list built on status alone would keep
  asking for an answer already given.
- The group is built **before** the early return that answers "nothing is waiting on you"
  to anybody outside the project review workflow. A Team Lead holds none of
  `project.review_respond`, `_queue` or `_mine`, so inside that return this group would
  have been invisible to exactly the designation it addresses.

`pending.view` still decides whether there is a tab at all, and a Team Lead does **not**
hold it by default — that is the studio's toggle, switched on per designation in
**Settings → Permissions**, and it is left where it was.

### A game bug is a rework stage all the way through

Closed together, because they were one gap wearing three faces: `game_feedback` had been
added to a list and left out of the gate beside it, so each move existed and nobody could
make it.

**`submit` now has a transition from `game_feedback`**, landing in `pending_tl_review` —
the gate that answered the bug is where its fix goes back to. It is a separate entry rather
than `game_feedback` joining the first submit's `from` list, because the sentence in the
history is different: "resubmitted for team lead review" is what follows a lead's notes,
and this is a fix for something the build reported. Nothing creates a round; the version
row **is** the round, so the Efficiency report counts it with no change to the report.

`game_feedback` stays out of `ASSIGNEE_STATUSES`, and that is what makes the transition safe
to offer: `actors.assignee` admits the assignee here only while the asset is **routed** to
them, which happens when the lead passes the bug on. A bug still in the queue cannot be
answered by the artist submitting over the top of the decision.

**The clock had to move with it**, which was nearly missed. `STARTABLE` in
[`src/routes/assets.js`](src/routes/assets.js) gates which statuses a work session may open
in, and `game_feedback` was not in it — so a first cut of this allowed the fix to be handed
in and not clocked, which is a round the Efficiency report counts with no hours in it,
under-reporting exactly the work Game Feedback exists to track. Both now list it, with the
same handed-to-me guard CD Feedbacks has: a bug in the queue is the lead's to answer, so
starting work on it is refused until it has been passed on. (There is still no accept step
at this stage — `/start` evaluates `accept` only from Assigned and opens a session without a
transition from anywhere else, exactly as rework after a lead's notes has always worked.)

**`canHandOverInReview` gained a `game_feedback` case**, answered by `canActAtTlGate` — the
same gate that decides who may pass or decline the bug. `reassign_review` had listed the
stage since it was written and the screen offered it, so the refusal came from the switch's
`default`, reaching only `asset.assign_any`, the creator, or full access: not the lead who
had just passed the bug on and would need to reroute it if that artist went on leave. A test
now holds every stage on that transition's `from` list to having a `case`, so a stage added
later fails rather than quietly becoming unreachable.

**`public/index.html`'s `REWORK_STATUSES` is aligned to the server's three**, and that had to
come last. It gates the "Reassign to Same User" shortcut, which goes through the transition the
missing `case` was refusing — aligned first, the page would have offered a button the API
answered 403. The suite asserts the ordering as a property: every status in the page's list
must be one `reassign_review` accepts.

`tests/game-feedback-rework.test.js` covers all of it, including that a second round on the
same bug adds to the first rather than replacing it, and that the fix goes on through the
first gate like any other submission.

### Hold: your own task, or one you lead

`asset.hold` is `impliedBy: () => true` — every designation has always held it — so a lead
who could not pause a teammate's timer was **never missing a permission**. The gate was
`mine`: the asset had to be assigned to you, deliberately, and the route said why (a hold on
somebody else's work looks to them exactly like the app losing their session). The studio has
since asked for the narrower version of that authority, and this is it.

**Two conditions, both required.** The designation is one of four —
`team_lead`, `associate_team_lead`, `art_supervisor`, `associate_animation_supervisor` — **and**
the asset's project is one that person leads or supervises. Without the second it would read
"any lead may stop any timer in the studio", which is a far larger authority than the one
asked for; a test mutates that condition away and fails.

**Why a named list of role keys**, when hardcoded role checks are otherwise avoided here: the
set is not a group. `Supervision` holds six designations and only four were asked for —
`senior_team_lead` and `technical_manager` were not — so `group === 'Supervision'` would grant
this to two nobody asked about. It is one exported constant, `HOLD_OTHERS_ROLES`, with the
reasoning beside it, the same shape as `SHIELDED_ROLES` and `PROJECT_REVIEW_ROLE`. There is
also no plain `animation_supervisor` in the catalogue; the animation seat is
`associate_animation_supervisor`, which is what is named.

**"Leads or supervises" is narrower than the review team.** `reviewTeamProjects` unions three
tables including `project_coordinators`, because the review gate is open to all three. This
is a different question, so `HOLD_SCOPE_TABLES` is `project_team_leads` and
`project_supervision` only: one of the four who happens to be on a project's coordinator list
does not get somebody else's timer with it.

**Both gates, from one helper.** `canHoldAsset()` in
[`src/permissions.js`](src/permissions.js) is the route's authority, and the assets list
decorates every row with `can_hold_others` from the same two conditions. The page reads that
flag (`mine || a.can_hold_others === true`) rather than working the scope out itself — "which
projects do I lead" is a database question and the board has forty cards, and a second copy of
the rule in the browser is the exact gap this codebase keeps finding. `=== true` rather than a
truthy read, so an asset that arrives undecorated falls back to `mine` and lets the server
decide instead of silently gaining a control.

The widening rides **on** the permission rather than around it: `canHoldAsset` asks for
`asset.hold` first, so a studio that switches it off for a designation closes this too.
Everybody outside the four keeps `mine` exactly as before — including full access, because
holding is not an oversight act.

### Searching the roster

**Settings → Users**' search box matches, case-insensitively and on partial words: the
**name**, the **email**, and the **designation** — by the label as displayed ("Team Lead") or
by its key (`team_lead`). The term is trimmed and runs of whitespace inside it are collapsed
to one, because a name pasted out of an email arrives with a leading space or a doubled one
and neither should lose the person.

Three of those were added after a report of "can't search properly", reproduced field by
field first. `" Priya"` returned nothing, because the raw term became `% priya%` and asked for
a space *before* a name that has none. `"Priya  Raman"` returned nothing, for the same reason
one space further in. And `"Team Lead"` returned nothing, because the query looked at the name
and the email only — while the list displays the designation in its own column, which is the
field a reader is most likely to search by.

**Still not searchable, deliberately:** the manager and the project, which the list also
displays. Both arrive by a later join rather than from the `users` row, so including them
means restructuring the query rather than widening a condition, and the designation filter
beside the box already answers "everyone who is a Team Lead" without free text.

**The search runs on the server, over the whole roster** — `search`, `limit` and `offset` all
go with the request — so a term finds somebody who is not on the page being shown. A test
proves that with a page size of one. The status filter still governs what any term can reach:
somebody deactivated stays out of the default list however precisely they are named, and is
one filter away.

**The box has its own term.** It used to write `state.search`, which the Dashboard's asset
filter also reads — so typing a colleague's name in the Users tab filtered the *board* by it,
and because the asset search input was only ever read from and never written back, that box
looked empty while the board sat at "No assets match your filters". Two boxes, two terms, and
the board's box is now written back so a filter is always visible.

Two related findings, recorded rather than changed: the chat's "Search people…" matches the
name only while the picker shows the designation beside it — the same mismatch, though it does
trim and its list is the whole set rather than a page — and the **freelancer roster has no
search box at all**, which is a missing feature rather than a broken one.

### Assign to Freelancer: the failure was the dialog

Investigated end to end and the endpoint was sound: a Super Admin and a lead on the project
both get 201, and the asset then carries `outsourced_to`. Every refusal already named its
reason — off-project 403, no permission 403, an asset already staffed inside the studio 409
naming who holds it, an inactive freelancer and a wrong-project asset 422. Discipline is
**not** involved anywhere in the flow: `validateAssignment` and `checkRefs` never read it, it
is stored and displayed and nothing else, and a test pins that so a later change which starts
matching on free text has to say so first.

What was wrong was the one exit with no feedback. The agreed man hours were collected with
`prompt()`, and a browser that suppresses dialogs — Chrome and Firefox both do once somebody
ticks "prevent this page from creating additional dialogs", Chrome does outright in a
cross-origin frame — returns `null`, which the handler could not tell from Cancel. The click
did nothing, said nothing, and went on saying nothing. It is now an inline number field with a
`.ref-err` under it, like every other field in that panel, and a test asserts that **every**
early return in the handler sets a message.

### Pending Actions and the Team Lead: a default left alone

`pending.view` is not enabled for Team Lead, and it stays that way. It is not an oversight —
[`src/role-permissions.js`](src/role-permissions.js) grants it to exactly one designation
and says why:

> And the tab that shows them. Granted here rather than left off so the queue they are given
> is one they can actually open on day one; **every other designation is given it in
> Settings.**

with the paragraph above it adding that this is "only the starting position … Everybody else
is granted it in Settings, **which is where this decision belongs**". So a Super Admin
switches the tab on per designation, and `tests/game-feedback-panel.test.js` pins the
default so changing it would be a deliberate act.

Worth knowing when deciding: that rationale was written when Pending Actions held only the
project review workflow. It now also carries game feedback waiting on a lead, so the
audience for the tab has widened even though the default has not.

## Passwords

Rules live in [`src/password-policy.js`](src/password-policy.js) and are served
at `GET /api/auth/password-policy`, so the browser ticks off the same checklist
the API enforces and the two cannot drift. Currently: at least 10 characters,
with an uppercase letter, a lowercase letter, a number and a symbol. Change them
in that one file.

Anyone signed in can change their own password from **Profile** in the header.
The endpoint requires the current password, so a borrowed unlocked laptop is not
enough to lock the real owner out.

### Signing out other devices

`users.password_changed_at` records when the password last changed, and every
token carries the value it was issued under (the `pwd` claim). `authenticate()`
requires the two to match, so changing a password refuses every token issued
before it — the account's other sessions — while the browser that made the
change is handed a replacement and stays signed in.

This deliberately does not compare against the token's own `iat` claim, which
counts whole seconds: a token minted in the same second as the change cannot be
told apart from one minted just before it. Matching the stored value exactly has
no such boundary.

There is no email on password change, because the app has no mail transport. If
you add one, `POST /api/auth/password` is the place to send from.

## Tests

```bash
npm test
```

Runs on Node's built-in test runner — no test framework dependency.

**Two test files at a time, not one per core.** Seventy-six files in `tests/` start their own
server and run the whole startup migration against their own database. At the runner's
default concurrency that is four simultaneous boots on four cores and one MariaDB, and some
suite always loses the race: three consecutive full runs failed with "Server did not start"
in three *different* suites — `mis-project-access` at a 60s deadline, `auto-resume` at 150s,
`integration-outbox` at 300s — each passing on its own immediately afterwards. Raising the
deadline only moved which suite died.

Capping concurrency fixes it, and measured on this container it is also **faster**: 440s and
one expected failure, against runs that took longer and failed in three places while waiting
out boot deadlines. Override with `TEST_CONCURRENCY=4 npm test` on a bigger machine.

The policy tests are pure and always run. The endpoint tests need a database and
are skipped unless you name one, which is **dropped and recreated** on every
run, so never point it at real data:

```bash
TEST_DB_NAME=zvky_test TEST_DB_USER=root TEST_DB_PASSWORD=secret npm test
```

They start the real server as a child process and drive it over HTTP, covering a
valid change, a wrong current password, a mismatched confirmation, a password
failing each policy rule, reuse of the current password, an unauthenticated
request, other-device sign-out, and that no password reaches the logs.

`tests/ip-allowlist.test.js` covers the address restriction: matching and its
refusals as pure checks, then a live server where an allowed address gets in and
every other one meets the Access Denied page, a spoofed `X-Forwarded-For` does
not, sign-in itself is refused before any password is read, an address added
works on the next request, removing the entry covering the caller needs
confirmation, and each way back in — emergency address, bypass token, empty
list, kill switch, monitor mode — does what it claims. It also covers the
storage failing: that one failing schema repair no longer skips the ones after
it, that an unreadable list is never mistaken for an empty one, that the screen
explains the fault instead of returning a database error, that Repair recreates
the tables and enforcement resumes, and that fail-closed keeps the emergency
door open and is ignored when there is none.

### Suites that place a window relative to now

`tests/recording-schedule.test.js`, `tests/recording-hours.test.js`,
`tests/late-sweep-hours.test.js` and one case in `tests/working-hours.test.js`
all test code that reads the real clock — the
pause sweep, the automatic resume, and the seconds a session is credited with —
so their cases cannot use fixed dates. They say "the break started ten minutes
ago" instead, and build the window from that.

Doing that by hand made all three red for a band of hours either side of
midnight, for no reason but when they ran: ten minutes before 00:05 is not
`-1:-5`, twenty minutes after 23:50 is not `24:10`, and a window from 23:50 to
00:10 is one the four legacy Working Hours time pairs cannot express at all.
Reading the clock once per boundary also let a minute tick between two ends of
the same window.

So `tests/helpers.js` exports `studioMinute()` and `windowAgo()`: the clock is
read **once** per set of windows and both ends are derived from that one number,
which wraps past midnight and carries `spansMidnight` when it does. The windows
go in through Recording Hours, which has that flag. Anything new that places a
window relative to now should use those rather than subtracting minutes itself —
`tests/recording-hours.test.js` checks the builder against every one of the 1440
minutes a run could start on.

**A fourth suite had the same fault and was found the same way.** The downstream-
readers case in `tests/working-hours.test.js` placed its blackout at a **fixed**
00:00–01:00 and relied on a session backdated two hours straddling it. Between
midnight and one in the morning IST that blackout contains the present moment, so
`POST /start` opens the session and immediately puts it down again `off_hours` for
nought seconds, and the case fails with nothing wrong but the hour. It was
reproduced at 00:45 IST on an untouched tree before being changed. Its window is
now derived from one `studioMinute()` read, with the blackout from 90 to 30
minutes ago — wholly inside the span and wholly in the past, so an hour of the two
is cut out at every hour of the day.

Two details of that fix are worth copying. A window must end **after** now, not
at it: a span includes its start and not its end, so a window ending at the
present moment is one the present moment is outside. And it has to go in through
Recording Hours rather than the legacy four time pairs, because a window placed
relative to now can cross midnight and only the named windows carry the
`spansMidnight` flag that makes that storable.

## Packaging for deployment

```bash
npm run package
```

Writes `dist/zvky-backend-godaddy.zip`: the application and `.env.example`, with no
`.env`, no secret and no `node_modules` (cPanel installs those itself). Every setting,
the database password and `JWT_SECRET` included, is an environment variable of the app
on the host. See [DEPLOY-GODADDY.md](DEPLOY-GODADDY.md).

## Deploying for real

- Put this behind HTTPS. Never run it over plain HTTP in production.
- Rotate `JWT_SECRET` and the seeded demo passwords immediately.
- Consider forcing a password reset on first login instead of shipping a
  shared default password.
- Add a migrations tool once you need to evolve the schema instead of
  hand-editing `sql/schema.sql`.
- Back up the database. This is now the single source of truth for the studio.
