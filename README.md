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
[`src/permission-catalog.js`](src/permission-catalog.js) — 97 permissions in
twelve groups — and the settings live in `role_permissions` as
`(role_key, permission_key, enabled)`.

**"Off" is a row, not an absence**, and that matters more than it looks.
`role_permissions` holds one row per role per catalogue key, and `setForRole()`
writes **all** of them on every save. So a role that has been saved once carries
an explicit `enabled = 0` for every permission it does not hold — including the
ninety the administrator never looked at. `forRole()` reads `enabled = 1`; a role
with **no rows at all** is a different thing again (never seeded, so it is seeded
from its tier), and `topUpRole()` fills in keys added to the catalogue since the
role was last written. `updated_by_email` is the only hint at intent — `'system'`
for a seeded row, an address for one an administrator saved — and that is what
migrations use when they must not reverse somebody's decision.

Every key sits in the group its prefix names, and
`tests/role-permissions.test.js` checks that: a `settings.*` key in another
group would be the first exception. That is why the holiday calendar's two keys
are `settings.holidays_view` and `settings.holidays` rather than `holiday.view`
and `holiday.manage`.

**When a change takes effect: the next request.** The permission set is read per
request in `authenticate()` from the user's freshly-read role, so nobody signs
out and in again, and no session has to be refreshed. Moving somebody to another
role takes effect the same way.

### Role groups: an additive layer

**Settings → Role Groups** makes a named bag of permissions and puts roles in it.
Every member role inherits the bag. A role's effective permissions are **its own
plus the grants of every group it is in** — the union, computed in one place,
[`effectiveFor()`](src/role-permissions.js).

| | |
| --- | --- |
| **Groups only grant** | There is no group-level deny. A permission a group does not grant is one it has no opinion about, so nothing is ever *reduced* by a group — including Super Admin, which short-circuits above the group query and always holds the whole catalogue |
| **No nesting** | A group contains roles, never groups. One hop, so the answer is a single join and cannot cycle |
| **No capabilities** | Groups grant catalogue keys. `projectScope`, `reviewStage` and `deleteAsset` are values rather than booleans and stay with the tier |
| **Three kinds** | `department`, `level`, `custom` — a fixed vocabulary, because a free-text field becomes all three plus typos |

**Nothing changed when this shipped, and that is asserted rather than asserted-ish.**
`effectiveFor()` was recorded for all sixty designations *before* the feature was
written — `tests/fixtures/role-permissions-before-groups.json`, taken through the
real seeding path against a fresh schema — and the first test in
`tests/role-groups.test.js` demands it back key for key. The migration seeds no
groups at all, so an install that upgrades and never opens the screen has three
empty tables and identical access. The one permitted difference is the new
management key, and it is pinned too: `settings.role_groups` reaches Super Admin
and nobody else.

#### How an explicit role-level "off" interacts with a group grant

**A group grant is additive and is not blocked by `enabled = 0`.** A group can
re-grant a permission an administrator unticked on the role.

**This conflicts with the existing model, and the conflict is in the storage
rather than in the decision.** As above, "off" is a row that `setForRole()`
writes for every unticked key — so the data cannot tell "deliberately revoked"
from "never granted". Reading `enabled = 0` as a *deny* would therefore make
group grants useless for every role a studio has ever saved in Settings, which
is every role. The alternative — "role-level off wins" — needs a third state in
`role_permissions` (granted / silent / revoked) to be expressible at all: a
change to the storage and to what a save means, and the hard constraint on this
feature was that existing role permissions do not change.

So the behaviour is made **visible** instead of silent:

- each role's permission view marks every inherited key **from a group: *name***,
  and a key held only by inheritance says so;
- the checkbox stays bound to the role's **own** answer (`ownFor()`), so
  unticking it does not remove an inherited grant — and, just as important,
  saving the screen does not bake the group's grant into the role;
- deleting a group lists, per role and by name, what each one will actually
  lose — a role that holds a permission in its own right is not reported as
  losing it;
- every change is in `role_group_audit` and in the Activity Log.

#### What `impliedBy` does here, and what it does not

`impliedBy` maps a role's **tier capabilities** to its default permissions
(`baselineFor`). It is not a permission-to-permission implication, and granted
keys — a role's or a group's — are never expanded transitively: `effectiveFor`
in the catalogue is *baseline ∪ granted*. So group grants go through the same
path a role grant does — validated by `catalog.isPermission`, unioned by the same
code — and there is no extra expansion to mirror. The one derivation that exists
(`project.review_send` implies `project.review_mine`) lives in `defaultsFor()`,
which is about **defaults**, so neither a role grant made in Settings nor a group
grant triggers it. Same rule, same place, both layers.

#### The escalation rules

| | |
| --- | --- |
| `settings.role_groups` | Super Admin only by default, enforced with `requirePermission` on every route and `can()` on the page — never a tier check |
| Two keys no group may grant | `settings.permissions` and `settings.role_groups`. A group that could grant either could add its own members to a group granting everything. Swept by the migration as well as refused on the write |
| Your own ceiling | Nobody grants through a group a permission they do not hold themselves — read from `req.permissions`, which the server resolved for that session. So the screen **can** be delegated: a delegate's reach is their own permissions |
| Nobody is reduced | Groups only add, so no role loses anything by being in one, and Super Admin is untouched either way |

**Clean-up.** `role_group_members` and `role_group_permissions` both cascade from
`role_groups`, so deleting a group cannot leave an orphan — that is a property of
the schema rather than of a function remembering. Deleting a **designation**
clears its memberships (`roleGroups.forgetRole()`, called from the reference-data
delete path), because there is no foreign key to reference data — a designation
lives in a table that loads into memory, and `role_permissions` has never had one
either. The migration sweeps anything an older install left behind, guarded so
that an unloaded roles list does nothing rather than reading as "every membership
is an orphan".

**Cost per request: one more query, and it does not grow.** `grantsForRole()` is
a single join keyed on `role_key`, so forty groups cost what one costs. A missing
table reads as "no groups", because a feature arriving must never be the reason
somebody cannot sign in.

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

**Hold / Resume is the exception that proves the rule, and it is worth reading.** It is
gated on the server with `requirePermission('asset.hold')` on `POST /:id/hold` and
`/:id/resume` — and on the page with **nothing at all**. The page asks about `asset.hold`
nowhere: the server decides both controls per asset, sends the answer with its reason, and
the page draws what it is given. That is the end point of four reports of this button, each
of which found another hand-written copy of the rule that happened to agree with the others
while carrying none of their reasoning. `tests/hold-permission.test.js` drives the
permission off and on in Settings, asserting after each change that the server's answer and
what the page would draw move together — with the page's own lines lifted out of
`public/index.html` rather than reimplemented — and counts the page's mentions of the key at
**zero**, because that number going up is how a page-side copy gets back in.

Two things that suite also records, because they are easy to assume otherwise:
`asset.hold` is `impliedBy: () => true`, so **every** designation holds it until a Super
Admin turns it off — there is no role that lacks it by default; and holding that key is
still not permission to hold somebody *else's* task. A second key, `asset.hold_any`, is
what admits that, and its reach is exactly what the holder's own dashboard shows them — see
[Role groups: an additive layer](#role-groups-an-additive-layer)
[Secrets, and what must be rotated](#secrets-and-what-must-be-rotated)
[Sending email through Gmail](#sending-email-through-gmail)
[Hold: your own task, or anything on your dashboard](#hold-your-own-task-or-anything-on-your-dashboard)
[TL Approved has three ways out, and one of them goes back](#tl-approved-has-three-ways-out-and-one-of-them-goes-back)
for the per-status table, the matrix, and why project membership was the wrong scope.

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
| `timesheet.options` | **Super Admin** | Decide what the form offers everybody, and whether yesterday's sheet gates today's work |
| `timesheet.sub_options` | **Super Admin** | Curate the second dropdown under a category — the Idle remarks, training types, on-site clients — and its heading |

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
| Whether yesterday's sheet is required before today's work | **did not exist** | `require_previous_day`, **default off** |
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

### What a timesheet line against an asset is worth

**This person, that asset, that day's working hours — and nothing else.** A line
naming an asset is worth the time *this* person worked on *that* asset on the
*selected day* in IST **inside that day's working hours**, less whatever they
have already filed against it on that same day. The figure is **calculated and
enforced**, not suggested: the Hours field is locked in the form and
`hoursFor()` works the number out again on save,
so a request carrying nine files the three the timer recorded.

**The bug this replaced, and its exact shape.** The figure used to be
`workLog.recordedFor()` — `SELECT SUM(COALESCE(seconds,0)) FROM work_sessions
WHERE asset_id = $1 AND user_id = $2`, **a query with no date in it** — less
everything ever filed against the asset. So three hours on Thursday and two on
Friday put **five** in Thursday's locked field, *filed* five, and then refused
Friday's line with "all 5h recorded against that asset is already on your
timesheet". The day's own figure was computed and shown as a footnote beside the
number actually used. Both the form (`GET /api/timesheets/suggest`) and the save
(`hoursFor`) now read **one** function, `dayFigure()`, so a form that shows three
and a save that files five is not expressible.

**Why the day figure had been rejected, and why that reason is gone.**
`dayTotalFor()` originally dropped any stretch that ran past midnight — its
comment argued there was "genuinely no way to know how much of a stretch running
from Tuesday afternoon to Wednesday morning was Tuesday's" — so a per-day figure
would have lost those hours for good, and the whole-asset subtraction was how
they were made up. That premise was wrong: a session's worth is the span
**intersected with the studio's open hours**, and that intersection is additive,
so Tuesday's part is exactly computable.

**Midnight is not the boundary either, and that was the second wrong answer.**
The fix that replaced the whole-asset total split a stretch at **midnight IST**
and divided the row's stored `seconds` across the days on either side. For the
studio's actual shape — an artist who starts at 6:00 PM and finishes at 11:00 AM
the next morning — midnight gives about **6 h** and **11 h** of a seventeen-hour
night, when the answer is **1 h** (6:00 PM to the 7:00 PM close) and **1 h 30 m**
(the 9:30 AM open to 11:00 AM). The boundary is the **working day**, not the
calendar day.

**So the figure is an overlap, computed from the stamps.** `dayTotalFor(userId,
assetId, day)` in `src/work-log.js`:

- reads this person's sessions on this asset as **stamps** — `started_at`,
  `ended_at` — and never reads `work_sessions.seconds` at all;
- **clips** each one to the requested IST day, then hands the clipped span to
  `workingMsByDay()` in `src/working-time.js`, the same per-day walk
  `workingSecondsBetween()` does and therefore the same schedule the timer, the
  reports and `close()` are measured against;
- sums the overlaps. Time outside the open hours, inside a break, on a weekly
  off or on a holiday contributes **zero** — not because it is subtracted, but
  because there is no open window over it.

Four things follow, and each is pinned:

- **The sweep cannot change the answer.** Whether that night is one open row from
  6:00 PM to 11:00 AM, or the two rows the end-of-day sweep and the overnight
  auto-resume leave behind, both give 1 h and 1 h 30 m. Nothing in the
  calculation depends on where a row begins or ends.
- **The days add up to the session exactly.** The per-day figures for one stretch
  sum to that stretch's own working-hours total, because they are overlaps of
  the same windows rather than shares of a rounded number. Rounding happens
  **once, at display**; there is no per-day rounding to drift.
- **Paused time is excluded with nothing subtracted.** A hold *closes* a row and
  a resume opens another, so a pause is simply the gap between two rows.
- **A row entirely inside one open day** comes out at the working time it
  actually covers, which for an ordinary day's work is the ordinary answer.

Dividing a stored total by anything is gone, and with it the one case it existed
for: a **pre-cutover** row, written before `seconds` meant the open-hours
intersection, used to be apportioned by elapsed time. Those rows now go through
the same overlap as every other row, so a stored number that means something
else can no longer leak into a timesheet. That apportioning is the shape that
reproduces the figures this change was reported for: the same overnight example
on a pre-cutover row read **6.8 h** and **10.2 h**, because the stored seconds
were a wall clock being shared out rather than working time being measured.

**The hours it uses are the studio's own, read from settings.** No minute is
written into this code. `schedule()` is `workSchedule.trackingWindow()` — the
same cached read the timer, the pause sweep and the overnight resume take their
whole picture of the studio from: the named recording windows in
`recording_hour_configs` when there are any (and the `work_schedule` row when
there are not), `working_days` for the weekly off, `studio_holidays` for the
closures. As configured today that is
**09:30 to 19:00, Monday to Friday**, with **three** non-recording blocks, not
one: **lunch 13:00–14:00**, a **morning break 11:00–11:15** and an **evening
break 16:00–16:15**. All three are excluded, so a day worked straight through
from 09:30 to 19:00 is worth **8 h**, not the 9.5 h on the clock — which is the
`hours_per_day` the schedule also carries, and a useful check that the breaks
are being read. Change any of them in Settings and
every figure here changes with it; `tests/timesheet-working-day.test.js` sets a
deliberately odd schedule and asserts the figures follow it rather than the
studio's own.

**There is no history of the schedule, and a past day is recomputed under
today's hours.** `work_schedule` is a single row with an `updated_at` and no
validity dates, and `recording_hour_configs` has none either, so moving the
close from 19:00 to 20:00 tomorrow changes what last Tuesday was worth. The help
text under the figure says so in one line, because a person who notices a number
move deserves the reason. **Recommended, and not built:** record the schedule in
effect on each session as it closes — a small JSON column on `work_sessions`
written by `close()` — so a recalculation years later is stable. It is left out
because it is a migration plus a second read path on every consumer, which is
more than this change should carry; `src/holidays.js` already refuses a holiday
dated today or earlier for exactly this reason, so the schedule's past is
partly protected already.

**A running session** counts up to **now** for the day that holds now — the same
figure the timer on the panel shows — and never past the end of that working
day. For a day that has already ended it is **capped at the close of that day**
rather than run up to now, because an open row spanning a past day means the
sweep never closed it, and the response says so (`openCapped`) so the shortfall
is explained rather than discovered.

**The date is the server's business.** `GET /api/timesheets/suggest` takes the
day, validates it (a day that does not exist is a **400** — `toISO` accepts a
`Date` and an ISO instant on purpose and checks no calendar), and a **future**
day comes back as zero. The page sends the selected date and prints what comes
back; it holds no copy of the IST boundary, the working hours, the breaks or
the cap, and does no date arithmetic of its own. Each lookup
takes a ticket and the reply is checked against the date and asset the server
echoes, so a slow answer for the asset you just moved off cannot land in a
locked field. A failed lookup **says so** and hands the field back to be typed —
it used to be swallowed, leaving the previous asset's number on screen as though
it had been calculated. What it prints is the server's own sentence: *"Recorded
on this asset on 9 Oct: 1 h 30 m"*, in hours and minutes rather than the 1.5 the
field has to hold, with a second clause when a stretch ran outside the day
explaining that only the part inside the working hours is counted, and a third
when the answer is zero **because** everything that person did on that asset
that day fell outside them.

**Whose time it is.** Always the timesheet **owner's**, never the person looking.
`POST /entries` still writes `req.user`'s line whatever the body carries, so
nobody can file into somebody else's sheet; `/suggest` now takes an optional
`userId` so a lead reading a team member's week sees **that member's** figure
rather than their own, guarded by the same `mayRead` check the week itself goes
through — a `userId` you may not read is a **403**, not a quiet fallback to your
own hours. `dayFigure()` takes the owner's id as its first argument. Both halves
are pinned, including the refusal.

**Where the whole-asset total is still the right answer, and untouched:** Time
Spent on the Assets List (`workLog.totalsFor`), the asset panel and its
per-round history (`workLog.summary`), the Efficiency and Idle reports, Team
Capacity, and both P&L tabs. Those are what the *asset* cost across everybody
who held it. The timesheet no longer calls `workLog.recordedFor()` at all, and
`recorded` is gone from the `/suggest` payload — a timesheet context showing the
asset's total is the bug, not a nicety.

**Day and week totals, the week split and both exports needed no change:** they
sum `timesheet_entries.hours`, so correcting what gets *filed* corrects them all
at once. The previous-working-day gate counts *lines*, not hours, and is
likewise unaffected. Outsourced assets have no sessions at all, so the figure is
zero and the line is refused for the same reason any untimed asset is —
unchanged.

**The cost of the rule, stated plainly.** A day the studio does not accept lines
for — a Saturday, with `loggable_days` at Monday–Friday — can hold recorded time
that now has **nowhere to go**: Saturday takes no line, and Monday's figure is
Monday's own hours. Before, the Monday swept up the outstanding total. The two
ways out are both existing settings rather than new rules: turn Saturday on in
Settings → Time Sheet, or file the hours as project time **without naming an
asset**, where the figure is typed. The refusal names the day and points at the
second one. Pinned in `tests/timesheet.test.js` so it is a decision rather than
a discovery.

**Lines already filed are not rewritten.** Two read-only ways to see which ones
look affected. `npm run timesheet:check` recalculates every filed line against
an asset with **this** rule and reports the ones that differ, narrowing first to
the two shapes that can differ at all — a line whose sessions are pre-cutover, or
whose sessions cross an IST day — and `--lines` prints each one with the stored
hours, the recalculated figure and which shape explains it. It needs the
database, so it is run on the server rather than from here;
`sql/checks/timesheet-lines-over-recorded.sql` answers the weaker question — a
line whose hours exceed what that person recorded on that asset that day — in
plain SQL for when it cannot be. It is read-only on purpose: those hours are somebody's
own record of their day and pay and utilisation figures have been drawn from
them. **Recommended: review the list before correcting anything, and do any
correction as a separate reviewable migration** — the likely population is small
(it needs an asset worked on across more than one day, filed on the earlier one)
and the lines it touches may be in approved days.

### Yesterday's sheet before today's work

**Off by default, and switching it on blocks people straight away** — so the
checkbox in Settings → Time Sheet says that next to itself. On an existing
install nobody has been filling the sheet daily, so the morning it is switched on
is the morning the whole studio is refused its first Start. That is the intended
behaviour of the rule and it is still worth reading before ticking the box.

When it is on, a person who has not filled their timesheet for the **previous
working day** cannot start or resume a task. Filling it unlocks the Start button
**immediately, with no sign-out** — the page re-reads `/auth/me` every 20
seconds and the gate's answer rides on that response.

Two definitions carry the whole rule, and both live once in
`src/timesheet-gate.js` so that `/start`, `/resume`, the auto-resume sweep and
`/auth/me` cannot answer differently:

- **Previous working day** — the most recent day before today, in IST, that is
  both on `timesheet_settings.loggable_days` (the studio's own weekly-off list,
  Mon–Fri by default) and not on the holiday calendar. So Monday asks for
  Friday, and a Friday holiday pushes the demand to Thursday. It is
  `loggable_days` rather than `work_schedule.working_days` on purpose: the rule
  asks for a *timesheet*, and `validateEntry()` refuses a date outside
  `loggable_days` outright — a day the clock counts but the form will not accept
  is a day nobody could comply for. The two lists are identical by default.
- **Filled** — at least one line exists for that date. Any line: project,
  non-project, or **Idle**, which is what makes compliance always possible on a
  day with nothing to report. **A draft counts.** The draft/submitted
  distinction lives on `timesheet_days.status` and not on the lines, and
  submitting *locks* them, so reading "filled" as "submitted" would mean the
  only way to satisfy the rule was also the way to stop correcting it. It is
  not an hours threshold and not configurable: `max_day_hours` is a soft cap the
  form quotes, not a floor, and a floor would refuse somebody whose Tuesday
  honestly was three hours.

**Nobody is asked for a day they could not fill.** A user whose `created_at` is
after that day is not blocked. If `backdate_days` is set narrow enough to put
the owed day out of reach, the gate and the policy are made to agree rather than
left to deadlock: `validateEntry()` exempts the one day the gate is demanding
while the rule is on, and nothing else about the window moves. **There is no
leave mechanism in this application** — `leave` exists only as a non-project
timesheet category — so no leave handling was invented; somebody on leave files
an Idle or Leave line for the day, which is a line, which is filled.

**It fails open, everywhere.** A missing `timesheet_entries` table, an unloaded
holiday mirror, a query that throws: not blocked, with a line in the log. A rule
about paperwork must never be the reason the floor stops, and the case is pinned
against a live server with the table actually dropped.

**The refusal is a 409 with its own code,** `TIMESHEET_INCOMPLETE`, beside the
named field every other refusal here uses (`holiday`, `startsOn`, `opensAt`):
`timesheetGate: { date, dateLabel }`. The sentence names the day in words a
person can match to the day picker and says where to fix it. **The page never
recomputes the date** — it reads `timesheetGate` off `/auth/me` and links
straight to that day in the Time Sheet tab, because two copies of this date
arithmetic have come apart before.

**A session already running is never stopped.** The rule is about *starting*.
Switching it on mid-afternoon leaves every open timer alone; midnight passing
does the same. The auto-resume sweep in `src/work-log.js` does not resume into a
blocked state: the session **stays paused** and the reason is logged with the
user and the date owed, rather than being resumed and then refused.

**The switch is `timesheet.options`, not a key of its own,** because the checkbox
sits inside the Time Sheet Options form and shares its Save — two keys over one
form would let somebody hold one half of a screen. Super Admin only by default,
enforced by `requirePermission` on the server and `can()` on the page, never the
tier, and grantable in Settings like everything else. Every flip is in the
Activity Log with the policy as a sentence on both sides.

### The second dropdown: sub-options under a category

A non-project category can carry a list of **sub-options**, and when it does the
Add line form shows a second dropdown and the server requires a choice from it.
Seeded with the three lists the studio asked for:

| Category | Dropdown heading | Options |
| --- | --- | --- |
| Idle | **Idle Remarks** (theirs) | No Work to Assign · System Issues · Awaiting Client Feedback · Assigned work Completed · Assigned Work Late · Left Early · Late Login |
| Training | **Training Type** (ours) | Training 2D Art · Training 2D Animation · Training Game Design |
| On Site | **On Site Client** (ours) | CSR2 On Site · Scopely On Site · Scientific Games On Site |

**One mechanism, three seeded uses.** Nothing in the code names Idle, Training
or On Site to find their options — a category with rows in
`timesheet_sub_options` has a second dropdown, one without has none, and
attaching options to Leave tomorrow is three rows in Settings and no code. A
test greps the tree to keep it that way.

**It is a reference collection, not a second kind of list.** `timesheet_sub_options`
is an entry in `COLLECTIONS` in `src/reference-data.js`, so the add, rename,
reorder, deactivate, reactivate and the delete-that-refuses-anything-in-use all
come from the machinery Prompt 24 already used, through one route and one
Settings panel. Two things the parent changes, and only two: a **duplicate label
is checked within its category** (so "Awaiting Client Feedback" under Idle does
not block one under Leave), and the **key carries the parent** —
`idle_left_early` — so it stays unique across the table and every other function
in that module works unaltered. `training_training_2d_art` is clumsy and
deliberate: it is what the ordinary key rule produces, so a seeded option and an
admin-added one are indistinguishable afterwards.

**On Site is new.** Two of the three categories existed; On Site did not, and a
sub-option with no parent is not a thing. It is seeded as an ordinary category —
renameable and retirable, **not** `is_system`, because nothing keys on it (Idle
is protected because the week's totals count it separately).

**The labels are the studio's, spelling and all.** "Assigned work Completed"
beside "Assigned Work Late" — the inconsistent capital is theirs, and
normalising it quietly would be deciding something they can decide themselves.
Renaming either is one click and changes nothing stored. Note also that
*Awaiting Client Feedback* is **also a workflow status name**; the two are
unrelated and live in separate namespaces, and nothing matches on label text —
the line stores `idle_awaiting_client_feedback` and the status is
`awaiting_client_feedback` in `assets.status`.

**What the server enforces** (`validateEntry`): a category with active
sub-options requires one; the option must belong to that category (a Training
line with an Idle remark is refused); a category with none refuses one; a
project line never carries one; unknown, inactive and cross-category options are
refused on create *and* on edit.

**Legacy lines stay valid and editable.** Every line filed before this has
`non_project_sub` NULL. The edit path hands `validateEntry` the line **as
stored**, and when the category and the option are both unchanged the pair is
taken as given — so correcting the hours or the notes on an old Idle line demands
no remark, and a line holding a since-**retired** option keeps working. Change
the category, or pick a different option, and the full rules apply. A retired
option still resolves for display (marked *inactive* on the line) and cannot be
chosen for anything new.

**Storage.** The line stores the **key**, never the label, so a rename changes
how every old line reads and breaks no report; the label is resolved at read
time from the in-memory mirror, which is why a retired or renamed option still
resolves. The dropdown's **heading** is data too —
`timesheet_categories.sub_label` — so "Idle Remarks" can be renamed in Settings
without a deploy. The migration follows the idempotent pattern: the table is
created by the reference-table loop, the options are seeded **by key** through
`seedReferenceTable` (so a renamed or deactivated seeded option is never
reverted), and the headings are written only where the column is still NULL.
Running it twice creates one copy of each and touches no existing line. One
subtlety: a seeded option an admin **deletes outright** does come back on the
next boot — deletion is only possible while nothing uses it, and "the studio's
list, restored" beats "silently gone for ever". Deactivating is the documented
way to retire one.

**Its own permission,** `timesheet.sub_options`, Super Admin only by default and
grantable per designation. Separate from `timesheet.options` because the two
cost different things: that key decides what the studio may log at all and how
far back, this one curates the words inside a category somebody already has. The
server enforces it through `PERMISSION_BY_PATH` on every sub-option route; the
page gates the Settings panel with `can()` on the same key, never the tier.
Nobody needs it to *use* the dropdowns — those come with `timesheet.own`.

**Consumers changed:** the Add line form (the second dropdown), the filed-line
display (the remark beside the category, with an *inactive* marker), both
exports (one `Option` column beside `Category` — the heading differs per
category and a spreadsheet gets one column), the audit trail (`Idle — Left
Early`), and the Idle figure, which now carries a breakdown by remark wherever
it is already shown apart (`idleByRemark`, heaviest first, unexplained hours
last as *not stated*). **Left alone:** `kindOf` and the three-way split — a
remark does not change what kind of time a line is; the day and week totals,
which sum hours; the Efficiency and Idle reports, Team Capacity and both P&L
tabs, which read `work_sessions` and never saw a category; and the
previous-working-day gate, which counts *lines* — an Idle line with a remark is
a line, exactly as before.

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

### Two permissions called "Mark as Delivered", reaching one state two ways

This is the one pair in the catalogue most likely to be confused, so it is
written down rather than left to be worked out from the labels.

| Key | Transition | Means |
| --- | --- | --- |
| `review.deliver` (Review group) | `deliver`: `approved_for_client` → `delivered` | **The client has the work,** after the studio's own review. |
| `outsource.deliver` (Outsourcing group) | `outsource_delivered`: any eligible status → `delivered` | **Staff attest a freelancer's work was handed to the client or accepted internally.** |
| `outsource.reopen` (Outsourcing group) | `outsource_reopen`: back to `not_started` | **Undoing one of the above.** Its own key; see below. |

**They land in the same state, and that is a studio decision that reversed this
feature's original design.** For two commits `outsource_delivered` targeted
`pending_tl_review`, on the reasoning that a freelancer's hand-back is a
*submission* nobody inside the studio has reviewed, so recording it as Delivered
would tell every board and every "open work" query that the client had something
unseen. The studio overruled it: only staff can attest what happened outside the
studio, and marking delivered is that attestation.

**So what still has to be true is not disjoint destinations — it is that they
remain two transitions.** Separate source lists, separate actors, separate
permissions. One loosened transition serving both is the change that would let an
ordinary asset skip review to Delivered, and `deliver` is asserted unchanged
(`from: ['approved_for_client']`, actor `deliverer`) for exactly that reason. An
ordinary asset cannot reach Delivered any way it could not before, and
`outsource_delivered` is unreachable for one because the endpoint takes
**assignment** ids.

**It skips stages, deliberately.** A task marked delivered from In Progress jumps
TL Review, TL Approved, CD Review, Approved for Client and Awaiting Client
Feedback in one move. Nothing downstream assumes it passed through any of them —
checked, not hoped, and **nothing was back-filled**: no fake review round, no
invented `awaiting_client_feedback` step, no synthetic `deliver` event.

| Consumer | How it tolerates the missing stages |
| --- | --- |
| Feedback rounds | `feedback` rows are written by the review routes; none exists and none is required. `feedbackLifecycle.onTransition()` is a no-op without an open bug |
| Review counts | `COUNT(asset_versions)`, which is 0 and reads as "never submitted" — true of outsourced work |
| **Efficiency report** | excludes outsourced tasks **by name** before asking anything else (*"outsourced — no tracked time"*), so no average, hour total or turnaround figure moves |
| Turnaround timestamps | `finishedAt` COALESCEs the last `deliver` **event** then the last version; this action is `outsource_delivered` and there are no versions, so it is NULL and a date-filtered report omits the row — the same answer the exclusion gives |
| P&L `recordedHours` | sums `work_sessions` on delivered assets; an outsourced task has none, so it adds nought hours. The agreed hours and their cost come from `outsource.costFor()` |
| Project lifecycle | `ASSET_DONE = 'delivered'`, so a delivered outsourced task now lets a project be closed — the one consumer whose **answer** changes rather than staying the same, and correct under the new meaning |
| Dev & QA | `IDLE_STATUSES` includes `delivered`, so a bug raised on it pulls it into Game Feedback. Correct: it shipped and came back |
| Open-work counts | `routes/idle.js` and `routes/projects.js` exclude `delivered`, so a delivered task stops counting as somebody's open workload |

**The one thing that is now unreachable:** nothing reviews a freelancer's work
before it counts as delivered. That was the point of the old destination and it is
the cost of the change, recorded here rather than discovered later. `delivered` is
terminal — the only transition out of it is `outsource_reopen`.

**Delivering twice is refused twice over**: by `isDeliverable()` on the
assignment, which names the date it was already delivered on, and by the
transition's own source list, which does not contain `delivered`.

**Who picks it up next: nobody.** That was the old destination's answer — a team
lead, through the review gate they already stand at — and it no longer applies.
Delivered is terminal, so a lead's Approve on a delivered task is refused by the
table. Staff attesting delivery *is* the check.

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
own action id **per stage** — `outsource_delivered`, `outsource_completed`,
`outsource_reopen` — so the two deliveries stay countable apart and "how often is
a delivery reopened" is a question the log can answer.
The endpoint lives in `src/routes/assets.js` beside the other two bulk routes,
above every `/:id/...` route: Express matches in definition order, and it is also
where `contextFor`, `workflow.evaluate` and `applyTransition` live. It takes
**assignment** ids, not asset ids, because the Outsource tab's rows are
assignments and an assignment need not name an asset at all — ad hoc work moves
its own status and reports `movedAsset: false` rather than implying a transition
that did not happen.

**Two gates on the server, and both earn their place.** The key is asked once, up
front, and answers 403 for somebody who does not hold it — and it is the gate the
page mirrors with `can()`. It is asked **in the handler rather than as
middleware**, because one endpoint now serves three stages and the key depends on
which stage the body names (`STAGE_PERMISSION` in `src/routes/assets.js`), which
middleware cannot read. The per-row `canDeliverOutsourced()` /
`canReopenOutsourced()` is the *reach*: `projectScope` is per project and
middleware cannot ask it either, so a lead recording a mixed batch gets the half
on their own projects and a named refusal on the rest.

### Freelancers have no logins, so our own staff move the stages

The fact the outsourced lifecycle is built on, and the one worth knowing before
touching any of it: **nobody outside the studio ever clicks anything in this
application.** The Assigned work list on the Outsource tab is an internal record,
and every stage an outsourced task passes through is recorded by a member of staff
*on the freelancer's behalf*.

**That is why the assignee gates could not be used, and were not widened.** The
pipeline was written around the person doing the work being the person clicking —
`actors.assignee`, `ASSIGNEE_STATUSES`, `STARTABLE`, `mayStartWork`,
`canHoldAsset`, and the page's mine-style checks all read `assignee_id`. An
outsourced task has **no** `assignee_id`, by the exclusivity rule in
`src/outsource.js`. Traced against a running server, each gate does this:

| Gate | On an outsourced task |
| --- | --- |
| `POST /:id/start` | 409 for a full-access reader (`not_started` is not in `STARTABLE`), 403 for everybody else (`mayStartWork`) |
| `POST /:id/submit` | 403 for **everybody**, including a Super Admin — `actors.assignee` has no tier bypass, by design |
| `POST /:id/hold` | 403 — `canHoldAsset()` returns false when `assignee_id` is null |
| `work_sessions` | none, ever |

Widening any of those would have changed ordinary work, so the stages are three
**new** transitions with their own actors instead, and
`tests/outsource-stage.test.js` pins the old gates to exactly the answers above.

**Where a stage can be recorded from, and the assumption that was wrong.** The
three transitions started out with `from: ['not_started']`, on the reasoning that
outsourced work always sits in Not Assigned. A studio proved otherwise: a lead
dragged an outsourced card to In Progress on the board — a free move among
`FREE_STATUSES` that asks nothing about outsourcing — and **both Mark completed
and Mark delivered then refused that task for ever**, with a message that blamed
the freelancer. The list is `OUTSOURCE_STAGE_FROM` in `src/asset-workflow.js`:

| Allowed | Why |
| --- | --- |
| `not_started` | Where outsourced work belongs, and where a new assignment leaves it |
| `assigned`, `in_progress` | Meaningless with no internal assignee, but reachable by a board drag. Here for the rows that drifted before normalisation existed |
| `tl_changes_requested`, `cd_changes_requested` | A rework sent outside — legitimate, confirmed reachable, and *not* normalised away because "a lead asked for changes" is information `not_started` would destroy |

Excluded, each for its own reason: `pending_tl_review` (an artist has handed this
in — it is in the studio's own pipeline, and it is one of the two states
`outsource_reopen` reaches instead), `tl_approved`
(a lead has accepted it; a hand-back would unsay a studio decision),
`pending_cd_review` (the director has it), `game_feedback` (a Dev & QA round with
its own lifecycle), `approved_for_client` (this would push approved work backwards
into review), `awaiting_client_feedback` (the client has it), `delivered`
(closed — never).

**Delivering twice is refused somewhere else**, and that separation matters: it is
a question about the *assignment*, answered by `isDeliverable()` and
`isCompletable()`, not about the task's status. Both halves have to pass.

**And the status is only half the rule.** Widening the list let through a case the
old `['not_started']` had been blocking by accident: unassign the freelancer, let
an artist pick the work up, and the task sits in `assigned` — which is *on* the
list — so a stale assignment could hand back work somebody inside was doing. An
existing test caught it. The real invariant is the exclusivity rule, so
`freelancersToAct()` refuses any task that has an internal assignee, whatever its
status, with its own sentence: *"CHR-002 is assigned to somebody in the studio
now…"*.

**The cause as well as the symptom.** Sending work outside now calls
`outsource.normalise()`: a task in `assigned` or `in_progress` goes back to
`not_started`, any open work session is **closed** (seconds computed and kept — an
artist who worked two hours before the job went outside keeps those two hours),
and the move is recorded as an `override` event so it is not a mystery later. A
rework status is deliberately left alone. **No backfill of existing rows** — the
allow-list accepts them, and a rewrite of production statuses is irreversible and
would alter history. `docs/outsourced-status-audit.sql` is the read-only query for
counting what is out there.

**No clock on outsourced work, for anybody.** This was a real hole, found by
reproduction rather than by reading: `in_progress` **is** in `STARTABLE` and
`mayStartWork()` lets full access past the assignee check, so a drifted outsourced
task could be started by a Super Admin and the studio's clock would run against
somebody it does not employ. `POST /:id/start` and `/:id/resume` now ask
`activeForAsset()` **first** and refuse with no full-access exemption. Ordinary
work reaches every gate below it unchanged.

**Three stages, two real states and one reversal.**

| Transition | Moves the task | Says |
| --- | --- | --- |
| `outsource_completed` | `not_started` → `not_started` — **nothing moves** | The freelancer has finished |
| `outsource_delivered` | any eligible status → `delivered` | Staff attest the work went to the client or was accepted internally |
| `outsource_reopen` | back to `not_started`, stamps cleared | One of the above was a mistake |

**Completed and Delivered are two states, not one, and that is a decision.**
Finishing is something the freelancer did; handing on is something the studio
decides. A studio that collects its hand-ins on a Friday needs to record the
first without doing the second — so Completed moves no asset status at all (its
`to` *is* its `from`) and reports `movedAsset: false`. **Marking straight from
Assigned to Delivered in one action is supported**, not a shortcut around a
required step: `isDeliverable()` accepts a row nobody marked completed.

**Every stage is a transition, and none of them writes a status.** The route runs
`workflow.evaluate(STAGE_ACTION[stage])` and `applyTransition`, then records the
assignment's own half — so the asset's history row and the Activity Log entry come
from the same place every other status change in the application comes from.

**None of the refusals says "by the freelancer" any more**, and that wording was
not a detail: a member of staff who had just clicked Mark completed was told the
freelancer could not do it. Each now names what the action needs and what the task
is — *"An asset in \"TL Review\" cannot be recorded as completed — the task has to
be in Not Assigned, Assigned, In Progress, TL Feedbacks or CD Feedbacks."* — and
the status list in the sentence is **generated** from the allow-list, so a message
cannot promise a status the table refuses. The page's history labels went the same
way (`Outsourced work delivered`, not `Delivered by the freelancer`, which named
the wrong person beside the avatar of whoever had acted). `outsource_reopen` keeps
its freelancer in both places, because *"sent back to the freelancer"* is about
where the work goes, not about who clicked.

**The history sentence names both people**, which is the whole point of a record
of an act done on somebody's behalf: *"Marked delivered by Priya on behalf of Ravi
K."* Built by `onBehalfOf()` in `src/asset-workflow.js` and written as the event's
`note`. It degrades rather than printing `undefined` when either name is missing.

**`completed_at` / `completed_by` and `delivered_at` / `delivered_by`** are
recorded on the assignment, and the reversal **clears all four** — a cleared stage
with a stamp still on it would be a record contradicting itself. The stamps are
rendered through `istStamp()`, in IST: `mysql2` hands a `DATETIME` back as a
`Date`, and `String(d).replace('T', ' ')` strikes the T of "Tue" — which is how a
refusal once read *"on  ue Oct 06 2026 ."*

**The reversal has its own permission.** `outsource.reopen` defaults to
`user.delete`'s eight designations rather than `outsource.manage`'s twenty-five: it
is the only control on that tab that rewrites a record somebody else wrote. A team
lead records stages all day and cannot unrecord one. Grantable, so a studio that
finds that too strict says so in Settings.

**No timers, and therefore no zero-hour work.** The studio does not run a clock on
somebody it does not employ, so an outsourced task has no work session ever — and
the STARTABLE lesson from the Game Feedback work is that a round recording nought
hours silently under-reports. So every hours-based surface was checked:

- **Efficiency** excluded it already, but *as* "never submitted", which reads as
  somebody having forgotten to hand the work in. `exclusionReason()` names it
  first now — *"outsourced — no tracked time"* — and it stays out of every average
  and both hour totals, so an 8-hour estimate never sits against nought spent.
- **Team capacity** and the **Idle report's** waiting list key off `assignee_id`,
  which an outsourced task has none of. There is no person to show nought against.
- **The P&L** carries the decided hours and their cost as their own figure
  (`costFor()` in `src/outsource.js`), so outsourced work is hours *somewhere*
  rather than hours nowhere.
- **The work-hours sweep** only touches open sessions, and there are none.

**On the tab:** per-row *Mark completed*, *Mark delivered* and *Reopen*, each
behind its own key and its own predicate; the stage as a badge with who recorded
it and when; a chip row that filters by stage and, unfiltered, groups the rows
under a heading per stage so finished work sits below work still out; and the
checkbox selection with bulk *Mark as Delivered*, whose confirmation names the
count **and the freelancers it is acting for**.

**The tab gates on the server's list, and holds no copy of it.** It used to ask
only about the *assignment's* status, so it drew Mark completed on a task in TL
Review and let the server refuse it — the same control-offered-then-withdrawn
shape as the `REWORK_STATUSES` and `canHandOverInReview` drift before it. The
assignment row now carries `assetStatus` and `assetAssigneeId`, the payload carries
`stageFrom` (straight from `OUTSOURCE_STAGE_FROM`), and `osStageReachable()` reads
it. A test fails if the page ever grows a literal copy of the list, and another
runs the real renderer for every allowed and excluded status.

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

   TL Approved --tl_to_cd--> CD Review                 (the ordinary route on)
   TL Approved --tl_send_to_client--> Approved for Client   (needs review.tl_send_client)
   TL Approved --tl_submit_feedback--> TL Feedbacks    (needs review.tl_feedback — back to the artist)
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

### TL Approved has three ways out, and one of them goes back

**Two of them send the work on** — to the Creative Director (`tl_to_cd`), or past
them to the client (`tl_send_to_client`, which needs `review.tl_send_client`).
**The third sends it back:** *Submit Feedback* moves the asset to **TL Feedbacks**
with the changes required, and the artist reworks it.

**Why it had to exist.** `tl_request_changes` is defined `from:
['pending_tl_review']`, so once a lead has approved the work that move is used
up. A lead who approved and then spotted something had nothing to click: the
fault went on with the work, or somebody reassigned the asset to fake a round.

**It lands in the stage that already existed, and that is the whole design.**
`tl_changes_requested` is already in `ASSIGNEE_STATUSES`, `REWORK_STATUSES`,
`WORKING_STATUSES` (so the clock runs on the rework), `HAND_OVER_STATUSES`, the
page's hold list, its start list and its Assets List groups. A second
"feedback-after-approval" status would have been a stage every one of those lists
had to learn about, for a difference nobody acts on.

**And it writes the feedback row the review route already writes** — `feedback`,
`stage` `tl`, `decision` `changes_requested`, `given_by`, `text` — so the
artist's "Feedback to address" box and the Review feedback list render it with no
change to either. There is **no attachment system here because there is none
there**: the `feedback` table has no attachments column, and the one table that
does (`external_feedback`, for a bug from the build) belongs to the Dev & QA
integration and is a different mechanism. Nothing new was invented to avoid
inventing a second one.

**The loop, end to end.** Lead approves → *Submit Feedback* → **TL Feedbacks**,
routed to the artist whose work it was (`routeTo: 'assignee'`, the same resolver
the decline at TL Review uses) → the artist starts the clock and submits → **TL
Review** → approve → **TL Approved** again, where all three buttons apply. The
second pass is the first pass, which is what makes the button safe to offer more
than once. `tests/tl-feedback.test.js` walks exactly that against a live server
and asserts the rework's seconds were recorded, because a round that could be
handed in but not clocked would be a round the Efficiency report counts with no
hours in it.

**No round is created by asking.** A round in this application is a
*submission* — the reports count `asset_versions` rows — so neither way of asking
for changes creates one, and the artist's resubmission creates exactly one
whichever asked. Double counting is not prevented, it is **not expressible**.

**Two cases are refused rather than routed, and the order matters:**

| | |
| --- | --- |
| **Out with a freelancer** | A freelancer has no login, cannot read the note, cannot run the clock and cannot submit. Refused, naming them, and pointing at the Outsource tab's reopen — which is the right action for sending a freelancer's round back |
| **Nobody assigned** | TL Feedbacks sits on a **desk**. Routing it to nobody is how work disappears, so it is refused and says to assign it first |

Outsourced is asked **first**, and that is a lesson taken whole from
`src/asset-hold.js`: an outsourced task has no internal assignee, so the
unassigned check would catch it and answer *"nobody is assigned"* — naming a
person who does not exist and hiding the real reason.

**The rule is stated once.** [`src/tl-feedback.js`](src/tl-feedback.js) is the
Hold button's arrangement adopted from the start rather than after four reports:
one pure function, returning a **reason** rather than a boolean, asked by the
route with its own facts and by the board with the facts it already has batched,
and sent per asset as `feedback_state` beside `hold_state`. The page reads that
one property — `fbState.canSubmit === true` — and a test asserts the button's
code contains no `can(`, no `mayActAtTlGate`, no `assignee_id` and no
`outsourced_to`. The two older buttons at this stage still mirror their actor by
hand; this one does not, and that is deliberate.

**The feedback is required, with a floor and a ceiling.** 12 characters at least
(*"fix it"* is not changes required, and a rework round costs an artist a day) and
2000 at most (what stays readable in the drawer and the history panel — the
column is `TEXT`, so this is a judgement, not storage). Both numbers are
exported, travel to the page inside `feedback_state`, and are what the modal's
counter and the server's validator both read, so "too short" means the same thing
in both. Whitespace is trimmed **before** measuring, and the trimmed text is what
is stored.

**The modal is the page's own**, never `prompt()`/`confirm()`/`alert()` — those
throw in the desktop application, which is how the Hold button came to "do
nothing" there. `openAsk()` gained a text area, a live character count and
"disabled until it is valid" for this, so every future question can have them;
Enter inside the box is a new line and Escape cancels. On success the card moves
to TL Feedbacks **from the server's own copy of the asset** (`applyAssetUpdate`)
with no reload and no second fetch; on failure the question stays up with the
server's reason inside it and the typed feedback still there. `npm run
smoke:feedback` in `desktop/` asserts all twelve of those claims in a real
Electron window.

**The history line is its own.** `tl_submit_feedback` is a separate action from
`tl_request_changes` because the question *"was this spotted before or after we
approved it"* has to stay answerable from history already written. The server's
sentence names the person and quotes the feedback — *"Feedback submitted by
Priya: The rim light reads flat…"* — and the whole text is on the `asset_events`
row as `note`, which the history panel renders under the line.

**And the artist is told.** Nothing in this application raised a notification
when a reviewer asked for changes — the only asset notification from the review
routes was `submitted`, travelling the other way. `changes_requested` is one kind,
one row, raised to the id the transition actually routed the work to, after the
commit (the bell is a courtesy; the feedback is the record) and with **no feedback
text in it**, for the same reason a chat mention carries no message body: it is
rendered on a lock screen. The existing decline at TL Review still raises nothing
— widening that was not asked for and is a behaviour change to an existing path,
so it is flagged here rather than made quietly.

### Permissions: `review.tl_feedback`

Its own key, **on by default for exactly the designations that hold
`review.tl`** — asserted designation by designation in
`tests/asset-workflow.test.js`, so on the day it ships every lead who can approve
work can also send it back and nobody gains or loses an action. What the separate
key buys is the **switch**: a studio that wants coordinators to pass work on but
not to unsay an approval has somewhere to say so. Deliberately *not*
`review.tl_send_client`'s default of full access alone — skipping the Creative
Director sends work out of the review path irreversibly, while this sends it back
to the artist who did it and their next submission returns it to the same gate.
The actor needs **both halves**, exactly as `tlClientSender` does: standing at the
gate (`review.tl`, through `canActAtTlGate`, which carries the project scope) and
this key.

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



### The board's columns, and the column that was superseded

**The board's columns are exactly the statuses**, and after a brief detour they
are again. Everything here is about the tab labelled **Dashboard**, which is the
per-project board (`data-tab="board"`, `renderBoard()`); the permission-gated
**Admin Dashboard** is a different screen.

**The detour, recorded because the machinery it left behind is still in use.**
When `outsource_delivered` targeted `pending_tl_review`, a freelancer's hand-back
sat in the TL Review column looking exactly like an artist's submission, so the
board grew an extra column — *Back from Freelancer* — to tell them apart. The
delivery now targets `delivered`, a column the board has always drawn, so there is
nothing left for an extra column to claim. `BOARD_EXTRA_COLUMNS` is **empty**, and
`workflow.OUTSOURCE_DELIVERED_COLUMN` survives only as a named record of the old
destination — its `from` is what `docs/outsourced-delivery-audit.sql` looks for
when counting rows that predate the change. **It was never a status** (its id is
deliberately absent from `STATE_IDS`), so there is no state to retire and no row to
rewrite. Once that query returns nothing on the studio's own database, the constant
and the empty-extras machinery can go together.

**The machinery stays, though, and earns its place.** `boardColumnOf(asset)`
returns **one** id per asset — the first extra column that claims it, or its
status — and the board, its counts and the stats band all ask that one function. A
card cannot be in two columns because there is one answer, and cannot be in none
unless its answer is missing from the column list, which
`tests/board-delivered.test.js` fails on for **every** status the server can set.
With the extras list empty that id is simply the status, which is what this page
did before any of it.

**What a delivered freelancer card shows.** The freelancer's name and the
delivered date, with who *recorded* it in the hover — the card answers "whose work
is this", the history answers "who entered it". The line is keyed on the
assignment's own stage, not on a column, which is why it survived the column it
was written for. **No hours figure** on those cards: `man_hours` is the estimate
and no card has ever shown tracked time, but "24h" printed above "Ravi K." reads as
hours Ravi logged, and there is no such figure.

**The consumers, and what each needed.** Almost nothing, which is the point of
re-pointing at a status the application already knew:

| Consumer | What was needed |
| --- | --- |
| `renderBoard()` columns and counts | **nothing** — `delivered` has always had a column |
| `cardHTML()` | the freelancer line re-keyed off the assignment instead of the removed column |
| `#stats` band | **nothing** — it counts by `boardColumnOf()`, which is now the status. *Final %* now includes outsourced deliveries, which is correct: the studio has attested the work went out |
| Art/Animation lens + sub-tab counts | **nothing** — the lens is applied to the whole pool before columns |
| `filteredAssets()` | untouched; shared with the Assets List |
| Assets List, `ASSET_LIST_GROUPS` | **nothing** — `delivered` is in the Archived group, so a delivered task moves out of Active, which is right |
| Admin Dashboard `stageCounts` | the Prompt-27 split **reverted** — one row per status again, counted once under Delivered |
| Admin Dashboard `waitingCounts` | **nothing**, and it now stops counting the task: a delivered asset waits on nobody |
| Admin Dashboard `lateRows`, `upcoming` | **nothing**, and they now exclude it: `delivered` is `DONE_STATES`, so a delivered task cannot be overdue |
| `renderPipeline` / `pipelineTotal` | **nothing** — they render whatever rows the payload carries |
| Pending Actions | **nothing** — it reads `project_reviews`, not asset statuses |
| `routes/projects.js`, `routes/idle.js` | **nothing**, and they now exclude it from open-work counts |
| Reports and exports | **nothing** — see the tolerance table above |

**Freshness needs no timer, because the board has no cache.** `setTab()` ends in
`render()`, and `render()` calls `loadAssets()` whenever the view is the board or
the list — so switching to the Dashboard always refetches and cannot show a stale
state.

**No new permission.** Viewing the board is already gated and the cards are assets
the server narrowed by `visibleProjects()`.

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

`POST /api/assets/:id/submit` takes a **link** and a description. It no longer
takes a file: a request carrying one is answered `410 Gone` with a sentence
pointing at the Server tab, and the multipart parser that used to be on that
route has been deleted rather than left unused. Work files live on the office
file server now — see [The Server tab](#the-server-tab-the-office-file-server).

`REVIEW_EXTENSIONS` in `src/upload.js` is still the studio's list of what counts
as a reviewable file, and is still the list to edit as the pipeline changes:

- Images: `.psd .jpg .jpeg .png .gif .tiff .tif`
- Spine rigging exports: `.json .atlas .skel`
- After Effects: `.aep .aet`

**Files uploaded before this change stay downloadable.** `asset_versions` keeps
its `file_name`, `file_path` and `file_size` columns and the rows that have them;
`GET /api/assets/versions/:id/download` still serves those files while
Settings → Server → *Serve legacy files* is on (it ships on). Nothing writes into
those columns any more, so the set only shrinks. Removing the old files from the
hosting account is a manual job for the owner — this application will not delete
a studio's old submissions on a timer.

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
| GET | `/api/version` | anyone — which build is running: the page hash, the version and the commit |
| GET | `/api/assets/:id/hold-explain` | yourself always; `?userId=` needs `settings.permissions` — the hold decision, its gate and the facts behind it |
| GET | `/api/theme` | anyone — the saved token values and the version, for the sign-in screen |
| GET | `/api/theme.css` | anyone — the same thing as a `:root{}` block, with an ETag on the version |
| GET | `/api/theme/editor` | `settings.theme` — the catalogue, the saved values, the ratios, the history and the presets |
| PUT | `/api/theme` | `settings.theme` — save; 400 names the token, 409 asks for `confirmLowContrast` |
| POST | `/api/theme/revert` | `settings.theme` — re-save an earlier version as a new one |
| POST | `/api/theme/contrast` | `settings.theme` — the ratios for values not saved yet |
| POST, DELETE | `/api/theme/presets[/:id]` | `settings.theme` — named palettes, same validation, bounded |
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

## Which build is running

There was no version anywhere until the fourth report of the Hold button, on which the first
question — *is the earlier fix even deployed?* — could not be answered from anything on the
screen. `package.json` has read `1.0.0` since the first commit and nothing surfaced it, so
every report carried an unknown: somebody describing old behaviour might be describing a bug,
an un-deployed fix, or a browser running yesterday's HTML.

**The stamp is computed, never written down.** This project has no build step — `package.json`
says so in as many words — so anything a human or a script has to remember to bump is a stamp
that is wrong exactly when it matters. [`src/build-info.js`](src/build-info.js) gives three
fields:

| | What it is | Where it comes from |
| --- | --- | --- |
| `page` | the first twelve hex digits of a SHA-256 over `public/index.html`'s own bytes | computed, memoised on the file's mtime **and** size |
| `commit` | `BUILD_COMMIT` if the host sets it, else read out of `.git` | `null` on a cPanel deployment made from a zip, which is this project's documented path — hence the hash above, which works there |
| `version` | `package.json` | for the humans |

**The page reports its own stamp, not the server's**, and that is the whole design. Fetching
the version and printing it would print what the server would send *now*, which on a stale
page is the one number that is not running. [`src/theme-delivery.js`](src/theme-delivery.js)
injects the stamp into the HTML as it is served — a `<meta>` in the head, so nothing has to
run for it to be readable and it survives a JavaScript error early in the page. The footer
compares its own value with `GET /api/version` and, when they differ, says **"this page is out
of date"** with a Reload beside it. That comparison is the only thing that can detect a stale
page.

`GET /api/version` is **unauthenticated**: a build identifier is not a secret — it is a hash of
a file every visitor already downloads in full — and behind a login it would be useless for the
one case it is for, somebody on a stale page, which is a page that may not be able to log in.
It names no table, no column and no path, unlike `/api/health/errors` next door.
`/api/health` carries the same object, so one URL answers both "is it well" and "is it the
build we think it is".

### Caching

`/`, `/index.html` and the SPA catch-all go out `Cache-Control: no-cache` with an ETag, which
the theme middleware has always set; **the page's own hash is now in that ETag**, because
without it a deploy that changes the HTML but not the theme keeps the old tag and a browser
holding the previous page is told 304 and goes on running it.

`express.static`'s own default for the served files is `public, max-age=0`. That does
revalidate — but `public` lets any proxy between the studio and this process keep a copy, and
this application is deployed behind cPanel on shared hosting whose caching is not ours to
inspect. HTML, JS, CSS and the web manifest are `no-cache` now. **`no-cache` is not "do not
store"**: the copy is kept and revalidated, so the common answer is still a 304 with no body.
It is the strongest header that costs nothing.

There is **no service worker** and nothing registers one, so no copy is held outside the HTTP
cache.

## The studio's colours

Every colour the application draws is a **design token**: a named entry in
`src/theme-tokens.js` with a key, a label, a group, a default and a sentence
saying where it is used. The stylesheet never names a colour — it reads
`var(--token)` — and a theme saved in Settings redefines those custom
properties for everybody.

**The defaults are the colours the application shipped with.** That is not a
claim, it is a test: `tests/fixtures/colours-before-theme.json` is every colour
literal and every `:root` variable in `public/index.html` at the last commit
before tokens existed, and `tests/theme.test.js` asserts that every token
default, and every translucent value derived from one, is one of them. With no
theme saved the screen is identical to what it was.

### The catalogue

118 tokens in eleven groups: **Navigation tabs**, **Sub-tabs**, **Surfaces**,
**Text**, **Buttons**, **Forms**, **Tables**, **Meaning** (success, warning,
error, info, At Risk, Overdue), **Charts and tiles**, **Sign-in**, and
**Workflow statuses**.

A few things about its shape are worth knowing before adding to it.

* **The custom property names are the ones the page already used.** The page
  background token is `surface.page` and writes `--bg`, because `var(--bg)`
  appears 791 times and renaming it would have been a rewrite dressed up as a
  theme. The seven older semantic names — `--not`, `--prog`, `--review`,
  `--approved`, `--final`, `--client`, `--artist-blue` — are kept for the same
  reason, as palette tokens.
* **Translucent variants are derived, not edited.** The old stylesheet drew the
  same colour at up to nine alphas — Overdue appears at `.08`, `.09`, `.10`,
  `.12`, `.15`, `.16`, `.30`, `.32` and `.45`. A token declares `alphas`, and
  each entry generates a second property `--<name>-t<alpha>`. One colour to
  pick, nine that follow it.
* **Eight-digit hex, not `color-mix()`.** Alpha is accepted only on tokens that
  are overlays, shadows, scrims or hairline rules — the places where a
  see-through colour is the point. Everywhere else an alpha value is refused,
  because a semi-transparent body text is a bug nobody chose.
* **A colour that is not a colour today gets no token.** A disabled control is
  `opacity:.45;filter:grayscale(1)`, there are no striped table rows, the
  danger button has no background of its own, and links do not change colour on
  hover. Adding tokens for those would have meant inventing four appearances,
  which is the one thing a theme must not do.
* **Workflow statuses are generated from the status list**, not listed by hand:
  `statusTokens()` reads `STATES` in `src/asset-workflow.js` and emits
  `status.<id>` for each. A status added later gets a defined grey
  (`STATUS_FALLBACK`) rather than no colour at all, and a test covers exactly
  that. The pipeline owns the ids, the labels and the transitions; the theme
  owns the colour.

### Storage, and why nothing from the box reaches the CSS

One saved theme at a time, in `studio_theme`, as token-to-value pairs plus a
version number that increases on every change. `studio_theme_history` keeps the
last twenty saves and `studio_theme_presets` holds named palettes.

A value goes from a text field into a `:root{}` block on every page in the
application, which is as direct a path as that gets. **The defence is not
escaping.** `canonical()` matches `#RGB` or `#RRGGBB` (or `#RRGGBBAA` where the
token allows alpha) and rebuilds the value from the matched hex digits, so the
output contains nothing of the input — `red; } body { display:none` is not
sanitised, it is refused by name with a 400. Unknown token keys are refused the
same way, and the whole body is capped.

`cssFor()` **re-validates on the way out of the database too**, falling back
per token to the default. A row edited by hand, or restored from a backup taken
before the validation existed, still cannot put anything into a stylesheet.

### Arriving already wearing it

`src/theme-delivery.js` is middleware in front of `/`, `/index.html` and the
SPA catch-all. It replaces a marker comment in the served HTML with
`<style id="themeSaved">…</style>`, memoised on the theme version and the
file's mtime and size.

**That is the whole answer to the first-paint flash**: the colours are in the
first byte of the document, so there is no moment where the page is wearing the
defaults and then changes. Fetching a stylesheet or JSON after load would have
shown the old palette for one frame on every navigation, and a blocking
`<link>` would have added a round trip to every page load for a few hundred
bytes. Nothing is stored per user.

`GET /api/theme` and `GET /api/theme.css` are **unauthenticated** — the sign-in
screen has to arrive in the studio's colours before anybody has a session — and
carry an ETag keyed on the version. `GET /auth/me`, which the page already
polls every 20 seconds, returns `themeVersion`; when it moves, the page fetches
the stylesheet and swaps the block. A fetch that fails empties that block,
which hands the page back to the built-in defaults. It never leaves anybody
looking at an unstyled page.

### Contrast

The editor shows a live WCAG ratio for the pairs that matter — tab label on tab
background in each state, button text on button background, body text on each
surface, a link on the page, each status badge's text on its own tint — and the
**server computes the same ratios and returns them with the save**, so the
check does not depend on the browser having run it. Below 4.5:1 warns. Below
3:1 needs `confirmLowContrast`, and only for pairs the save would *introduce*:
the shipped palette already has three below 3:1 (muted text on a panel, a
placeholder inside a field, the sub-tab counter), and refusing to let anybody
save anything until those are fixed would be a lock, not a safeguard. A focus
ring saved equal to the background it sits on warns separately. Translucent
values are composited over the page background before measuring, because a
ratio against something see-through is a ratio against nothing anybody sees.

### The permission, and getting back out of a bad save

`settings.theme`, `impliedBy: has('managePermissions')` — the Super Admin
alone, and **grantable** like any other key, so a studio with an art director
who owns how the tool looks can hand it over in Settings → Permissions. Every
write route is behind `requirePermission('settings.theme')` and the page gates
the section with `can('settings.theme')`, never on the tier. Reading the theme
needs no permission at all. Every save is in the Activity Log with who, when,
which tokens and the old and new value of each.

The worst save possible is text the same colour as its background, which makes
the screen that would undo it unreadable. Two things answer that:

* **The Theme section's own controls are on a fixed palette that ignores the
  theme.** The block between `/* THEME-SAFE-BLOCK:START */` and `END` in
  `public/index.html` is the only place in the file that still names colours,
  and a test asserts both that it is the only one and that every literal in it
  belongs to a `.theme-` selector.
* **The last twenty saves are listed with a one-click revert**, which saves the
  old palette as a *new* version rather than rewinding the counter — so an open
  screen elsewhere notices it the same way it notices any other change.

### Adding a token

Add the entry to `TOKENS` in `src/theme-tokens.js`, use `var(--name)` wherever
it belongs, and run `node scripts/build-theme-defaults.js` to rewrite the
`<style id="themeDefaults">` block in the page. The Settings UI is built from
the catalogue, so the new row appears on its own. `tests/theme-literals.test.js`
is what stops a colour being typed into a template instead: it scans the served
page and every other served file and fails on any hex, `rgb()` or `hsl()`
outside the generated block, the safe block and a one-entry allow-list.

**There is no dark mode** — the application has one palette, and nothing in it
reads `prefers-color-scheme` — so tokens are defined once rather than per mode.
Adding a second mode was not in scope and would have doubled the catalogue for
a feature nobody asked for. There are no print styles either, and no chart or
canvas that draws a colour: the two canvases crop images, and the bars and stat
tiles are DOM and CSS, so they pick up `var()` like everything else.

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

### Where an Attention chip goes, and what it resets

A chip opens **that project's board** — the other screen called Dashboard. What
is linked, and what deliberately is not:

| Row | What it represents | Click target |
| --- | --- | --- |
| *n* projects overdue | projects | each chip → that project's board |
| *n* projects at risk | projects | each chip → that project's board |
| *n* assets waiting on review | assets, broken down per project | each chip → that project's board, under the lens holding the waiting work |
| *n* assets awaiting client feedback | assets, broken down per project | the same |
| the row's own count and label | an aggregate across projects | **not a link** — there is no one project to go to, and picking one would be a guess |
| the four cards, the pipeline bars, the calendar rows | aggregates across projects | **not links**, for the same reason |

**One funnel, because there were four.** `selectProject()` in
`public/index.html` is now the only way the app points itself at a project, and
the header picker, the Projects tab's *Open*, an Attention chip and a
notification all call it. Each of the four used to do it by hand and only one
did the whole job — the others left the **client** context behind, and the
project picker is *filtered by* that client, so opening a project under another
client left the picker showing a project its own filter excluded. Worse, the
Attention chip tested the `<select>`'s options and, finding the project missing
for exactly that reason, gave up and went to the Projects tab — which from a
studio-wide alert list is most of them.

**What arrival resets, and why.** The header's search box and scope-of-work
picker both survive a tab change, so an alert clicked a week later would land on
a board narrowed by something nobody remembers setting — hiding the very asset
the alert is about. `clearBoardNarrowing()` clears both, **in the state and in
the controls**: nothing syncs the scope picker from state, so clearing one
without the other would leave a box reading "Characters" over a board showing
everything. The Assets List's own column filters (`state.listFilter`, which is
where the assignee filter lives) are **left alone** — they do not narrow the
board at all, they are drawn on screen with a Reset beside them, and clearing
another tab's controls from a navigation would be a surprise rather than a
courtesy.

**The lens follows the work.** The Art/Animation lens defaults to Art and resets
each load, so an alert about three animations would otherwise land on a board
holding none of them. Each asset row now carries the **statuses** it counted
(not the asset ids — the page already has the project's assets once the board
loads, and ids would be a second list to keep in step with the counts), and
`arrivalLens()` picks the lens holding most of the alerting work. A *project*
row names no asset, so the default stands — **unless it would be empty**, in
which case the other lens wins. An alert can never land on a blank board. It is
**one-shot**: it steers the one draw that follows the click and is then cleared,
so it never overrules somebody who chose a lens themselves.

**The persisted context becomes the clicked project**, exactly as if the picker
had been used, so somebody who follows an alert and then reloads is still
looking at what they went to see.

**Reach: there is no mismatch, and no new permission key.** The Admin Dashboard
lists `permissions.visibleProjects(user)`; `GET /api/projects` — the list the
page draws its chips from — returns that same call; and `canAccessProject`,
which guards the board's own request, *is* that call. So a project this screen
can name is one whose board opens, and the server still refuses a crafted id
(pinned). A chip is drawn as **plain text** rather than a button when the page's
own project list does not hold it, which after the refresh below can only mean
reach changed under the reader — and `renderAdminDashboard()` re-reads that list
on every draw so "plain text" means "you cannot open this" rather than "this
page is stale".

**No routing was introduced.** The app has none at all — no hash, no
`pushState`, no `popstate` listener; `location` is read for the API base and the
sign-out redirect and nowhere else. So the destination is **not addressable**:
reload lands wherever the remembered context points (which, after a click, is
the project clicked), and the browser's Back button does not retrace a tab
change. The way back to the Admin Dashboard is the tab bar. Adding routing for
one link would be a navigation model for the whole application, which is a
larger change than this.

**Accessibility.** Each chip is a real `<button type="button">` — in the tab
order, activated by Enter and Space, announced as a button — labelled
`Open <project> dashboard` rather than just named. It has the same focus ring
the rest of the page uses. The row around it carries **no** handler, so the text
of an alert stays selectable and a click on a chip is not also a click on
something larger; the chip stops the event anyway. Past six projects a row shows
`+n more`, which is itself a button and expands in place; what it opens is kept
**outside** the render, so a redraw of the panel does not collapse it.

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

### People to follow up

A section under Attention Required with a **date control** and **two lists**:

| List | Question | Which date |
| --- | --- | --- |
| **Not started** | No work session was opened by this person on that day | The day picked |
| **Timesheet not filled** | No timesheet line exists for that day | The day picked — except for **Today**, where it moves to the **previous working day**, because today's timesheet is not due yet |

Both dates are printed above their lists. Somebody on both is marked **both**,
and the overlap is counted under them.

**It restates none of the definitions it depends on.** Four questions carry the
section and all four were already answered elsewhere:

| Question | Answered by |
| --- | --- |
| Is D a working day | `gate.isWorkingDay()` — `timesheetSettings.loggableDays` and not on the holiday calendar |
| What is the previous working day | `gate.previousWorkingDay()` — the same walk the start gate uses |
| Is a day "filled" | `timesheets.filledDays()` — which `hasLineOn()` now calls with a range of one, so the Prompt 29 start gate and this list are one query shape |
| Which days is the studio shut | `src/holidays.js`, through the two above |

A second reading of any of them would agree until a studio moved its weekly off,
and then one screen would demand a timesheet for a day another called a holiday.
`tests/follow-up.test.js` mutates each shared definition and asserts the section
moved with it.

**"Started on D" is the one definition this section owns**: a `work_sessions`
row whose `started_at` falls on D **in IST** (`+330 MINUTE` in the query — the
column is UTC, and a boundary taken off it raw puts the whole Indian working
evening on the wrong day). Not "ended on D" and not "overlapped D": the question
is whether somebody picked work up. **The overnight auto-resume counts as a
start** — `resumeOverdue()` writes a new session stamped at the studio's opening
for every timer the seven o'clock sweep paused — because the clock really is
running and because the row is never rewritten, so today's answer and the same
date read back next week agree.

**A 60-minute grace period, for Today only** (`GRACE_MINUTES`), measured from
the studio's opening rather than from midnight. A list drawn at 09:31 is the
whole studio. It is not applied to a past date, which is also what makes
today's answer and a later reading of the same day match.

**Who was expected on D** is read from the recorded dates, never from today's
flags: a designation carrying `assignable` (the convention the Assignee
dropdown, the Idle Report and Team Capacity all use), `created_at` on or before
D, and `deactivated_at` after D began. Accounts deactivated *before* that column
existed carry no date; they are **left out and counted in a visible note**
rather than guessed either way. **Designation is the one thing that cannot be
reconstructed** — this schema keeps no role history — and the section says so on
screen instead of letting somebody discover it.

**Freelancers are excluded by the schema, not by a filter.** `freelancers` is
its own table and a freelancer has no login, so there is no `users` row to omit.

**Scope** is `visibleProjects()`, like every other figure on the screen: in
scope means named in `project_members` of a visible project, or holding — or
having held — an asset in one. Somebody attached to **no** project appears only
for a viewer whose `projectScope` is `all`. "Started" and "filled" are
**whole-person**, not clipped to visible projects: scope decides who is listed,
and clipping would print "has not started" beside somebody who spent the day on
a project this viewer cannot open. `src/routes/idle.js` made the same call.

**The work-held marker is measured over D's own bounds** (`assigned_at` before
the end of D, `ended_at` after its start), so a past date never shows what is on
somebody's desk this afternoon — and the server sends the word as well as the
number ("held that day" / "waiting on them").

**Eight queries per draw**, independent of how many people and how many days:
the project list, who is in scope, who was expected, who started, who filled,
how much work they held, and the two halves of the picker's floor. Seven for a
studio-wide viewer, who needs no narrowing. `tests/follow-up.test.js` asserts
the count for one person on one day and for forty people over a month.
`work_sessions` gains `idx_ws_user_started (user_id, started_at)`;
`timesheet_entries` already had `idx_tse_user_day`.

**Range mode** (from–to, capped at 31 days) falls out of the same queries — both
reads were already over a range — and gives one row per person with the days
they missed. **Past dates are cached for a minute; Today never is**, because
Today changes every second and that is the point of the list. The cache key
carries the viewer, since two scopes see different names for the same day.

**No future dates**: the picker's `max` is today and its `min` is the earliest
day with session or timesheet data, and the server refuses a future date, a date
that is not a calendar day (`2026-02-30` parses as an instant), a backwards
range and one past the cap — a date control is a convenience and a URL is not.

#### It needs its own permission

*View People to Follow Up* (`report.follow_up`) is **Super Admin only** by
default, through `managePermissions`, and is deliberately **not** implied by
`report.admin_dashboard`. Two names on a list of who did not turn up is the most
personal thing this application will tell anybody, and a studio granting an
overview of its pipeline has not thereby decided to hand out an attendance
register. `report.idle` is not enough either: that answers how much of
somebody's week is unaccounted for, which is a figure, where this says whether
they showed up. The key is **absent** from the Admin Dashboard payload without
it — not present and empty — and `GET /api/admin-dashboard/follow-up` carries
`requirePermission` on top of the screen's own gate. The page gates on `can()`,
never on the tier. All three are tested.

#### The "waiting on them" figure, and what it used to count

The marker on a follow-up row — "3 waiting on them" — is now a **button** that
opens the list behind it. Making it openable meant first making it true.

**What it counted before.** `heldCounts()` counts assets whose **assignment
episode** overlaps the day — `assigned_at < end AND (ended_at IS NULL OR
ended_at > start)` — with **no status filter at all**. An episode ends only on
reassignment, unassignment or delivery, so an asset the person submitted three
days ago and which is now sitting in TL Review still counted. That is a true
statement about what is on their desk in the ledger sense, and a false one under
the words the row prints for today: work in TL Review is waiting on a
**reviewer**.

**The definition now, and it restates nothing.** Two questions, both already
answered in this application:

| Question | Answered by |
| --- | --- |
| Is it on this person's desk? | `src/asset-workflow.js`'s `assignee` actor: `assignee_id = them AND (routed_to_id = them OR (routed_to_id IS NULL AND status IN ASSIGNEE_STATUSES))` |
| Is it theirs to act on now? | `assigned` — given and not started — plus `src/permissions.js`'s `REWORK_STATUSES`: **TL Feedbacks, CD Feedbacks, Game Feedback** |

Both lists are **imported**, never retyped, and a test asserts the three rework
status keys appear nowhere in `src/waiting-work.js`. The second branch of the
desk test is the **CD Feedbacks relay**: that state is routed to *nobody* until
the lead passes it on, and without the status list "routed to nobody" would read
as "routed to anybody" — which is how an artist could once resubmit past the lead
who was supposed to brief them.

What falls out of that, rather than being filtered for:

| | Why |
| --- | --- |
| **In Progress** | They have started it; the clock is running and nothing is waiting. Per **asset**, so somebody with a timer on one still has the others waiting. |
| **Not Assigned** | Assignment moves an asset to `assigned`; nobody has been given it. |
| every review state | TL Review, TL Approved, CD Review, Approved for Client, Awaiting Client Feedback, Delivered — waiting on somebody else, or on nobody. |
| **outsourced work** | A property of the schema, not a filter. The two assignment routes are mutually exclusive — `outsourceBlocked()` refuses while `assignee_id` is set, `internalAssignBlocked()` refuses while a live outsource assignment exists — so an asset out with a freelancer has `assignee_id` NULL and matches nothing. The test asserts the premise, so relaxing exclusivity has to come past it. |

**How much the row changed.** On the test fixture, where ten assets had been
given to one artist and none reassigned, unassigned or delivered: the old figure
counted **10**, the new one counts **6**. The four it drops are the one on the
clock, two sitting with reviewers, and a CD Feedbacks note the lead has not
relayed yet.

**For a past date nothing changed, and the figure is not clickable.** "Waiting"
is a statement about an asset's status and routing **now**, and this schema
records no status-at-an-instant to replay — `src/follow-up.js`'s own header says
so. So a past date keeps `heldCounts()`, which *is* reconstructible from
`assigned_at` and `ended_at`, and the row goes on saying **"held that day"**
rather than "waiting on them". The section has switched that word on the date
since it shipped; now the numbers agree with the words. One query either way, so
the budget does not move.

#### The panel: what is waiting, Client then Project then assets

Clicking the figure opens an in-page panel under that person's row — the pattern
this section already uses, and no drawer, because the row is inside a
two-column list on a dashboard and a drawer would cover the other list. **One
panel at a time**: two or three open at once would push the second list off the
screen, and it is what makes the stale-response guard simple enough to be
obviously right.

Each asset shows its name and code, type, **current status** (so it is clear why
it counts), due date with an **Overdue** marker, and **how long it has been
waiting on this person** — which is two facts, not one:

| Measured from | Why |
| --- | --- |
| the open assignment episode's `assigned_at` | a reassignment mid-rework restarts the wait, because for the new person it is new work |
| the `asset_events` row that moved it into its current status | a lead sending it back restarts the wait for the same person, because what they are waiting to do has changed |

The **later of the two** is the answer, and the row says which — "2 days in TL
Feedbacks" or "1 day since assigned". Measured from the assignment alone a
sent-back asset would make the studio look slower than it is; from the status
alone a long-held asset would reset the moment anybody touched it. Neither
recorded reads "waiting, since when is not recorded" rather than a wait of
fifty-six years.

**The number and the list cannot disagree.** `whereFor()` in
`src/waiting-work.js` writes the predicate once and both the grouped count and
the panel's read build their query around it; a test compares the two generated
WHERE clauses string for string. The panel's own `count` is the length of the
rows it grouped, not a second read.

**Totals are on every heading** — per client and per project, with the overdue
count beside them — and they are the server's. Sorted **overdue first, then
longest waiting, then by name** at every level, so the order is stable between
draws. The cap is **50 assets**, applied to the flat list in that order and then
grouped, because capping per group would show a few of each client and call it
fifty; "show all" lifts it on the next request. A project whose client cannot be
read lands in a group called **"No client"**, pinned last and flagged, so it
reads as a gap in the data rather than a client called nothing.

**The link uses the navigation the Attention Required chips use.**
`openProjectBoard()` moves the project and the client, clears the header's
search and scope-of-work — a search typed last week would otherwise hide the
very asset the panel was about — and hands the asset's status to the board so the
**Art / Animation lens** opens on the half that holds it. Then `revealAsset()`
opens the drawer, reloading the board first if the asset is not in the page's
snapshot, which on this panel is the normal case. That second function is the
one change made to `openNotification`: it was extracted from it, because two
copies would be two answers to "what if the asset has gone".

**Scope and permission are the section's own.** `report.follow_up` — the panel is
the figure the row already prints, expanded, and a key of its own would let a
studio grant the number and withhold the names, which the number already breaks.
`permissions.visibleProjects()` decides the projects, and
`src/follow-up.js`'s own `inScope()` decides whether this is even a person the
viewer may ask about: without that check the endpoint is a probe, where a
narrower viewer could name any user id and learn whether that person has work.
A viewer with no projects at all is refused rather than shown the studio.

**Work outside the viewer's reach is reported as a boolean, not a count.** The
figure and the panel both count only what that viewer can see; when there is
more elsewhere the panel says so in one sentence and stops there. "4 more
elsewhere" would tell an Admin how busy somebody is on projects they are not on,
which is most of what the scope rule withholds.

**One call per person, and one query inside it.** The grouping is done in
JavaScript from one flat read; the two "waiting since" facts are correlated
subqueries in the *same* statement, so they are one round trip however many
assets come back. Two hundred assets across forty projects and eight clients
cost the same one query as one asset, and the handler has no loop in it. The
figure itself stays inside the section's existing set-based draw, so page load
costs nothing extra per row.

**The control is a `<button>`** with `aria-expanded`, so Enter, Space, the tab
order and the focus ring come for free; the panel is a `role="region"` with the
person's name. It survives the dashboard's timed redraw with no second request,
because the open panel lives in module state that `renderAdminDashboard()` does
not clear — the same mechanism that already keeps a chosen date. Picking another
date closes it, since the figure it hung under is about today. A slower earlier
response never overwrites a newer one: the ticket is taken before the request
leaves and checked after it returns, so clicking Ana and then Bo shows Bo.

#### Where the client is stored

| | |
| --- | --- |
| The table | `clients` — `name` unique, `is_system`, `is_active`/`archived_at`, `deal_closed_at` |
| The link | `projects.client_id`, **NOT NULL**, `FOREIGN KEY … ON DELETE RESTRICT` |
| Assets | `assets.project_id` only. An asset reaches its client through its project, which is why the panel joins `assets → projects → clients`. |

**So no project is without a client, strictly** — the column is NOT NULL and
every project is created with one. What exists instead is the **system
"Unassigned" client** (`is_system = 1`), created by `ensureClients()` for
projects that existed before clients did and used by anything that has no real
client yet; it can be renamed but not deleted. Its projects group under
"Unassigned", which is a real client row, not the "No client" group.

**"No client" is still a real case, on one kind of deployment.**
`ensureClients()` ends with `Schema: the projects -> clients foreign key is
still missing — …` for a database whose earlier boot could not create it — most
often a collation mismatch between the two tables. On such a database a dangling
`client_id` is reachable, and the panel's join is a `LEFT JOIN` for exactly that
reason: an inner join would silently drop that project's assets out of a list
whose own heading counted them, which is the one failure the panel exists to
make impossible. The live test drops the key to reach that state, and puts it
back.

#### The last-activity marker

Every row on both lists carries **when that person was last active** and, from
two working days upwards, **how long they have been absent**.

**Two facts, labelled, never added together.** A single "last active" column
would be the later of the two, which is the one a reader would trust least.

| Fact | What it reads | Where from |
| --- | --- | --- |
| **Timer** | The most recent moment a work session **started or ended** — which in this schema is the whole of "start, stop, pause and resume", because `work_sessions` has exactly two stamps and each of those four actions writes one of them | `work_sessions` |
| **Last seen** | The most recent row this person wrote in the Activity Log — every successful state-changing request, **plus their sign-in** (`auth.login` is recorded there) | `activity_log` |

**What "last seen" is not, and the screen says so too.** This application
records **no per-request heartbeat**. `activity_log` deliberately excludes GET
and HEAD — "reads… the reason the log stays legible" — so somebody who signs in
at nine and spends the day reading boards reads as nine o'clock, not five. There
is no last-authenticated-request stamp in this schema and none was invented.

**A throttled `users.last_seen` was considered and declined.** The sign-in is
already recorded, so the marker is never emptier than "signed in today"; the gap
it would close is "signed in but idle since", which the **timer** fact already
answers better, because a clock running is activity and a page open is not. And
it would put a write on the one path every request in the application goes
through, to improve one column on one dashboard section. If the studio wants
presence, presence is a feature, not a column.

Both come back with **relative words** ("yesterday 5:40 PM", "3 days ago") and
the **exact IST stamp** on hover, and **both are composed on the server** —
"3 days ago" worked out in the browser would be counted against the reader's
clock, so a past date's row would say "3 days ago" because somebody opened the
screen on Friday. Somebody with no history reads **"No activity yet"**, never a
zero and never 1 Jan 1970.

**The streak: not started for N working days in a row.** Counted backwards from
the most recent working day that is **over**:

| Walking back onto… | What happens |
| --- | --- |
| a non-working day | **skipped**, and the run is not broken — weekends and holidays come from the shared working-day rule, never a second reading of the calendar |
| a day they started | the run **ends** there |
| a day before they joined | the run **ends**, and that day is not counted |
| the look-back cap (**30 working days**) | the run **stops** and the row reads `30+` — a floor, not a figure |

It **ends at the last completed day**: for a past date, that date; for Today,
the **previous** working day, because today is not finished and the fact that
they have not started today is already the list they are on. The badge is drawn
from **two** upwards and becomes the stronger form at the **configured
threshold** (default 3) — which comes from the server, so the page never
compares the number to a constant of its own. It is **never colour alone**: the
badge carries the number and the words "working days", and the strong form adds
`!` and "repeated".

**As of the date being viewed.** Both queries are bounded above by the end of
that day and the streak walks back from it, so a past date's row can never show
activity from after the date, nor a streak today's data would have broken. A
session that opened on the day in view and closed the following week
contributes its **open** — the only one of its two moments that had happened by
then.

**"Longest inactive" is an order the server applies**, on the streak, then the
calendar days since the last timer event, then the list's own urgency. The
capped list is the first twenty-five of the server's order, so re-sorting in the
page would reorder a page rather than the list.

**What it costs: two more queries, both grouped, for any number of people.** The
streak costs **nothing** — it walks the started-days set the lists already
fetched, which is also why there is still exactly one definition of "started".
A whole draw is **eleven** queries for a scoped viewer and ten for a studio-wide
one, and `tests/follow-up.test.js` asserts that forty people over a month cost
the same.

**One index was added, because the plan asked for it.** The marker's last-seen
query is `MAX(created_at)` per actor. Measured on 30,000 rows across 50 actors,
asked about three:

| | Key | Rows examined |
| --- | --- | --- |
| before | `idx_activity_actor (actor_id, seq)` | 1,765 — every row those three people ever wrote |
| after | `idx_activity_actor_when (actor_id, created_at)` | **6**, "Using index for group-by" |

`activity_log` is, by its own comment, the table that grows without limit, so a
marker that read a person's whole history on every draw would get slower with
it. Nothing else needed one: the timer half already has
`idx_ws_user_started`, and `reminder_log`'s own key covers the one read the
screen makes of it.

#### Remind: one click, and at most one a day

A lead or admin can nudge one person, or everybody on a list.

| List | What is sent |
| --- | --- |
| **Not started** | "&lt;Name&gt; (&lt;role&gt;) is checking in: you haven't started work today. You have N tasks waiting." |
| **Timesheet not filled** | "Please fill your timesheet for &lt;date&gt;." |

The sentence is composed **once**, in `src/reminders.js`, and the in-app notice,
the email and the history row all read it — three copies of one sentence is
three places for the date inside it to come out formatted differently.

**One notification path.** `notifications.raise()` is the choke point the bell,
the desktop notification and the phone push all hang off, so a reminder reaches
all three without `src/reminders.js` knowing any of them exist. Two new kinds,
`start_reminder` and `timesheet_reminder`, because they are two different
requests. They are the **first kinds whose wording is stored** rather than
rebuilt: `notifications.detail` holds the sentence, because "you have 4 tasks
waiting" and "the day that is missing" are facts that are not links, and
recomputing them when the bell is opened next week would quietly rewrite the
message somebody was sent. The column is nullable, no other kind writes it, and
a database that has not reached the migration still delivers the notice without
it.

**Email goes through the existing queue, and only when the studio says so.**
`src/email-notifications.js` builds the message and `src/email-outbox.js`
carries it, on the same `60s / 5m / 30m / 2h / 6h / 24h` schedule, the same
seven attempts and the same permanent-failure behaviour as every other message —
asserted by identity, so a second schedule typed anywhere would fail the test.
Somebody who switched email notifications off in their Profile is not mailed
one; their bell still rings, which is the channel they did not switch off. The
link in the email is the application's own origin, taken from the request:
there is no configured public URL here and no route for a date, so the exact day
is named in the words instead.

**The server re-checks at send time, by rebuilding the list.** Not a second
opinion: the endpoint calls `followUp.build()` — the same function that drew the
list the sender clicked on — with the cache bypassed, so "started", "filled",
"expected" and "in scope" are asked rather than restated.

| Refused when | Status | What it says |
| --- | --- | --- |
| Manual reminders are off in Settings | 409 | the studio-wide answer, before any personal one |
| Not in the sender's `visibleProjects()` | **403** | and the refusal says nothing about that person's day — naming them, even to say they have started, would answer the question the scope rule exists to withhold |
| They started / filled since the list loaded | 409 | "Priya has started work since this list loaded." |
| A start reminder about any day but today | 409 | "use the timesheet reminder for a past day" |
| A weekend or a holiday (start reminders) | 409 | "a weekly off or a holiday" |
| The studio's clock is shut, or on a break (start reminders) | 409 | "The studio is on a break until 2:00pm" |
| The day is past the back-dating limit | 409 | names the limit — a reminder **is** the asking, so a notice with a caveat attached would be a message whose second sentence withdraws its first |
| The daily cap is spent | 409 | "Priya has already been reminded today." |

**The lunch blackout is derived, not written down.** There is no lunch constant
to read: Settings → Recording Hours is a list of named windows, and lunch is the
gap between two of them. So the blackout is **any gap of 30 minutes or more**
between the day's recording windows — which catches lunch in every studio that
has one, skips the fifteen-minute tea breaks, and moves on its own the day
somebody moves the window. A timesheet reminder is not subject to any of it: it
is paperwork about a day that is over.

**The daily cap is a unique key, not a check.** Two leads clicking in the same
second both read "nobody has been reminded" and both send — and no amount of
checking first can fix that, because the gap between the check and the insert is
where the second one lives. So `reminder_log` carries a **slot**: the number of
manual reminders already sent to that person for that kind today, and

```sql
UNIQUE KEY uq_reminder_slot (recipient_id, kind, source, sent_on, slot)
```

makes the database decide. The first click takes slot 0, the second slot 1, two
simultaneous clicks both aim at the same slot and exactly one lands; the loser
is told the cap. The row is **claimed before anything is sent**: a notice
delivered and then recorded could be delivered twice, where a row recorded and
then not delivered shows on the screen as a reminder that went nowhere, which
somebody can see and resend tomorrow.

**`source` has a second value before anything writes it.** There are **no
automatic reminders in this application** — no start-of-day sweep, nothing that
sends on its own. The column, and the unique key spanning it, are how the one
that is eventually built shares this table and this once-a-day rule instead of
growing a second set. The screen reads `auto` rows to show "Auto reminder sent
10:30"; until something writes them that line is simply absent. An automatic
reminder does **not** spend the manual cap — the studio's own nudge must not
stop a lead adding a word at eleven — and the lead can see it went out before
deciding.

**The row says it has been reminded, to every lead who can see the list** — and
it says so on the button itself, which reads **"Reminded 11:05am"** and is
disabled. Who sent it is in the button's tooltip and in its accessible name
("Reminded today 11:05am by Priya."). That is the whole point of putting it on
the row rather than in the clicker's own session.

It used to be a sentence of its own, beside the button, and it was moved onto the
button because a row is not elastic: the badges, the figure, the streak chip, that
sentence, the button and the server's refusal were six things on one strip, and
the only one that could give was the block holding the person's name — so the
name shrank to a few characters wide, overflowed its box and was drawn
underneath the badges. The state is *about* the button, so it is now the
button's label, and the right-hand side of a row is the same width whether or
not anybody has been reminded.

Every other refusal — out of scope, outside hours, the day is not over — is
still printed in words beside the button, as a tooltip and through
`aria-describedby`, because a tooltip is not reachable by keyboard. **One is
not**: "… has already been reminded today" is the same fact the button is
already showing, so it stays in the DOM for `aria-describedby` but is hidden
(class `sr`) rather than drawn a second time. `tests/follow-up-layout.test.js`
measures all of this in a real browser; see **Tests**.

**Remind all** asks in the page — this application has no native dialogs — and
states the exact number who will be reminded and how many will be skipped, by
reason: "3 will be skipped: 2 already reminded today, 1 have filled it since."
It applies the same rules per person, returns a per-person result, and **one
refusal stops nothing**: each person is caught on their own. It reads **every**
row rather than the screen's first twenty-five, because the row cap is a drawing
decision.

**Every reminder is recorded** in `reminder_log` — sender, recipient, kind, the
day it was about, the day it was sent, the channels and the result — and audited
through the mechanism every other action uses.

#### Two keys, because seeing and messaging are two powers

*Send Follow-Up Reminders* (`report.remind`) is **Super Admin only** by default,
through `managePermissions`, and is its own key beside *View People to Follow
Up*. Seeing who is behind is a report; messaging them is an act that arrives in
somebody's bell, on their phone and in their inbox with the sender's name on it.
A studio may well want a producer to have the first without the second.

Both endpoints demand **both** keys — there is nothing to send from without the
list — enforced with `requirePermission` on the server and `can()` on the page,
**never** the tier. It is grantable, by designation or through a role group, and
the default is pinned in `tests/role-permissions.test.js`.

#### Settings → Start-of-day Nudges

Eleven switches now, behind **`settings.nudges`** — and that key is new. The
section began as four values governing the reminders `report.remind` sends and
was gated on it; it now also governs the start-of-day **banner** and the
top-bar **timer indicator**, which are not reminders and which every signed-in
person sees. "May send messages to people" is no longer the right thing to be
holding in order to switch them off. The practical consequence, stated rather
than hidden: **a studio that had delegated `report.remind` to its leads has not
thereby delegated this screen.** Both default to the Super Admin tier alone, so
nothing moves on an install that has changed neither.

| Setting | Default | Why |
| --- | --- | --- |
| **Start-of-day nudges on** (master) | **on** | with it off, no banner, no indicator and no reminder of either sort |
| Show the banner | **on** | screen furniture on a screen the person is already looking at; a studio that dislikes it switches it off having seen it |
| Show the top-bar timer | **on** | as above |
| In-app reminders | **on** | reaches somebody inside the tool |
| Email reminders | **off** | an email leaves the building through a shared mailbox and cannot be recalled — the same reasoning `requirePreviousDay` ships inert for |
| Grace period | **60** minutes (10–240) | Prompt 34's `GRACE_MINUTES`, which is now this value's default; `src/follow-up.js` reads it, so the follow-up list, the banner and the first reminder cannot disagree |
| Second reminder at | **11:30** IST | stored as minutes past midnight (690), the frame `work_schedule.day_start_min` already uses; accepted as `HH:MM` or as minutes |
| Banner snooze | **30** minutes (5–240) | |
| Manual reminders on | **on** | |
| Most manual per person, per kind, per day | **1** | |
| Mark repeated absence at | **3** working days | floor of 2 — one would mean "mark every row" |

Validated on the server — every mistake reported, not the first — including two
rules that need the studio's own schedule: **the second reminder must come after
the first** (the studio's opening plus the grace period, so moving the grace
moves the comparison) and **inside working hours**. A studio with no recording
windows at all is not refused, or a Super Admin could not fix the schedule and
the reminder in either order. Audited with the policy as a sentence on both
sides. **Applied without a redeploy or a sign-out**: `save()` reloads the mirror
every reader reads, the banner and indicator state travel on `/auth/me`, and
saving forces that poll once so the person who changed it sees it immediately.

### The start-of-day banner, the reminders, and the top-bar timer

Three pieces of one feature, all of them reading state the **server** computes.

#### One place decides, and the page draws it

`src/day-state.js` answers, on `/auth/me`: is a timer running and for how long,
if not then why not, did they start anything today, how many tasks are waiting
and which three, and is starting blocked and by what. The page holds **no**
working-hours rule, no holiday rule, no grace period and no "started today"
rule.

That is the point rather than tidiness. The studio's clock spans a weekly off, a
holiday calendar, three break windows and a timezone, and two copies of a date
rule have drifted apart in this application before — which is why `/auth/me`
already hands over the timesheet gate's **answer** instead of its inputs. A
banner that decided for itself whether it was lunch would be the fourth copy.

Everything is asked of whatever already owns it:

| Question | Asked of |
| --- | --- |
| is a timer running | `workLog.openForUser()` |
| how long has it run | `workLog.liveSeconds()`, from the database's own clock — **working** seconds, so a session through lunch does not count lunch |
| on hold, and why | `workLog.heldAnyFor()`, which carries the studio-pause reason the hours sweep wrote |
| is the clock recording | `workingTime.isRecording()` / `spansOn()` — where the weekly off and the holiday calendar already meet |
| when does it start again | `workingTime.resumesAt()` |
| did they start today | `followUp.startedDays()` — the one definition of "started on D" |
| what is waiting on them | `waitingWork.countsFor()` / `listFor()` — the same predicate as the follow-up figure |
| may they start at all | `timesheetGate.check()`, **handed in** by the route that already ran it |
| are they expected | Prompt 34's rule: assignable designations, on the books, and not created today |

**On `/auth/me` rather than an endpoint of its own**, because the page already
polls it every twenty seconds for permissions and the theme version, and "within
the normal refresh cycle" is exactly what the indicator has to reflect. What it
costs on that poll: **one** query with a timer running, **four** when idle, and
**nothing** with the master switch off or both pieces switched off.

#### The banner

Shown only when **all** of: the master switch and the banner switch are on, the
person is expected to be working, it is a working day, the clock is recording
(which is one predicate for "inside hours **and** not at lunch" — there is no
separate blackout rule to forget), no timer is running, nothing was started
today, and the grace period has passed.

| Variant | What it shows |
| --- | --- |
| **start** | "You haven't started work today. You have N tasks assigned." One Start for one task; for several, up to three with their status and due date, plus "See all my tasks" |
| **blocked** | the gate's own sentence and a link to the Time Sheet, **instead** of the buttons — offering Start would be a button the server refuses |
| **none** | "You have no tasks assigned today", and no button |

**Start goes through `POST /api/assets/:id/start` and nothing else** — the only
way a session opens in this application, carrying all seven of its independent
gates (the outsource check, `mayStartWork`, `STARTABLE`, the awaiting-handover
stages, the start date, the holiday, the previous-day timesheet rule and the
one-active-task rule). No second endpoint and no flag. A refusal is the server's
sentence, shown on the banner rather than as a toast that is gone before anybody
reads it.

**Dismissal is 30 minutes, in the browser, per user and per day.** Not on the
server: a dismissal is "not now", which is a fact about this browser in this
hour, and in the server it would also follow somebody to their phone. The stored
value is an instant to come back at and the key carries the server's IST date,
so it expires twice over; an unreadable value reads as "not dismissed". The
banner's container is always in the document, so the first paint either has it
or does not — it never shoves the page down after it has settled.

#### The two reminders

The automatic half of a table that was built for it. `reminder_log` already had
a `source` column whose second value, `'auto'`, nothing wrote — and a unique key
that already spanned it:

```sql
UNIQUE KEY uq_reminder_slot (recipient_id, kind, source, sent_on, slot)
```

`slot` is which of the day's sends this is, so **the first reminder takes slot 0
and the second takes slot 1**. "The first reminder, for Ana, today" is therefore
one row the database accepts once and refuses for ever after — against a
restart, a sweep running every minute, two workers racing and a catch-up pass
hours later. **The INSERT is the check**; there is no read-then-write for a
second process to slip between. The follow-up section's "Auto reminder sent
10:30" line, which had been drawing nothing since it shipped, now lights up.

| | |
| --- | --- |
| First | the studio's opening **plus the grace period** — 10:30 by default |
| Second | the configured time, 11:30 by default |
| First's window | ends when the second's begins, so **the first is never sent after the second's time has passed** |
| Second's window | ends at the close of the working day |

**A missed occasion is sent late by the same code path**, which is why there is
no scheduler: every pass asks "is this occasion's window open, is the slot free,
and does this person still need it". The pass at 10:31 after a server that was
down at 10:30 sends it; the pass at 10:32 does not. Nothing is stored about when
the sweep last ran. That is the argument `scheduleAutoPause()` already makes for
the work-hours sweep — "the interval is about the screen, not the number" — and
this sweep is wired beside it, with the same shape: an immediate pass, then an
unref'd interval (`START_REMINDER_SWEEP_MINUTES`, default 1).

Never sent: on a weekend, a holiday, during a break or outside working hours
(all one question, asked of `isRecording`); to somebody who has started or has a
timer running; to somebody who is not expected today; **or to somebody with no
tasks**. That last one the brief asked to be decided and stated: a nudge to start
work when there is nothing to start is a message whose only possible action is to
ignore it, and the studio has other screens for "somebody has nothing to do".
The banner says it on their own screen, where it costs nothing; a notice and an
email do not.

The message names the count, because that is what makes it actionable, and the
second says it is the second. In-app goes through `notifications.raise()` with no
actor — the studio did this, not a person — so it reaches the bell, the desktop
notice and the phone push without this file knowing any of them exist. Email
goes through `emailNotifications.reminder()` onto the existing outbox, inheriting
the `60s / 5m / 30m / 2h / 6h / 24h` backoff, the seven attempts and the
permanent-failure behaviour unchanged. Nobody without an email address is
mailed, and the opt-out is the same gate every other email in the file uses.

#### The top-bar indicator

On every screen, because the header is. A `<button>`, so Enter, Space, the tab
order and a focus ring come for free.

| State | What it says | Token |
| --- | --- | --- |
| running | the asset and a live `h:mm:ss` | `indicator.running` |
| not running, in hours | "No timer running" | `indicator.idle` |
| paused (break) | "Paused – break" and why | `indicator.paused` |
| outside hours / closed day | "Outside hours" / "Holiday" / "Studio closed", with the reason | `indicator.paused` |
| on hold | "On hold" | `indicator.held` |

**Never colour alone**: each state draws an icon and the words as well, so a
reader who cannot tell the amber from the green reads the same state. The four
colours are Super Admin editable tokens with defaults taken from the family that
already means that thing.

**The live second cannot drift or lie.** The figure is working seconds from the
database's own clock; while the studio is recording they advance one per wall
second, so adding one per second is exactly right, and every twenty-second poll
replaces the whole figure with the server's again — so a sleeping laptop, a
suspended tab or a second browser cannot accumulate an error. It **stops when
the studio stops**: `ticking` is the server's answer to "is the clock recording
right now", so a tab left open through lunch does not count lunch. Clicking it
opens the running asset through the navigation the rest of the application uses,
or the board when nothing is running. A timer started in another tab appears on
the next poll, because that is where the state comes from.

No native dialogs anywhere in any of this, and nothing uses the browser
Notification API: in-app and email are the channels.

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

*View People to Follow Up* (`report.follow_up`) is a **second, separate key**
for the section above — Super Admin only by default. See its own note there.

**Holding the permission opens the tab. It does not widen anybody's reach.**
What the screen counts is scoped by the role's existing `projectScope`, the same
rule the rest of the app runs on. That matters because the **Admin tier is
`projectScope: 'owned'`** — it sees the projects it created, not the studio — so
a studio-wide total shown to an Admin would be full of projects they could not
open. A Super Admin sees the whole studio; an Admin sees their own; the subtitle
says which. Nobody is shown a number they cannot click into.

## The Server tab: the office file server

Work files live on a machine in the studio. Forge runs on GoDaddy. The Server
tab lets people browse that machine's folders, copy files to it and take copies
off it — and **not one byte passes through this application**.

```
  browser  ──HTTPS on the office LAN──►  gateway  ──►  \\SERVER\Projects
     │                                      │
     └──HTTPS over the internet──►  Forge  ◄─┘  heartbeat, config, callbacks
                                 permissions, tokens, audit, settings
```

Forge is the control plane. It decides who may do what, where, mints a signed
token that says so, and records that it happened. The gateway enforces the token
and moves the bytes. Neither can do the other's job: Forge cannot reach the LAN,
and the gateway holds no private key and so cannot grant itself anything.

### The four things this guarantees

1. **No file content ever reaches this server.** No route accepts a file body,
   no route proxies one, nothing is cached or thumbnailed, and no column holds
   bytes. The tab lists what is actually on the office server, every time —
   there is deliberately **no table of files**, because a second copy of the
   share's contents is a thing that goes out of date and starts lying.
2. **Nothing can delete, rename, move or overwrite a stored file.** Not in
   Forge, not in the gateway, not in the API, not on the page. A name that is
   taken becomes `name (2).ext`. The only deletion either side performs is the
   gateway clearing its own `.incoming` scratch area.
3. **The files are reachable only from the office.** The gateway listens on the
   LAN interface and is never port-forwarded. Off the network, the tab says
   *"Open Forge from the office network to use Server files"* and shows nothing.
4. **Neither secret is ever shown after it is saved.** The token signing key's
   private half and the gateway secret are encrypted at rest (`src/email-secret.js`,
   AES-256-GCM) and are readable afterwards only as a fingerprint and a date. A
   generated gateway secret is shown exactly once, because it has to be pasted
   into the gateway machine.

   **`EMAIL_ENCRYPTION_KEY` only, with no fallback.** Everywhere else in this
   application that key falls back to `JWT_SECRET`, which is convenient and is
   the right trade for a mail password. Not here: `JWT_SECRET` ships as a
   placeholder, it is in reachable git history, and it is rotated by whoever
   deploys — and rotating it would make every Server secret undecryptable while
   silently leaving the feature switched on. So the Server section reads the key
   in **strict mode**: with no `EMAIL_ENCRYPTION_KEY` set, the key generator and
   the secret generator refuse with a sentence naming the variable, and the
   self-test says so on its own line. Nothing is stored under a key that is
   about to change under it.

### Switching it on

It ships **off**, and the tab is hidden while it is. In Settings → Server, as a
Super Admin:

1. **Generate key pair** — the public half is shown and copyable; the private
   half never leaves the server.
2. **Generate secret** — shown once. Paste it into the gateway's
   `GATEWAY_SECRET`.
3. Set the **gateway address** (`https://files.office.example`) and the
   **gateway id**, which must match the gateway's `GATEWAY_ID`.
4. Set the **server link prefix** — the share the gateway serves, written the way
   the studio writes it: `\\SERVER\Projects`. Every project link has to start
   with it, and it is how a link becomes a path inside the share.
5. Install the gateway on an office machine — `gateway/README.md` is written for
   whoever does that — and wait for the heartbeat to arrive.
6. **Enable the Server tab.** Turning it on is refused until the things above are
   in place, so the tab cannot appear in a state where every click fails.

**And a second switch, for uploading from the submit-work form.** It is separate,
it ships off, and it is refused unless the first one is on and a prefix is set —
browsing the share and letting artists put files on it are different decisions,
taken on different days. See *Uploading from the submit-work form* below.

The checklist at the top of the section says which of those steps is still
outstanding, and **Run self-test** goes through them one at a time: the switch,
the link prefix, the encryption key, the signing key, the gateway secret,
reachability and heartbeat age, the applied config version, the **clock
difference**, and free disk. On the gateway machine, `npm run doctor` goes
further — it is the same two filesystem probes plus the things only that machine
can answer. See §12 of `gateway/README.md`.

Switching it **off** hides the tab and makes every Server endpoint answer
`409 feature_disabled` — but existing deletion requests stay viewable and
resolvable, because a request is a message about a file that is still there and
turning a feature off is not an answer to it.

### Permissions

Nine keys, all **Super Admin only by default** — unusual in this catalogue, and
deliberate: on the day this ships nobody has installed a gateway, so the studio
grants these when the office machine is actually there.

| Key | What it allows |
|---|---|
| `server.view` | Open the tab and browse the folders of projects this role can already see, plus the shared folders. |
| `server.download` | Take a copy of a file. |
| `server.upload` | Copy files up, and create folders. |
| `server.request_delete` | Ask for something to be deleted, with a reason. |
| `server.manage_requests` | See every request and mark it done or declined. |
| `server.browse_all` | Browse the whole share rather than only this role's projects. |
| `server.view_audit` | Read the trail of who listed, downloaded and uploaded what. |
| `server.submit_upload` | Upload work from the submit-work form, into their own folder. |
| `settings.server.manage` | The Settings section: the address, the keys, the prefix, the limits, the two switches, the self-test. |

All nine are grantable per role and through role groups, like everything else.

`server.submit_upload` is its own key and not implied by anything, because there
is nothing to imply it from: **submitting work is not a permission in this
application**. An artist submits the asset assigned to them, and the workflow
decides whether they may — there is no `assets.submit` to hang this off. So the
new key says only "may put the file on the office server on the way", and an
artist without it pastes a link exactly as before.

Note that editing a project's **server folder link** needs no new key: it is part
of editing the project, under `project.edit`, because deciding where a project's
work lives is the same job as naming it.

### Scoping: a project points at a folder, and says so

A non-admin's first screen in the tab is not the share's root — they may not read
it — but a **virtual "Projects" list** that Forge answers from
`visibleProjects()`: the same function that decides which projects they see
anywhere else in the application, including the Acting Team Lead rule. Each row
is a project with a usable server link, named by the **project** with the link
underneath; a project without one is not a row at all. The breadcrumb inside it
goes `Projects / <the project> / …` and **stops there**, because a crumb for the
folder above would be a click the server refuses, and a refusal somebody can
reach by clicking a breadcrumb reads as a bug. `server.browse_all` gets the real
root, because for them it is real.

**The folder is a link somebody pasted, in `projects.server_link`.** Not derived
from anything:

* An earlier version of this derived the folder from the project's **name**
  (`projects.code` is generated initials — `codeFor()` in
  `src/routes/projects.js`, re-derived on every rename — so "Alpha" has the code
  "A" and a share full of single letters nobody can read). Deriving it at all was
  the mistake: **the folders already exist**, with four months of work in them and
  names nobody is going to change, and a derived name is a guess about a share
  this application cannot see. So a project manager pastes the link, with a
  **Check folder** button that asks the gateway whether it is really there.
* It must start with the **server link prefix** from Settings, and what is stored
  is what was typed — separators and all, so it can be pasted back into Explorer.
  One function decides it (`src/server-link.js`), and the project form says the
  same thing as you type from a copy of that rule in the page;
  `tests/server-link.test.js` runs both against one shared matrix of cases and
  fails naming any input they disagree about.
* **Nothing is moved, ever.** Repointing a project at a different folder asks for
  confirmation, writes an audit entry, and moves not one byte: the old work stays
  where it is, and new work goes to the new place. Two projects pointing at the
  same folder, or one inside another, is a **warning and not a refusal** — a
  studio that keeps two seasons of one show in one folder is doing something
  reasonable, and an application that refused it would be wrong rather than safe.
* A project with **no link** is unchanged in every other respect: it is absent
  from the tab's Projects list, the submit-work upload is not offered for it, and
  everything else about it works exactly as it did.
* The gateway **never creates a project folder.** The upload token names it as a
  precondition and the gateway refuses the upload if it is not there, with
  *"Project folder not found on the server. Ask your project manager or IT to
  check the project's server link."* A mistyped link that quietly produced a
  second folder would send work somewhere nobody is looking, while the project
  manager read "uploaded" and believed it.

Every token Forge mints names one path inside those prefixes, and the gateway
checks the path against the token again on its side. A client-supplied path is
therefore checked twice and trusted never.

### Uploading from the submit-work form

Behind the second switch, and only for the projects it is enabled for: an artist
with `server.submit_upload` gets an **Upload to Server** box under the link field
in the submit-work form. It copies files to the office server and then **fills the
link field in** — with a link that passes the same validation as anything pasted
by hand, because it is the same endpoint's answer.

```
<the project's folder>/<discipline>/<the person's own folder>/<the files>
      from projects.server_link    |          |
                                   |          └─ users.server_folder, assigned
                                   |             once and never recomputed
                                   └─ from the ASSET'S CATEGORY, named in Settings
```

* **The server computes the path. Every time, from the asset.** There is no
  folder picker, no path in any request body, and a client that invented one
  would have it ignored — `src/routes/server.js` recomputes it and a test proves
  that. The browser says which asset, which file and how big; the server answers
  where it goes.
* **The discipline is the asset's category**, not the person's role: the same
  artist uploading an Art asset and an Animation asset in one project puts them
  in `Artist/` and `Animator/`. Role-based mapping was the obvious design and it
  is wrong — one person does both jobs in a small studio, and the folder is about
  the work. The category → folder names are editable in Settings (`Art → Artist`,
  `Animation → Animator`, everything else → `Work`). **Asset categories ship
  empty** in this application, so a studio that has not created any gets the
  fallback folder for everything, which is correct rather than broken.
* **Their own folder, and only their own.** `users.server_folder` is assigned on
  first use from their name — transliterated, so "Zoë Müller" is `Zoe Muller` and
  not `Zoe Mu ller` — and then **fixed**, so renaming an account does not start a
  second folder. It is UNIQUE, so two people with one name get a suffix rather
  than one folder. An upload may go nowhere else: the token names the folder and
  the gateway checks it.
* **An asset cannot move between projects** in this schema (`EDIT_FIELDS` in
  `src/routes/assets.js` has no `projectId`), which is why a reference recorded
  against an asset cannot be orphaned by somebody moving it.
* **Submitting is blocked while an upload is in flight**, with a sentence rather
  than a disabled button: a round submitted now would point at a folder that is
  still filling up.
* **A failure leaves the link alone.** Only the files that actually landed are
  recorded; if none did, the field keeps whatever the artist typed.
* **The files are shown under the submission afterwards**, with an *Open in
  Server tab* button beside each. Two different questions, answered separately:
  seeing that a round pointed at three files called these things is the same
  question as seeing the submission (`canViewAsset`), while opening one is a
  Server-tab question — `server.view` **and** the path inside a prefix this
  person holds. So `mayOpen` is computed per file by the server and a reviewer
  without the Server tab sees the names and no button, which is what the link
  above them already told them. The button opens the **folder**, not a download:
  the tab mints its own token for it and the scope is checked again.
* **Two screens outside the tab, and one small route for them.** The project
  form's link field and this upload box are drawn by people who need not hold a
  Server-tab permission at all — `project.edit` for one, `server.submit_upload`
  for the other — so neither can call `GET /api/server/state`, which is the tab's
  single request and needs `server.view`. They ask `GET
  /api/server/page-context`, which answers to either of their own permissions
  with the prefix, the address and the limits. (Not `/auth/me`: that is polled
  every twenty seconds by every signed-in browser.) Until that route existed both
  screens asked for `/state`, got a 403, and drew themselves as though nothing
  had been configured — a link field disabled with *"an admin needs to set the
  server link prefix"* on a studio that had set one, and no upload box at all,
  with nothing on screen saying why. `tests/server-submit-browser.test.js` drives
  both as people who hold exactly one of the two permissions.
* **The old way keeps working, side by side.** Paste a link and submit — from a
  machine that has nothing to do with the prefix, if that is where the work is.
  That is the flow every artist uses today, it is untouched, and it is what
  happens for every project and person outside the pilot. Switching either switch
  off puts everybody back on it with nothing else changed.

### Tokens

Ed25519, signed by Forge, verified by the gateway with **public keys only**.
Claims: issuer, audience (the gateway id), user, operation, path, expiry, a
one-time id, and for an upload its id and maximum size.

| Operation | Lives | Reusable |
|---|---|---|
| `list` | 60 s | yes, for one folder (pagination) |
| `mkdir` | 60 s | no |
| `download` | 60 s | **no — once** |
| `upload` | 30 min | yes, for one upload id; renewable through Forge |
| `selftest` | 60 s | yes |

Rotation keeps the previous public key published for an overlap window (default
60 minutes), so a token minted a second before a rotation still verifies. The
same arrangement covers the gateway secret.

### Uploads

Chunked and resumable, because a 40 GB render is not a web form. The browser
reads the file with `File.slice` and never holds it in memory; each chunk is
written by positional write into a file the gateway preallocated, so chunks may
arrive out of order and finishing is a **move, not a copy**. `GET
/v1/upload/:id/status` returns the byte ranges that arrived, so a reload resumes
from what is actually on disk.

Finishing claims the final name with `link()`, which fails if the name is taken —
so a collision becomes `name (2).ext` and an existing file is never replaced —
and then unlinks the source inside `.incoming`. The stored file is made
read-only. The SHA-256 is read back **after** the move and reported by callback,
which is why the page says *verifying…* and then shows a short checksum.

### Deletion requests

Row menu → **Request deletion**, with a required reason. Everybody holding
`server.manage_requests` is notified in-app (always) and by email (a switch,
default on, through the existing mail outbox). A second request for the same path
while one is open is refused — the unique key on the open path makes that a fact
about the schema rather than a race two requests can both win.

**Resolving one deletes nothing.** Marking it *done* records that somebody
removed the file on the office server itself, which is a job done on that
machine with an account that is allowed to; Forge holds no route, credential or
code that could do it. The requester is told either way, with the admin's note.

### What the tab does when a browser will not cooperate

A browser spike run before any of this was built found that current Chromium —
Chrome and Edge share the engine — refuses a `fetch` from a page on a **public**
address to a server on a **private** address until the user grants *Local Network
Access*, and refuses it by **hanging**: nothing on the wire, no console error, no
CORS error. An iframe is gated the same way. A **top-level navigation** is not,
and neither is a page talking to its own origin. Measured in Chromium 141; the
control was the same gateway bound a second time on a public-space address, which
answered in 13 ms.

So the tab decides its transport **without making a request**, which is what
keeps it from triggering a permission prompt just by being opened:

```js
try { state = (await navigator.permissions.query({name:'local-network-access'})).state }
catch (TypeError) { /* this engine has no such gate */ }
```

* **The desktop app** (Electron 33 / Chromium 130) throws — no gate — so it talks
  to the gateway directly.
* **A policy-managed browser** reports `granted`. Same.
  `LocalNetworkAccessAllowedForUrls` is the policy, and it is verified to work;
  the older `InsecurePrivateNetworkRequestsAllowedForUrls` has no effect in
  current Chromium.
* **Anything else** gets the **office link window**: a small page served by the
  gateway, opened top-level, which relays between the Forge tab and the gateway
  over `postMessage` — `File` and `Blob` slices travel by structured clone. Its
  own fetches are same-origin and private-to-private, which nothing gates.

**That window is opened by a click, and only by a click.** Never on page load,
never on a render, never because a listing happened to need one. A window that
appears on its own is what a pop-up blocker exists for, so for some people it
would be blocked and nothing on screen would explain why nothing worked — and a
window that relays somebody's files to a machine in the office should be one they
opened. So a call that needs the bridge **refuses with "the window is not open"**
instead of opening one, every screen that can need it draws a *Connect to office
server* button, and a blocked pop-up says so and what to do about it. The tab and
the submit box both show which transport is in use, because *"why is there a
second window"* and *"why is there not"* are both reasonable questions.

**Both directions are pinned to the gateway's exact origin** — the address an
admin configured, not a suffix match and not whatever a message claims about
itself — and a message must come from the window Forge opened (`e.source` is
compared with the handle), so another tab at the same origin cannot answer for
it. **No token is ever in that window's URL**: its address is in the browser's
history and in the person's title bar, so what travels over it is the page, and
everything else arrives by `postMessage` after the handshake.

**Closing it mid-upload is a pause, not a failure.** The chunks already written
are on the share, the gateway knows which ranges it has, and reopening resumes
from what `GET /v1/upload/:id/status` reports.

The **optional upgrade** for an office that would rather not have the second
window: the `LocalNetworkAccessAllowedForUrls` policy on Chrome or Edge, which
makes the permission report `granted` and the tab talk to the gateway directly.
It is an upgrade and not a requirement — everything works without it.

### Clock skew

The gateway allows **±30 seconds** between its clock and Forge's when it checks a
token's expiry (`GATEWAY_CLOCK_LEEWAY_SECONDS`, hard-capped at 120). An office
machine whose clock has drifted by a minute would otherwise reject every token
with nothing on screen explaining it. The heartbeat carries Forge's time, the
gateway records the difference, Settings → Server **warns above 15 seconds**, and
`npm run doctor` **fails** above the leeway — so the drift is visible before it
becomes a mystery, and the cure is NTP rather than a bigger leeway.

Downloads are always a top-level link with a single-use token, in both cases:
it is the only mechanism that survives a very large file and it hands the work to
the browser's own download manager.

### What is stored here

| Table | What it holds |
|---|---|
| `server_settings` | One row. The switch, the address, the encrypted secrets, the limits, the shared folder names. |
| `gateway_state` | One row, overwritten. The last heartbeat: version, free disk, applied config version. |
| `server_events` | The audit trail — who listed, was issued a download, started or finished an upload, created a folder, ran a self-test. Actions on paths, not an index of the share. |
| `deletion_requests` | Path, type, who asked, why, status, who answered and their note. |
| `server_submission_files` | **References, not files**: which asset, which version, who, the relative path and the name. A row says "this submission points at that file on the office server" — it is not a copy, a cache or an index of the share. |
| `projects.server_link` | The link somebody pasted, exactly as typed. |
| `projects.server_submit_enabled` | Whether the submit-work upload is on for this project. |
| `users.server_folder` | The person's own folder name, assigned once. |

No file table. No file content. No deletion state — there is nothing here to
delete. `tests/server-tab.test.js` fails on any `BLOB` column or any table that
looks like an index of the share.

## Acting Team Leads

A fourth section on Add/Edit Project, after Team Leads: people standing in as a
lead on **one project**, without being a Team Lead by designation and without it
meaning anything anywhere else.

**The picker lists every active user**, which the three sections beside it
deliberately do not — each of those offers only the designations its name
implies. The point of a stand-in is that it can be whoever can do the job this
fortnight, and a designation filter here would re-impose the constraint the
section exists to relieve. The only filter is "still works here".

### What it does, and what it carefully does not

| | |
| --- | --- |
| Sees the project | **yes** — whatever their role's scope, including the narrowest |
| Acts at TL Review / TL Feedbacks / Submit Feedback | **yes**, on that project |
| Can Hold | **yes**, under the existing "visible ⇒ can hold" rule |
| Gets the submission notification and email | **yes**, added to the existing audience |
| Role, designation, permission list | **unchanged** — byte for byte |
| Any of the above on another project | **no** |

### Storage

`project_acting_team_leads (project_id, user_id)`: a composite primary key and
cascades both ways, the same two columns as `project_team_leads`,
`project_coordinators` and `project_supervision`. No `added_by`/`added_at`,
because none of those has them and a fourth list that recorded more than its
siblings would make "who put this person here" answerable for one section and
not the rest. Existing projects start with none. Membership rides on the same
`project.update` activity entry as every other section.

### One list, four tables

`PROJECT_TEAM_TABLES` in `src/permissions.js` was already the single definition
of "may act as a lead here" — and it already unioned in coordinators and
supervision, so the gate has never been Team Leads alone. Acting leads are a
fourth entry in it, which is most of the feature: the review gate, the board
enrichment and the history authority all follow from that one edit.
`projectLeadIds()` and `isProjectLead()` are the named shared functions; nothing
else may read the new table, and `tests/acting-team-leads.test.js` fails on the
first file outside a short allowlist that does.

### Visibility is a union, not a clause

Being an Acting TL makes that project visible **regardless of role scope**. It
is applied as one union around all four scope queries rather than as a JOIN
inside two of them — written the other way it would have left the two *narrowest*
scopes, `owned` and `own_work`, unable to see a project they had been put in
charge of, and `own_work` is exactly the designation a studio names a stand-in
from. It adds the projects they are acting on and nothing else.

### The one thing that is not just membership

`canActAtTlGate()` begins `holds(user, 'review.tl')` — a **role-level** key a
game artist does not have. Every list that could previously reach that gate was
already filtered to designations that hold it; the acting list is not. So
membership of the acting list — **and only that list** — stands in for
`review.tl`, for the project it names and nowhere else.

This is a project-scoped grant, not a permission: it is absent from the person's
effective list, `/auth/me` is unchanged, their designation is untouched, and on
every other project they are the artist they were this morning. A test compares
their whole permission set against another artist's and asserts equality.

### "(Acting TL)" in the history

`asset_events.acted_via` has existed since Prompt 36 and was read by nothing —
the screen showed who acted and never on what authority. It is now written for
every transition the review gate guards (derived from the workflow table, with a
test holding the two equal) and surfaced beside the actor's name.

The label is `acting_team_lead` **only when the acting list is the person's sole
qualification**. Somebody who is also a Team Lead, a coordinator or supervision
on the same project would have passed the gate without the acting row, so they
keep the label they had. The ordinary `team_lead` case stays unannotated —
labelling every approval the studio has ever made would be new noise on old rows.

### Overlap

There is **no overlap rule between the three existing sections** and none was
added: somebody can be a lead and a coordinator and supervision at once, and the
gate unions them. The one new rule is that the same person cannot be both Team
Lead and Acting Team Lead on one project — that is not two jobs, it is one job
recorded twice. The picker disables them with "Already a Team Lead on this
project" and the server answers **409**. Swapping somebody from one section to
the other in a single save is allowed, because it is a legitimate edit.

### Removal, and nobody left

Removal is structural. Nothing is ever stored as waiting on a *particular* lead:
a review stage routes to `null` — "a review queue, picked up by whoever holds
that gate" — so taking somebody off the list removes them from a set-membership
test and no work moves, because none of it pointed at them. With no lead left at
all, `projectHasReviewTeam()` goes false and the gate falls back to the
pre-team path, exactly as it does for a project whose Team Leads are removed
today. Deactivation is unchanged: the row stays, and the person stops qualifying
because every picker filters on `is_active`.

## Leave and Idle

Two marks a lead can make against somebody's day, from the "People to follow up"
lists: **Leave** (First Half, Second Half or Full Day) and **Idle**. They are
not the same kind of thing and the difference is the whole design.

**Leave changes what somebody's hours add up to.** No time inside the window
counts for them, a running timer is stopped at the moment the window opened,
and work cannot be started until it ends. **Idle changes nothing at all**: it
records that there is nothing on their desk, removes no hours, blocks no
assignment and no start, and clears itself the instant anybody assigns them
something.

### "Idle" already meant something else, and still does

`src/idle.js` is a **report**: measured coverage — the working hours in a period
during which somebody had nothing open — computed from sessions and recorded
nowhere. This feature's idle is a **mark** somebody makes. Two ideas, one word.
Nothing was renamed and nothing was merged: the module is `src/day-status.js`,
the report is untouched, and a test asserts neither reads the other. A report
quietly treating a lead's opinion as a measurement is the one bug nobody would
notice.

### The switch ships off, and "off" does not mean "ignore"

Settings → **Leave** has one master switch, **off by default**. Until an admin
turns it on there are no buttons, the endpoint answers `409 feature_disabled`,
and no mark can be made.

**Switching it off later does not undo anything.** An existing mark keeps its
full effect — the hours stay excluded, the timesheet rule stays, the timer stays
blocked — and can still be undone. The alternative would mean that flipping a
switch changed last month's totals, twice, in opposite directions. A setting
that rewrites history is not a setting. So the switch is read at the point a row
would be **created** and nowhere else: `src/day-status.js` never asks it, and a
test asserts that the word does not appear in the hour arithmetic, the timesheet
gate or either reminder path. While marks are in force and the switch is off,
the strip stays visible with Undo and a banner says so — nothing is ever stuck.

### The half-day split is a snapshot

Settings → Leave holds two times, **First Half ends at** and **Second Half
starts at**. Until somebody saves them they are **prefilled from the studio's
lunch break** (13:00 and 14:00 as seeded), or from the midpoint of the working
day if there is no lunch; a "Reset to lunch times" link restores the suggestion.
Prefilled and saved are different states in the column — `NULL` versus a number
— which is what lets the screen say "not set yet" and lets Reset have something
to restore.

When a half-day is recorded, the window in force is **copied onto the row**. The
windows are deliberately wide — first half is midnight to the split, second half
is the split to midnight — because time outside working hours is already removed
by the working-time helper, and narrowing them here would be a second, weaker
copy of that rule.

**Moving the split re-snapshots only rows dated strictly after today.** Today's
and every past one keep theirs, so a figure somebody has already signed off
cannot move because an admin changed a setting this afternoon. (The future rows
are Prompt 49's planned leaves; the column and the re-snapshot exist now so that
prompt adds rows rather than rules.)

Validation refuses a split outside working hours and a second half that begins
before the first ends. A **gap of ordinary working time** between the two halves
is a warning and not a refusal: it is a legitimate thing to want and a
surprising thing to do by accident, and blocking it would be this code deciding
a studio's hours for it.

### One function counts the hours

```
countedMsByDay(span) = workingMsByDay(span) − workingMsByDay(span ∩ leave)
```

Written as a subtraction over the **same** function rather than as a second walk
that knows about both, so there is exactly one piece of code that decides what
"inside working hours" means and leave is a thing removed from its answer. Every
figure in the application comes through it:

| Where | What it is |
| --- | --- |
| `close()` | the `seconds` a session stores when it ends |
| `dayTotalFor()` | the Time Sheet's per-day figure, recomputed at read time |
| `liveSeconds()` | what a session still running has accrued so far |

`work_sessions.seconds` is a **cache** of that function over the session's span,
not a second opinion about it — which is what lets the four reports that sum the
column go on summing it. Marking or undoing a leave **recomputes** the rows the
date touches, so a mark made after the sessions closed reaches those totals too.
**Undo restores exactly the previous numbers** because it derives them again
rather than remembering them. Nothing is deleted: the sessions stay, the
timesheet lines stay, and the day carries an "overlaps leave" marker.

### What each mark means for the rest of the app

| Question | Full day | Half day | Idle |
| --- | --- | --- | --- |
| Do the hours in the window count? | no (whole day) | no (that half) | yes — idle removes nothing |
| Is a timesheet required? | no | **yes** | **yes** |
| Does the previous-day timesheet rule block them? | no | yes | yes |
| On the "not started" list? | no | only once the window has passed | no |
| Start-of-day banner, automatic reminders, Remind? | no | not inside the window | no start nudge; the timesheet one still applies |
| Can work be started? | no | not inside the window | **yes** |
| Can they be assigned work? | yes | yes | **yes — and it clears the mark** |

A half-day person who is back and still has not started **stays on the list**
with a "Leave: first half" chip. That is the one case where a mark reaches a row
at all, and it is the sentence a lead cannot get anywhere else.

**Prompt 46's waiting time is not paused by leave.** How long an asset has been
waiting is a fact about the asset; an absence does not shorten the wait it
caused. The panel is annotated "(on leave)" instead.

### The timers

A mark stops the person's running timers **at the moment the window opened** —
not at the moment the sweep gets round to it, which is the same mechanism the
seven o'clock cutoff uses and is what makes the figure right however late the
sweep is. A timer left running from yesterday is stopped too, and its earlier
portion counts under the ordinary rules.

The pause reason is **`on_leave`**, a third `PAUSE_REASON` beside `held` and
`off_hours`. It is a pause in every sense — the round stays open, the
one-active-task slot is freed, Resume works — but it is **never auto-resumed**:
`resumeOverdue()` picks up `off_hours` and only `off_hours`, so a leave pause
falls out of that sweep by being a different word rather than by a special case
somebody could delete. The person starts again themselves.

Windows that open later in the day are settled by the **existing** work-hours
sweep (`WORK_HOURS_SWEEP_MINUTES`), which now runs the leave pass first. No
second scheduler was added.

### Idle, and the auto-clear that cannot be forgotten

Idle can be marked only for **today** and only when the person has **no
actionable assets** — the union of `ASSIGNEE_STATUSES` and `WORKING_STATUSES`,
derived from `src/asset-workflow.js` rather than written out a third time. The
page disables the button with the reason on it; the server re-checks both and
answers `409 has_assets` or `409 idle_not_today`.

The mark clears itself from **`assignments.open()`**, which is the one function
every assign path in the application goes through — the panel dropdown, bulk
assign, reassign, create-with-assignee and the history repair. A test asserts
that nothing else in `src/` writes `asset_assignments`, so the sixth path
somebody adds later is covered without them having to remember. The clear runs
in the same transaction, never throws and never refuses: an assignment that
failed because a cosmetic mark could not be cleared would be a far worse bug
than a stale mark.

### Permissions: four keys, because four different powers

| Key | What it is |
| --- | --- |
| `followup.mark_leave` | record and undo leave — **this changes recorded hours** |
| `followup.mark_idle` | record and undo idle — this changes nothing |
| `followup.mark_past_dates` | do either on a date that has already passed |
| `settings.leave.manage` | Settings → Leave: the switch and the split |

All four are **Super Admin only** by default, through `managePermissions`, and
all four are grantable per designation and through role groups. The settings key
is deliberately **not** the marking key: delegating the daily act of recording
somebody's absence does not thereby delegate the decision to switch the feature
on or to move every future half-day in the studio at once.

Every endpoint uses `requirePermission` and the page uses `can()`, **never the
tier** — with one stated exception: *marking your own day* is refused to
everybody but the Super Admin tier, because that is the absence of a separation
rather than a power to delegate, and the tier that can grant itself every key
anyway is the only one for whom the separation would be theatre.

The actor can only mark people inside their own `visibleProjects()` scope — the
section's own rule, asked of the same function the lists ask — and the refusal
names nobody, so it cannot be used to discover whether an id is a person.

### What is recorded

`user_day_status` holds one row per mark: the kind, the portion, the window
snapshot, a note, who set it and when, and who cleared it and why. **At most one
active row per person per day**, enforced by a unique key over a generated
column that is the date while the row is live and `NULL` once it is cleared — so
cleared rows fall out of the index and stay in the table as history. Marking
something else clears what was there and keeps it. Two leads marking one person
in the same second are arbitrated by the key, not by a check, and the duplicate
comes back as a refusal rather than as a second row.

The person is told through the existing notification mechanism when they are
marked or unmarked. **No email** — an attendance mark leaving the building
through a shared mailbox is a decision a studio should make deliberately.

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

### Secrets, and what must be rotated

**No secret for this feature is in any tracked file**, and `.env.example` carries
the three Gmail names commented and empty. A test asserts both: that the only
tracked `.env*` file is the template, that `.env` is git-ignored, and that none of
`GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET` or `GMAIL_REFRESH_TOKEN` carries a value
in it.

**The refresh token is an environment variable, not a database row** — the brief
allowed either on condition that a stored one is encrypted at rest, and this is
the choice with its reason. There is already one reversibly-stored secret here
(the SMTP password, encrypted by `src/email-secret.js`), and **that module falls
back to `JWT_SECRET` when `EMAIL_ENCRYPTION_KEY` is unset**, which on this
deployment it is — with `JWT_SECRET` still the shipped placeholder. Storing a
Gmail refresh token under that arrangement would mean encrypting a credential
that grants send-as rights to the studio's sales mailbox with a key published in
this repository's own example file. A refresh token is set once in the life of a
deployment; the environment has no such problem.

#### `.env` was already untracked — and the values are still in history

The brief asked for this to be fixed in this change. **It was already done**, in
commit `2e5c73b` ("Settings from the host's environment: remove the tracked
.env, validate at start-up"): `.env` is out of the index, `.gitignore` carries
both `.env` and `*.env` with `!.env.example`, and the template exists. Nothing
needed changing and nothing was.

**What is NOT fixed, and cannot be fixed by a commit:** `.env` was *added* in
commit `c01af8d` and its contents are still in the reachable history. Removing a
file from the index does not remove it from the commits that contain it.

**So these must be rotated, by name — they were committed with real values:**

| Variable | What to do |
| --- | --- |
| `DB_PASSWORD` | **Rotate now.** cPanel → MySQL Databases → change the user's password, then set the new value in the environment |
| `JWT_SECRET` | **Rotate now.** It also still holds the shipped placeholder, which is a second and worse problem — anybody with the repository can mint a session token. Changing it signs everybody out, which is the intended cost |
| `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `PORT`, `CORS_ORIGIN`, `TRUST_PROXY`, `LOGIN_RATE_MAX`, `LOGIN_RATE_WINDOW_MINUTES` | Not credentials. No action, listed so the set is complete |

**And set `EMAIL_ENCRYPTION_KEY`** to its own long random value, so the stored
SMTP password stops depending on `JWT_SECRET` — otherwise rotating `JWT_SECRET`
makes that password undecryptable, which is why `src/email-secret.js` has the
fallback at all.

**Rewriting history would also be needed to remove the values** (a filter or a
fresh repository), and that is a decision about a shared remote rather than
something to do unasked. Rotation makes the leaked values worthless, which is the
part that actually protects the studio.

### Sending email through Gmail

**Which way mail leaves is one variable**, `EMAIL_TRANSPORT`:

| | |
| --- | --- |
| `gmail_api` | The Gmail API over HTTPS on port 443. What this studio uses, because its host blocks outbound SMTP ports — `src/mailer.js` has three paragraphs about that and `scripts/check-outbound.js` exists to prove it |
| `smtp` | The mail server configured in Settings, through nodemailer. **Still supported**, not deprecated: a studio that moves to a host without the port restriction changes one variable back |
| `log` | Writes a line and claims success. Development and the test suite, which therefore need no credential and no network |

**The default is `smtp`** — what this application did before the Gmail transport
existed. An upgrade that silently re-routed a studio's mail through an
unconfigured Gmail account would be a studio whose email stopped.

**No new dependency.** Two POSTs and Node 22's global `fetch`, rather than
`googleapis` (tens of megabytes of generated clients) or `google-auth-library`
(which pulls `gtoken`, `gaxios` and `jws`). Nothing to audit, nothing to keep
current, and nothing that breaks on a Node upgrade — which matters on a host
where upgrading means a support ticket.

#### Setting it up in Google Cloud

A non-developer can follow this. It is done once.

1. **Google Cloud Console** → create a project (or use an existing one).
2. **APIs & Services → Library** → search *Gmail API* → **Enable**.
3. **APIs & Services → OAuth consent screen**. This is the step that differs by
   domain — see the two cases below.
4. **Scopes**: add exactly one, `https://www.googleapis.com/auth/gmail.send`.
   Nothing else. It can send as the mailbox and **cannot read it**, which is what
   makes this safe to approve for a live sales inbox.
5. **APIs & Services → Credentials → Create credentials → OAuth client ID**,
   application type **Desktop app**. That type offers the redirect this script
   uses, so no web server or spare port is needed.
6. Copy the **client ID** and **client secret**. Do not put them in a file in
   this repository — see *Secrets* below.
7. On the server, once:

   ```bash
   export GMAIL_CLIENT_ID="…apps.googleusercontent.com"
   export GMAIL_CLIENT_SECRET="…"
   node scripts/gmail-authorize.js
   ```

   It prints a URL. **Open it in a normal browser** — Chrome, Safari, Edge.
   **Not inside the ZVKY FORGE desktop application**: Google refuses OAuth
   sign-in in an embedded web view and answers `disallowed_useragent`, so a
   "Connect Gmail" button in the app would be refused by Google and would look
   like our own bug. Sign in **as the sender mailbox itself**, approve the one
   permission, paste the code back.
8. Set what it prints as environment variables (on cPanel: *Setup Node.js App →
   Environment variables*), restart, then **Settings → Email (Gmail) → Send test
   email**.

#### The two domain cases, and nothing depends on which

It is **not yet confirmed** whether `zvky.com` is a Google Workspace domain. Both
cases work with the same code and the same variables; only step 3 differs.

**If it IS a Google Workspace domain.** Choose **Internal** on the consent
screen. There is no verification, no review, no warning screen, and — the part
that matters — **no expiry on the refresh token**. It keeps working until
somebody revokes it or changes the mailbox's password. This is the case to want.

**If it is a free Gmail account** (or any non-Workspace address). Internal is not
offered; the app must be **External**, and a new External app starts in
**Testing**. In Testing:

- the mailbox must be added under **Test users**, or consent is refused outright;
- **refresh tokens expire after seven days.** On the eighth day sending stops
  with `invalid_grant`, and the only fix is to run the authorisation script
  again. That is not a bug in this application and the Settings banner says so.

**So publish the app.** On the consent screen press **Publish app**. For a
single sensitive scope used by its own owner this moves it to *In production*
without a verification review, and the seven-day expiry goes away. Until it is
published, expect to re-authorise weekly.

**The application copes with either** without being told which: an expired or
revoked token is an `invalid_grant`, which is treated as a *connection* failure —
the queue pauses, messages are held, every Super Admin gets an in-app notice and
the Settings banner reads *"The Gmail connection needs to be re-authorised"*.
Nothing is lost and no message burns its retries. Re-authorise, restart, and the
queue drains itself.

#### The queue, and how a failure is counted

Every notification is written to `email_outbox` and sent by a worker afterwards.
**This is new**: before it, `src/email-notifications.js` batched in memory,
retried once after 250 ms and swallowed the error — which loses every email
raised during an outage. The retry schedule is **imported** from
`src/integration-outbox.js` rather than restated: 1 minute, 5, 30, 2 hours, 6,
24, then failed. Six retries, seven attempts, a little over a day.

The three ways a send can fail are counted differently, and that is the whole
design:

| | |
| --- | --- |
| **Temporary** — network, 5xx, 429 | One attempt counted, backed off on the schedule, failed after six. A `Retry-After` longer than the backoff **wins**: overruling a rate limit is how the next answer becomes a block |
| **Permanent** — bad address, injected header, oversized | Failed **at once**. Spending six attempts over a day on an address that will never be valid is how a queue fills with work that cannot succeed |
| **Connection** — `invalid_grant`, revoked token, 401 after a refresh, missing scope | **Nothing is written to the row** — not the attempt, not the error. The queue pauses, a Super Admin is told, and when the connection returns every held message still has all seven attempts |

**The permanent-failure alert cannot loop.** It is itself an email, so if the
transport is what is broken it cannot go through the transport. The in-app notice
is raised *always*; the email is queued only when the transport is healthy, and
the connection alert is **in-app only** by construction. One notice per outage,
not one per pass.

#### Throttling, and the defaults

**The sender mailbox is a real one**, read by people and used for customer
correspondence; this application is a guest in it. Gmail's own ceiling is 2,000
recipients a day on Workspace and 500 on a free account, and hitting either would
stop the studio's **sales** email, not just its notifications. So:

| | | |
| --- | --- | --- |
| `EMAIL_DAILY_CAP` | **300** | Well under the lower of the two ceilings, and about ten times the busiest day this application could plausibly produce |
| `EMAIL_MAX_PER_MINUTE` | **10** | Forty notifications raised in one second by a bulk assignment look like a burst to a spam filter; ten a minute spreads it over four minutes |
| `EMAIL_DAILY_WARN_FRACTION` | **0.8** | A Super Admin is told once a day at 240 sent |

At the cap, sending **stops and resumes tomorrow** — messages are held, not
failed.

#### Delivery is at least once

**A send can succeed at Google and the response be lost on the way back.** The
message is then retried and somebody gets two copies of a notification. This is
recorded rather than hidden, because the fix is worse than the problem: knowing
for certain would mean searching the mailbox for our own `Message-ID`, which
needs `gmail.readonly` — **read access to a live sales mailbox** — added to the
consent screen, to suppress a rare duplicate *"you have been assigned FX-014"*.
What is done instead is free: every message carries a stable `Message-ID` of our
own, Gmail's returned id is stored on the row, so a duplicate is identifiable
afterwards.

#### Reply-To

`GMAIL_REPLY_TO` is optional. Set it when replies should go somewhere other than
the sender mailbox — a shared inbox, say, when the sender is a shared sales
address nobody watches for replies to notifications. **From is always the
authenticated mailbox**: Gmail rewrites any other address, so accepting one would
mean building a message whose From we know will be replaced.

#### Watching it

**Settings → Email (Gmail)**, behind *Email Delivery Status*
(`settings.email_delivery`) — **Super Admin only by default**, enforced with
`requirePermission` on every route and `can()` on the page, never a tier. It is
its own key beside *Manage Email Configuration*, the same split
`settings.holidays_view` has from `settings.holidays`: this one answers "is the
mail going out" and sends a test to **your own address**; that one edits the mail
server and holds a live password.

**No endpoint returns a secret.** What a missing credential produces is the
**name** of the unset variable — `GMAIL_REFRESH_TOKEN is not set` is actionable;
the value would be a credential in a browser's network tab. Errors carry the
credential **masked** (`refr…(23 chars)`), which is enough to tell a stale token
from a mistyped one and useless to anybody who reads it. A test asserts the
status payload against every secret the server holds, and against field *names*
containing `secret`, `token`, `password` or `refresh`.

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

## The page asks its own questions

**No `prompt()`, no `confirm()`, no `alert()` anywhere in the served files.**
[`tests/no-native-dialogs.test.js`](tests/no-native-dialogs.test.js) fails the build if one
comes back, and its allow-list is empty on purpose — there is no reason that survives the
question *"what does this do in Electron?"*.

### Why: the fifth report of the Hold button

The first four were about the permission rule. The fifth was not: **Hold worked in a browser
and did nothing at all in the installed desktop application.**

That application is [`desktop/`](desktop) — Electron, which loads the studio's own URL in a
`BrowserWindow`. There is no bundled copy of the web app in it, so it cannot be running old
assets of its own; it gets whatever the server serves, over the same HTTPS, revalidated on
every load.

**Electron does not implement `window.prompt()`.** `typeof window.prompt` is `"function"` —
so a feature check passes — and calling it throws `Error: prompt() is not supported.` Hold
asked for its optional note there, from inside an `async` onclick and **before** that
handler's own `try`, so the throw became an unhandled promise rejection. Measured on
Electron 33.4.11 / Chromium 130, running the shipped handler's own shape:

```
{ requestsSent: 0, buttonDisabled: false, errorBoxText: "",
  pageSaw: ["unhandledrejection: prompt() is not supported."] }
renderer console: Uncaught (in promise) Error: prompt() is not supported.
```

No request, no busy state, nothing on screen, one console line nobody was looking at.
**Resume passed `ask: false`**, never reached the prompt, and worked — which is exactly why
the report named Hold alone.

**And `confirm()` is not safe either**, for a different reason: Electron implements it as a
native modal that **blocks the renderer** until it is answered. Measured against a window
that was not visible, the renderer never came back at all. The whole application freezes
while one is up. That is why the thirty `confirm()` calls went with the seven prompts rather
than being left as "the ones that work".

### What replaced them

**38 call sites** — 7 `prompt()`, 30 `confirm()` in `public/index.html`, and one `confirm()`
in `public/native-bridge.js` that the test found rather than reading did. Zero `alert()`
existed.

One shared `openAsk()`, reusing the existing `.modal-wrap` / `.modal` component and its
colour tokens, with two forms over it:

```js
await askConfirm({ title, message, confirmLabel, danger })   // -> true / false
await askText({ title, label, value, placeholder })          // -> string / null
```

* **Enter confirms, Escape cancels.** The `keydown` listener is bound **once** on the
  document rather than per dialog — one added each time a question opens is one left behind
  each time it is answered, and after a dozen questions an Escape cancels something that is
  not on screen. Enter is ignored inside a `<textarea>`, where it means a new line.
* **Cancel is `null`, not an empty string**, for a text question. Every call site tells them
  apart; conflating them would turn a cancelled rename into a rename to nothing.
* **A missing dialog rejects loudly.** If `#askWrap` were gone, answering "cancelled" would
  make every destructive action in the application quietly do nothing — the exact shape of
  the bug this is a fix for.
* **`window.askConfirm` and `window.askText` are exposed**, for `native-bridge.js`: it runs
  the Android hardware back button, which asks before leaving, and `const` at script scope
  is not reachable from a second `<script>`.

### Hold specifically

It uses `openAsk`'s **`run`** form, so the modal owns the whole act:

| | |
| --- | --- |
| before confirming | the question is on screen; **nothing has been sent** |
| while sending | the button reads **"Holding…"**, both buttons dead |
| on failure | the reason is shown **inside the question**, which stays up, with the button live again |
| on success | the question closes, the card is redrawn, a toast says so |

There is no path through that handler that shows nothing.
[`tests/dialog-flow.test.js`](tests/dialog-flow.test.js) drives all five against a real
server with `prompt`, `confirm` and `alert` passed in as functions that **throw**, and
asserts the `work_sessions` row read back out of the database — "the request was sent" is
not a spy count, it is a clock that actually stopped.

### Nothing fails silently

**The real lesson of this report.** The bug was not really `prompt()`; it was that a click
handler could throw and the person be told nothing.

* `window.onerror` and `unhandledrejection` reach the screen as a toast — rate-limited, and
  ignoring the no-`.error` events a failed image raises.
* Hold's and Resume's handlers go through `guarded()` as well.
* Resume's `catch` tells two failures apart: a **refusal** carries a status and `send()` has
  already put the server's sentence in the panel, so it stops there; **anything else** is
  rethrown into the guard. A bare `catch{}` was how the original bug looked.

### Two things found while surveying

**The Send to Dev & QA modal never appeared, in any browser.** `openSendToDev()` added
`.open` to its wrap and there is no `.modal-wrap.open` rule anywhere in the stylesheet —
only `.show`, which every other modal uses. Fixed.

**The wrapper refused clipboard writes.** With `ALLOWED_PERMISSIONS` holding `notifications`
alone, `navigator.permissions.query({name:'clipboard-write'})` read `"denied"` in that window
and `writeText()` rejected, so the Copy-path buttons fell through to a deprecated
`execCommand` that also failed — a person got *"Could not copy — select it and copy it by
hand"* where a browser copies silently. **The string Electron checks is
`clipboard-sanitized-write`**, not the web platform's name; measured by logging what the
handler was handed, because allowing the web name would have looked like a fix and changed
nothing. **Write only** — `clipboard-read` is deliberately still refused: the application
never reads the clipboard, and reading would expose whatever the person last copied anywhere
else.

### What the wrapper does and does not block

Measured with the shipped permission handlers, against a real page in a real window:

| | |
| --- | --- |
| **notifications** | granted to the studio origin, and only it. The web app's own `new Notification(...)` is routed to the OS |
| **clipboard write** | granted (above). **Read** refused |
| **downloads** | work. A blob with `a.download` and a server `Content-Disposition` both reach Electron's `will-download` |
| **new windows / popups** | `window.open` returns `null`; the URL is opened in the person's real browser instead, so this window can never become an address-bar-less browser. The page never calls it |
| **camera, microphone, location** | refused, from every origin |

`npm run smoke` in `desktop/` asserts all of it in a real window, including that
`window.prompt` still throws there and that the page carries `#askWrap` instead.

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

### Hold: your own task, or anything on your dashboard

`asset.hold` is `impliedBy: () => true` — every designation has always held it — so a lead
who could not pause a teammate's timer was **never missing a permission**. The gate was
`mine`: the asset had to be assigned to you. The studio asked for leads to be able to hold
their team's work, and this is the fourth attempt at it.

**This button has been reported four times, and the fourth report is the interesting one**,
because the first three were all answered correctly within a wrong premise:

| | What it found | What it missed |
| --- | --- | --- |
| 18 | the permission key and the two gates agreed | it only tried the assignee's own task |
| 20 | widened the rule to four named designation keys, on their own projects | two designations in the same group were left out |
| 36 | the rule was written out three times and carried no reason | **the scope itself** was project membership, not what a lead sees |
| 37 | project membership and the dashboard are different sets | — |

#### The cause, in one sentence

Prompt 36 scoped a lead's right to hold to `leadOrSupervisorProjects()`, which reads the
`project_team_leads` and `project_supervision` membership tables, while the dashboard and the
board are scoped to `visibleProjects()`, which for a lead's `team` scope **also** matches
being a production coordinator, owning the project, or simply having a direct report with an
asset in it — so every project a lead reaches by one of those three routes showed work they
could not hold.

**Measured, on a Team Lead built the way production builds one** — designation `team_lead`,
two artists reporting to them, named on one project out of three:

| Project reaches their dashboard because… | On the board | Hold button | `POST /hold` |
| --- | --- | --- | --- |
| they are on its **Team Leads** list | yes | yes | 200 |
| a **direct report** has an asset in it | yes | **no** | **403 `HOLD_NOT_YOURS`** |
| they are on its **coordinators** list | yes | **no** | **403 `HOLD_NOT_YOURS`** |
| nothing — not theirs | no (403) | — | 403 |

The third route is the one nobody had tested and the commonest in a real studio: having a
report with work in a project is the ordinary way a Team Lead comes to see it, while being
*named* on its Team Leads field is a separate administrative act with a cap on how many
people it takes. Every earlier fixture named the lead on the project, so every earlier
fixture agreed that everything was fine.

#### Can hold follows can see

**[`src/asset-hold.js`](src/asset-hold.js) is the only statement of the rule**, and it is
**pure** — every fact it needs is passed in — so the two routes can call it one asset at a
time while the board calls it for forty from batched queries, and so the whole matrix runs
with no server. It returns an **allowed/refused verdict with a code, a gate and a sentence**,
not a boolean.

`onDashboard` is a fact it is *given*. It is answered by `permissions.assetOnDashboard()`,
which calls `canAccessProject()` — which **is** `visibleProjects()` — plus the board's one
narrowing for contributors. There is deliberately no SQL anywhere in the hold path that
reimplements visibility: a second query meaning to say the same thing is the defect this is a
fix for, one level down, and it would drift the same way.

The checks run in this order, and the order is part of the rule because it decides which
reason wins when more than one applies:

| | Refusal | Code | Gate |
| --- | --- | --- | --- |
| 1 | we could not find out | `HOLD_UNKNOWN` | `unavailable` |
| 2 | the studio's switch is off | `HOLD_NO_PERMISSION` | `permission` |
| 3 | **out with a freelancer** | `HOLD_OUTSOURCED` | `outsourced` |
| 4 | nobody is on it | `HOLD_UNASSIGNED` | `assignee` |
| 5 | not yours, and you do not hold the lead key | `HOLD_NOT_YOURS` | `authority` |
| 6 | you hold the key, and it is not on your dashboard | `HOLD_NOT_VISIBLE` | `visibility` |
| 7 | nobody is working on it at this stage | `HOLD_WRONG_STATUS` | `status` |
| 8 | nothing to put down / nothing to pick up | `HOLD_NO_SESSION`, `HOLD_ALREADY_HELD`, `HOLD_NOT_HELD`, `HOLD_ALREADY_RUNNING` | `session` |
| | the schedule stopped it, and restarts it itself | `HOLD_STUDIO_PAUSED` | `schedule` |

**Five and six are two codes on purpose.** They read almost the same and point at two
different fixes — *grant the permission* and *put them on the project* — so they carry two
codes, two gates and two sentences. The gate travels in the refusal body as well as to the
log, because "authority" and "visibility" are two different investigations.

**`HOLD_UNKNOWN` is us admitting something, not refusing somebody.** The board's decoration
degrades rather than throwing, and when the visibility query is what failed, answering "not on
your dashboard" would be a lie about the studio. It answers **503**, not 403.

**The freelancer check is third, and that placement is a fix.** An outsourced task has no
internal assignee, so the assignee test used to catch it and answer *"Only the person a task
is assigned to can put it on hold"* — naming somebody who does not exist and hiding the real
reason. And `hold` had no freelancer check at all while `resume` did.

#### Leads are identified by permission, never by name

**`asset.hold_any`** — *Hold / Resume Any Visible Task* — `impliedBy anyOf(has('leadsTeam'),
has('managePermissions'))`.

The version this replaces compared a designation's **group** to the string `'Supervision'`. A
studio with a designation called "Team Lead - Art", or one that renames an existing one, fell
straight out of the rule because a string stopped matching. `leadsTeam` is the capability
`src/role-tiers.js` already uses to mean "runs a team" and the one `defaultsFor()` reads in
`fillsAProjectTeamList()`.

**On by default for eight designations**: the six in Supervision (Team Lead, Associate Team
Lead, Senior Team Lead, Art Supervisor, Associate Animation Supervisor, Technical Manager),
the **Associate Art Director** — who carries the `lead` tier and runs a team, and whom the
group test excluded on the grounds that an art director is neither a team lead nor a
supervisor; true of the title, and beside the point now that the rule is about what somebody's
dashboard shows them — and the **Super Admin**.

**Not full access.** Head of Production, CTO, General Manager and the two Leadership
designations have `projectScope: 'all'`, so this key would hand them every timer in the
studio. That is a real authority and should be an explicit grant in Settings rather than a
side effect of a tier. A studio that wants it switches it on; nothing in the code changes.

**The Super Admin is named in the implication** rather than arriving through the request-time
short-circuit in `effectiveFor`, so that `baselineFor(super_admin)` stays the complete
catalogue — an invariant a test asserts and which a key reaching them only through the
short-circuit would quietly break for every key added after it. The consequence is that a
Super Admin can stop any timer in the studio. Withholding it would mean special-casing a
designation out of a permission it holds, which this codebase does not do, and a hold is
recorded against whoever pressed it in `asset_events` and logged with its gate — so it is not
an invisible act.

**`asset.hold` stays the base permission** and is checked first, so a designation holding
`hold_any` without it is told the true reason: the studio's switch is off for them.

**Seeded idempotently.** `ensureHoldAnyDefaults` in [`src/migrate.js`](src/migrate.js) grants
it on existing installs, and touches **only rows still marked as written by the system**. An
administrator who turns it off for a designation stays off after this deploy and every one
after it — `updated_by_email` is what tells a seeded row from a decision, the same mechanism
`ensureReviewGateDefaults` next door uses for `review.tl`. A studio's own designation that
nobody marked as running a team is not granted, because nothing has decided that it should be.
[`tests/hold-migration.test.js`](tests/hold-migration.test.js) pins all of it, including two
re-runs after a named admin's revoke.

#### Which statuses, and the one case the list must not break

`WORKING_STATUSES` lives in [`src/asset-workflow.js`](src/asset-workflow.js), beside
`FREE_STATUSES` and for the same reason: more than one place has to agree on it. **Three
readers, one array** — `STARTABLE` on the `/start` route *is* that array rather than a copy of
it, because "a stage where the clock can run" is one idea and a task whose clock can start is
a task whose clock can stop.

| Status | Hold offered | Why |
| --- | --- | --- |
| Not Assigned | no | nobody has accepted it; `/start` refuses it too |
| **Assigned** | **yes** | on somebody's desk, waiting to be begun |
| **In Progress** | **yes** | the ordinary case |
| TL Review | no | handed in — on the lead's desk, and submitting closed the stretch |
| **TL Feedbacks** | **yes** | back with the artist to redo |
| TL Approved | no | past the first gate, between desks |
| CD Review | no | on the director's desk |
| **CD Feedbacks** | **yes** | back for rework once the lead relays it |
| **Game Feedback** | **yes** | a bug to answer, once the lead passes it on |
| Approved for Client | no | finished work, waiting to go out |
| Awaiting Client Feedback | no | outside the studio |
| Delivered | no | done |

**A running or held clock is stoppable in every one of them.** The list governs whether the
control is *offered*; it never refuses a session that is actually open or actually held. A
stretch opened legitimately whose asset has since moved on would otherwise be a clock nobody
could stop — which is worse than anything the list prevents, and is why the previous version
of this rule had no list at all. The previous reasoning is what keeps the list safe.

The page carries its own copy of the list — for the **sentence** that names the stages, not
for the decision — and a test holds the two equal, the same arrangement `FREE_STATUSES` has
with the dashboard's drag range.

#### The page draws the answer, and never computes one

Every asset in the board payload carries `hold_state`: `canHold`, `canResume`, and for each a
code, a gate, a sentence, and `offer` — whether a refused control should be drawn **disabled
with the reason** or not drawn at all. `offer` is the server's call, not the page's.

| Not drawn at all | Drawn, disabled, with the reason |
| --- | --- |
| `HOLD_NO_PERMISSION`, `HOLD_NOT_YOURS`, `HOLD_NOT_VISIBLE`, `HOLD_UNASSIGNED` | `HOLD_OUTSOURCED`, `HOLD_WRONG_STATUS`, `HOLD_NO_SESSION`, `HOLD_ALREADY_HELD`, `HOLD_NOT_HELD`, `HOLD_ALREADY_RUNNING`, `HOLD_STUDIO_PAUSED`, `HOLD_UNKNOWN` |

There is exactly **one** Hold control in the application — the asset detail panel — fed by one
endpoint (`GET /assets/project/:id`, which is what fills `state.assets`; the board, the Assets
List and every notification deep-link all open the panel from that same array).

**The local fallback is gone.** The page used to fall back to `mine && can('asset.hold') &&
a.work_open` for an undecorated row. That was a fourth copy of the rule — right for the
assignee and silently wrong for their lead, which is the exact failure all four reports are
about. The server now always sends an answer, including an explicit `HOLD_UNKNOWN`, so there
is no such thing as an undecorated row and nothing for the browser to guess at. The page asks
about `asset.hold` **nowhere**, which a test counts.

**The reason is drawn in words, not only in a `title=` tooltip** — an explanation nobody on a
touchscreen can reach. *"The Hold button does not work"* is what got reported four times.

#### Freshness, without a sign-out

A change in what a lead sees reaches an open screen on the normal cycle. `render()` re-fetches
the board on every pass, so the cards are always current; `refreshPermissions()` re-reads
`/auth/me` every 20 seconds, so a granted or revoked key takes effect on the next request with
no sign-out.

**An already-open panel is rebuilt when, and only when, the server's answer changes.** It used
to be rebuilt only when *permissions* changed — and a reassignment moves what a lead can see
without moving a single permission, which is the commonest way the two come apart. A
four-field signature (`canHold`, `canResume`, and each code) is compared on every board fetch.
Not an unconditional rebuild: the drawer carries text fields and a checklist, and redrawing it
under somebody mid-sentence is why the permissions branch was narrow to begin with.

#### Why, without reproducing it

**Every refusal is one line in the server log** —
[`src/hold-log.js`](src/hold-log.js) — with the gate, the reason code, the user, the
**designation**, the asset, its code, the project, the status, the session state, and whether
the task was theirs and visible. No names and no email: ids and the designation key are enough
to reproduce, and a log that discloses is a log somebody turns off. Three reports were
diagnosed by building a fixture and guessing which gate had fired.

**`GET /api/assets/:id/hold-explain`** answers the same question for somebody who is not
pressing the button. `?userId=` asks about another person and needs `settings.permissions` —
the key that decides who holds what, so the person who can change the answer is the person who
can read it. It returns the decision, the code, the gate and **the facts it was made from**,
and it calls the same `decide()` the routes call: an explanation that could disagree with the
decision would be worse than none.

#### Whose clock it is

**The reopened stretch belongs to the assignee.** `/resume` read `req.user.id`, which was
right for every resume before the widening because only the assignee could press it. Measured
afterwards: a lead resuming an artist's held task opened the new session **under the lead**,
the round read `who: "ana, tlA"`, the artist's hours accrued against their lead, the lead's own
one-active-task slot was consumed by work they were not doing, and the Idle Report credited
the lead with coverage for somebody else's afternoon. Hold never had this problem — it closes
the row that is already there, whoever's it is. Who *pressed* it is still recorded, in
`asset_events`, which is where the studio reads who did what.

**And the one-active-task rule asks about the assignee too.** It read `req.user`, so a lead's
resume was checked against the lead's slot and never against the artist's: measured, a lead
could leave an artist with **two** open stretches.

**The previous-day timesheet gate asks only when the clock about to run is yours.** With
`requirePreviousDay` on, a Team Lead resuming an artist's held task was refused with *"Fill
your timesheet for Friday 9 Oct to start work"* — the lead's own paperwork stopping the
artist's work. Not widened to check the *assignee's* timesheet instead: that would be a new
rule nobody asked for, and it would let one person's paperwork block another's.

#### What hold is not subject to

Not the holiday check, not the timesheet gate, not the one-active-task rule. Those are about
the **clock** rather than about authority, and putting work down must always be available to
somebody entitled to it — a studio shut for Diwali with a timer still running is exactly when
somebody needs to stop it. Resume *is* subject to all three, which is the asymmetry, and it is
asserted rather than assumed.

#### The query budget

**Visibility is the only question that costs a query**, so it is asked last and only when it
could change the answer. A cheap refusal — no permission, your own task, unassigned,
outsourced, or a designation without the lead key — comes back without it, pinned by pointing
the test process at a database that does not exist. The board asks it **once for the whole
page** and passes the answer into each row's decision, which is the same shape the membership
query had before it.

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

**One test file at a time, not one per core.** Ninety-six files in `tests/` start their own
server and run the whole startup migration against their own database. At the runner's
default concurrency that is one simultaneous boot per core against one MariaDB, and some
suite always loses the race: three consecutive full runs failed with "Server did not start"
in three *different* suites — `mis-project-access` at a 60s deadline, `auto-resume` at 150s,
`integration-outbox` at 300s — each passing on its own immediately afterwards. Raising the
deadline only moved which suite died.

**Two at a time was not enough, which is why this now says one.** The cap was `2` and
measured again as the suite grew: 12 boot timeouts in one run, with 11 failures concentrated
in `game-feedback-panel` — which passes 16/16 on its own. At `1`: **zero boot timeouts, 1796
of 1797 passing, about 16 minutes.** That is the honest cost of the cap, and it is the right
trade — a boot timeout is a capacity problem, and capping concurrency is the remedy for it,
whereas raising a deadline only hides which suite is starving. Override with
`TEST_CONCURRENCY=4 npm test` on a bigger machine.

**One file needs a browser rather than a database.** `tests/follow-up-layout.test.js`
measures the "People to follow up" row in Chromium: an overlap is a fact about a layout,
so the only honest test of one is a layout. It drives the page's real stylesheet and the
real row markup through `playwright-core` (a devDependency — no browser is downloaded)
and asserts from bounding boxes that no two non-nested elements in a row intersect at
1280, 1440 or 1920 px, that the Remind button is drawn over nothing anywhere on the
page, that no name or designation is broken mid-word, and that the page never scrolls
sideways. It needs a Chromium binary and looks for one at `$CHROMIUM_PATH`,
`$PLAYWRIGHT_BROWSERS_PATH/chromium`, `/opt/pw-browsers/chromium`, `/usr/bin/chromium`,
`/usr/bin/chromium-browser` and `/usr/bin/google-chrome`; without one — or on a
production install made with `--omit=dev` — it skips with a reason instead of failing.
The webfonts are not loaded (the stylesheet `@import`s them from Google and the test
blocks every outbound request), which makes it stricter rather than weaker: nothing in
it asserts a pixel width, only that boxes clear each other in whatever font the engine
falls back to.

`tests/day-status.test.js` covers Leave and Idle. Most of it is arithmetic over a
frozen clock rather than clicks, and deliberately: marking somebody on leave
changes what their hours add up to, and a figure that is wrong by an afternoon
looks exactly like a figure that is right, on every screen, until somebody
reconciles a month and cannot. The live half drives the real routes against a
real database — the switch, the timers, the scope rule, the idle auto-clear
through a real assignment, the re-snapshot, and that switching the feature off
changes no total.

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

`tests/timesheet-working-day.test.js` covers the day figure: the brief's own
example as arithmetic and then through the live `/suggest`, the same night as one
open row and as the two rows the sweep leaves, a stretch across the lunch block,
Friday evening to Monday morning, a holiday, a stretch wholly outside the hours,
one starting before the open, the four instants either side of 09:30 and 19:00,
a running session's two bounds, another person's time excluded and a lead reading
a member's figure (and the 403 when they may not), an empty day, a future day,
the per-day figures summing to the stretch exactly, a changed schedule
recomputing a past day, and that the asset's own total is left alone. Three of
its cases drive the page itself and assert it does no date arithmetic.

`npm run smoke:timesheet` in `desktop/` runs the same acceptance example in a
**real Electron window**, because the two reports before this one were both "it
works in a browser but not in the application". It builds its own studio through
the real API (`desktop/scripts/timesheet-day-fixture.js`, as plain Node — see the
comment there for why the window cannot do it), signs in, opens the Add line form
through the page's own functions, walks the client → project → asset pickers with
real `change` events, and reads 1 h on day 1 and 1 h 30 m on day 2 out of the
form. Its last case holds day 1's reply open past day 2's and releases it, to see
a stale answer refused by the live page rather than by a stub.

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
