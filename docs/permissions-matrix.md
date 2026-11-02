# Who can see what, and who can change it

> GENERATED — `node scripts/permissions-matrix.js`. `tests/permissions-matrix.test.js`
> fails if this file is stale. Edit `src/permission-areas.js`, not this.

Forge decides visibility with **permission keys**, never with a role tier: the page
asks `can(key)` and the server asks `requirePermission(key)`. Prompt 61 added a
**view key** to every area that had only a key for changing things, so a role can be
allowed to read a screen without being allowed to touch it.

**Write implies view.** Every write key implies its area's view key, so no existing
role lost anything: the roles screen shows the view as on and locked while any write
key is on. A view key given **alone** is the view-only role.

**A view key never widens scope.** It decides whether a screen opens, not which rows
it shows — `visibleProjects()` and the per-row checks are untouched.

## The audit, by class

| Class | What it means | Areas |
|---|---|---|
| **A** | already had a proper view key, enforced on the server and used by the page — **left exactly as it was** | 15 |
| **B** | had write keys and no view key: visibility came from the key that changes things — **view key added** | 20 |
| **C** | visible by role tier, or by nothing at all — **view key added, defaults reproduce today exactly** | 1 |
| **D** | self scope (my own week, my own inbox, a chat I am in) — **not governed by view-only roles** | 5 |

## Every area

| Area | Class | View key | Write keys | Settings section | Page gates | Routes |
|---|---|---|---|---|---|---|
| Admin Dashboard | A | `report.admin_dashboard` | `report.follow_up` `report.remind` | — | adminDashTabBtn | 8 |
| Projects & clients | C | **project.view** *(new)* | `client.add` `client.edit` `client.delete` `client.close` `project.add` `project.edit` `project.delete` `project.close` `project.milestones` | — | projectsTabBtn newClientBtn newProjectBtn editProjectBtn | 15 |
| Assets & asset detail | D | — | `asset.add` `asset.edit` `asset.delete` `asset.assign` `asset.assign_any` `asset.bulk_upload` `asset.bulk_assign` `asset.lead_notes` `asset.hold` `asset.hold_any` `asset.override_stage` | — | newAssetBtn bulkImportBtn downloadSampleBtn | 5 |
| Review queue | A | `review.client_view` | `review.tl` `review.cd` `review.approve_client` `review.tl_send_client` `review.tl_feedback` `review.deliver` `review.client_send` `review.client_deliver` `review.client_return` | — | — | 0 |
| Project review queue & Pending Actions | A | `project.review_queue` | `project.review_send` `project.review_respond` | — | pendingTabBtn | 4 |
| Time Sheet | D | `timesheet.own` | `timesheet.tl_action` | — | timesheetTabBtn | 11 |
| Reports | A | `report.view` | — | — | reportsTabBtn | 3 |
| Profit & Loss | A | `pnl.actual` | `pnl.manage` | `pnl.manage` | pnlTabBtn | 0 |
| Outsource | A | `outsource.view` | `outsource.manage` `outsource.deliver` `outsource.reopen` `outsource.rates` | — | outsourceTabBtn | 9 |
| Users & teams | A | `user.view` | `user.add` `user.edit` `user.delete` `user.deactivate` `user.reset_password` `user.change_role` `user.change_project` `user.change_reporting` `user.bulk_upload` | — | usersTabBtn | 13 |
| Server tab (office file server) | A | `server.view` | `server.upload` `server.download` `server.request_delete` `server.manage_requests` `server.submit_upload` `server.browse_all` | — | serverTabBtn | 8 |
| Chat | D | `chat.use` | `chat.group_create` `chat.group_manage_any` `chat.message_protected` | — | chatWrap | 16 |
| Notifications | D | — | — | — | — | 0 |
| My profile | D | — | — | — | — | 0 |
| Role Permissions | B | **settings.permissions_view** *(new)* | `settings.permissions` | `settings.permissions` | — | 6 |
| Role Groups | B | **settings.role_groups_view** *(new)* | `settings.role_groups` | `settings.role_groups` | — | 8 |
| Designations | B | **settings.roles_view** *(new)* | `settings.roles` | `settings.roles` | — | 0 |
| Working Hours | B | **settings.working_hours_view** *(new)* | `settings.working_hours` | `settings.working_hours` | — | 1 |
| Recording Hours | B | **settings.recording_hours_view** *(new)* | `settings.recording_hours` | `settings.recording_hours` | — | 0 |
| Holidays | A | `settings.holidays_view` | `settings.holidays` | `settings.holidays_view` | — | 4 |
| Time Sheet Options | B | **timesheet.options_view** *(new)* | `timesheet.options` `timesheet.sub_options` | `timesheet.options` | — | 2 |
| Leave & Idle | B | **settings.leave.view** *(new)* | `settings.leave.manage` | `settings.leave.manage` | — | 2 |
| Start-of-day nudges | B | **settings.nudges_view** *(new)* | `settings.nudges` | `settings.nudges` | — | 2 |
| Branding | B | **settings.branding_view** *(new)* | `settings.branding` | `settings.branding` | — | 3 |
| Theme | B | **settings.theme_view** *(new)* | `settings.theme` | `settings.theme` | — | 6 |
| Email (mail server) | B | **settings.email_config_view** *(new)* | `settings.email_config` | `settings.email_config` | — | 3 |
| Email (Gmail) delivery | B | **settings.email_delivery_view** *(new)* | `settings.email_delivery` | `settings.email_delivery` | — | 3 |
| Server (gateway) | B | **settings.server.view** *(new)* | `settings.server.manage` | `settings.server.manage` | — | 7 |
| Dev & QA Integration | B | **settings.integrations_view** *(new)* | `settings.integrations` | `settings.integrations` | — | 11 |
| Chat settings | B | **chat.settings_view** *(new)* | `chat.settings` | `chat.settings` | — | 0 |
| Chat attachment retention | B | **settings.chat_retention_view** *(new)* | `settings.chat_retention` | `settings.chat_retention` | — | 2 |
| Allowed IP addresses | B | **settings.ip_allowlist_view** *(new)* | `settings.ip_allowlist` | `settings.ip_allowlist` | — | 7 |
| Blocked IP addresses | B | **settings.ip_blocklist_view** *(new)* | `settings.ip_blocklist` | `settings.ip_blocklist` | — | 4 |
| MIS Project Access | B | **settings.mis_access_view** *(new)* | `settings.mis_access` | `settings.mis_access` | — | 0 |
| Reference lists | B | **settings.reference_view** *(new)* | `settings.asset_types` `settings.priorities` `settings.categories` `settings.project_categories` `settings.milestone_types` | `settings.asset_types` `settings.priorities` `settings.categories` `settings.project_categories` `settings.milestone_types` | — | 0 |
| Activity Log | A | `settings.activity_log` | — | `settings.activity_log` | — | 0 |
| Audit logs (no screen yet) | A | `settings.audit_logs` | — | — | — | 0 |
| Chat Activity (oversight) | A | `settings.chat_activity` | — | `settings.chat_activity` | — | 3 |
| Dev & QA API (service credential) | A | — | — | — | — | 0 |
| Office gateway callbacks | A | — | — | — | — | 0 |
| Mobile builds | A | `mobile.distribute` | — | `mobile.distribute` | — | 1 |

## What each area is, and why it is in that class

### Admin Dashboard — class A

Its own grant already, and what it counts is scoped by the role.

### Projects & clients — class C

The TAB was already client.view, but GET /api/projects had no key at all — any signed-in person could read the project list within their scope over the API while the tab was hidden. The read keeps working for everybody (the artist board needs it), and project.view now says so out loud: implied for every designation.

### Assets & asset detail — class D

ROW SCOPE, NOT A SCREEN KEY. Every asset read is decided per asset by canViewAsset()/visibleProjects() and every transition by the workflow table in src/asset-workflow.js — a key that said "may see the Assets tab" would be either a lie or a widening. Left alone, and the reason is written down here so the next reader does not add one.

### Review queue — class A

review.client_view is the existing read grant; the rest are the gates in the pipeline, each decided per asset.

### Project review queue & Pending Actions — class A

pending.view opens Pending Actions; project.review_mine is a self scope.

### Time Sheet — class D

timesheet.own is self scope — my own week. timesheet.team and timesheet.all are the existing grants for reading other people's, which is what a view-only role with no writes already gets.

### Reports — class A

Already view-only by nature: report.view, report.idle and report.artist_report read and never write.

### Profit & Loss — class A

pnl.actual and pnl.fixed are the two read grants (the screen shows the sub-tabs the viewer holds); pnl.manage is the rate card. Already the shape this prompt is about, and the routes enforce it with their own middleware.

### Users & teams — class A

user.view_team is the narrower read for My Team; user.idle_view reads who is idle.

### Server tab (office file server) — class A

server.view_audit is a second read grant. The tab also needs the studio switch — the one gate in the page table that reads something other than a permission.

### Chat — class D

MEMBERSHIP, NOT A VIEW KEY, and deliberately no "view all chats" grant exists. settings.chat_activity is the studio's oversight screen and reads only what it already covered.

### Notifications — class D

Self scope: my own inbox, read and marked read by me.

### My profile — class D

Self scope. Changing somebody ELSE's photo or password is user.edit / user.reset_password, which are in the users area above.

### Holidays — class A

THE EXISTING EXAMPLE this prompt generalises: a view key implied for every designation, a separate manage key, and the section says it is read-only unless you hold the second one. Left exactly as it is.

### Email (mail server) — class B

MIXED: the host, port, sender and whether a password is set are configuration; the password itself is never returned to anybody, view-only or Super Admin.

### Email (Gmail) delivery — class B

MIXED: the queue, the caps and whether delivery is paused are readable; the Google client secret and refresh token are not.

### Server (gateway) — class B

MIXED: where the gateway is, the size and extension rules and which folders are shared are configuration; its two secrets are never returned. Not to be confused with server.view, which opens the Server TAB.

### Dev & QA Integration — class B

MIXED, and the one key in the catalogue that is deliberately not grantable through a group: it can issue a credential. The VIEW key is grantable; the manage key stays as it is.

### Reference lists — class B

FIVE SECTIONS, ONE READ. Scope of Work, Priorities, Asset Categories, Project Categories and Milestone Types are five panels over one reference table and one route family (/api/reference/:collection), whose read was gated by each list's MANAGE key. One view key covers reading the lists; each list keeps its own manage key. They are dropdown vocabularies, not data: a studio that lets somebody read one is not exposed by their reading another.

### Activity Log — class A

Read-only by nature — there is nothing to write in it.

### Chat Activity (oversight) — class A

Read-only, and already its own key. Covers what the studio may oversee and nothing more: it does not become a way to read a conversation as a member.

### Dev & QA API (service credential) — class A

A machine API behind a service credential, not a role. No view key applies.

### Office gateway callbacks — class A

The gateway's own credential. Not a role, and its config route publishes the keys only to the gateway itself.

## The view keys this prompt added

| New view key | Area | Implied by | Default holders |
|---|---|---|---|
| `project.view` | Projects & clients | `client.add` `client.edit` `client.delete` `client.close` `project.add` `project.edit` `project.delete` `project.close` `project.milestones` | none yet |
| `settings.permissions_view` | Role Permissions | `settings.permissions` | none yet |
| `settings.role_groups_view` | Role Groups | `settings.role_groups` | none yet |
| `settings.roles_view` | Designations | `settings.roles` | none yet |
| `settings.working_hours_view` | Working Hours | `settings.working_hours` | none yet |
| `settings.recording_hours_view` | Recording Hours | `settings.recording_hours` | none yet |
| `timesheet.options_view` | Time Sheet Options | `timesheet.options` `timesheet.sub_options` | none yet |
| `settings.leave.view` | Leave & Idle | `settings.leave.manage` | none yet |
| `settings.nudges_view` | Start-of-day nudges | `settings.nudges` | none yet |
| `settings.branding_view` | Branding | `settings.branding` | none yet |
| `settings.theme_view` | Theme | `settings.theme` | none yet |
| `settings.email_config_view` | Email (mail server) | `settings.email_config` | none yet |
| `settings.email_delivery_view` | Email (Gmail) delivery | `settings.email_delivery` | none yet |
| `settings.server.view` | Server (gateway) | `settings.server.manage` | none yet |
| `settings.integrations_view` | Dev & QA Integration | `settings.integrations` | none yet |
| `chat.settings_view` | Chat settings | `chat.settings` | none yet |
| `settings.chat_retention_view` | Chat attachment retention | `settings.chat_retention` | none yet |
| `settings.ip_allowlist_view` | Allowed IP addresses | `settings.ip_allowlist` | none yet |
| `settings.ip_blocklist_view` | Blocked IP addresses | `settings.ip_blocklist` | none yet |
| `settings.mis_access_view` | MIS Project Access | `settings.mis_access` | none yet |
| `settings.reference_view` | Reference lists | `settings.asset_types` `settings.priorities` `settings.categories` `settings.project_categories` `settings.milestone_types` | none yet |

## Routes whose guard the static reader cannot see

Reported rather than hidden: these decide inside the handler — a membership check, a
workflow verdict, a row-level predicate, or a self scope. `src/route-manifest.js`
states what each one really leans on, and `tests/route-manifest.test.js` fails if a
route is missing from it.

| Route | Mutating | What was found in the handler |
|---|---|---|
| `DELETE /api/assets/:id` | **yes** | inline-predicate:canDeleteAsset, inline-predicate:canManageTasks, inline-gate:taskGuard |
| `DELETE /api/assets/:id/thumbnail` | **yes** | inline-gate:thumbnailGuard |
| `DELETE /api/assets/tasks/:id` | **yes** | inline-gate:taskGuard |
| `DELETE /api/push/devices/:token` | **yes** | **nothing** |
| `DELETE /api/users/:id/photo` | **yes** | **nothing** |
| `GET /api/assets/:id/game-feedback` | no | inline-predicate:canViewAsset |
| `GET /api/assets/:id/history` | no | inline-predicate:canViewAsset |
| `GET /api/assets/:id/reassign-options` | no | inline-predicate:canHandOverInReview |
| `GET /api/assets/:id/tasks` | no | inline-predicate:canViewAsset, inline-predicate:canManageTasks |
| `GET /api/assets/:id/thumbnail` | no | inline-project-scope, inline-predicate:canHoldAsset |
| `GET /api/assets/:id/worklog` | no | inline-predicate:canViewAsset |
| `GET /api/assets/import-format` | no | **nothing** |
| `GET /api/assets/import-template.csv` | no | **nothing** |
| `GET /api/assets/project/:projectId` | no | inline-self, inline-predicate:canAccessProject |
| `GET /api/assets/versions/:versionId/download` | no | inline-predicate:canViewAsset |
| `GET /api/auth/email-preference` | no | inline-self |
| `GET /api/auth/me` | no | inline-self |
| `GET /api/auth/password-policy` | no | **nothing** |
| `GET /api/auth/push-preference` | no | inline-self |
| `GET /api/auth/roles` | no | **nothing** |
| `GET /api/branding` | no | **nothing** |
| `GET /api/branding/logo` | no | **nothing** |
| `GET /api/branding/schedule` | no | **nothing** |
| `GET /api/notifications` | no | inline-self |
| `GET /api/notifications/poll` | no | inline-self |
| `GET /api/pnl/role-rates` | no | inline-gate:maySeeEither |
| `GET /api/projects` | no | inline-project-scope, inline-self |
| `GET /api/projects/:id` | no | inline-predicate:canAccessProject |
| `GET /api/projects/:id/artists` | no | inline-predicate:canAccessProject |
| `GET /api/push/config` | no | **nothing** |
| `GET /api/reference` | no | **nothing** |
| `GET /api/reference/:collection` | no | inline-gate:resolveCollection |
| `GET /api/server/deletion-requests` | no | inline-self |
| `GET /api/theme` | no | inline-gate:cssHandler, inline-gate:tooBig |
| `GET /api/users/:id/photo` | no | inline-self |
| `PATCH /api/assets/:id` | **yes** | inline-self, inline-predicate:canEditAsset, inline-predicate:canOverrideStage, inline-predicate:mayEdit, inline-workflow, inline-gate:applyTransition |
| `PATCH /api/assets/tasks/:id` | **yes** | inline-gate:taskGuard |
| `PATCH /api/assets/tasks/:id/text` | **yes** | inline-gate:taskGuard |
| `POST /api/assets/:id/client-approved` | **yes** | **nothing** |
| `POST /api/assets/:id/client-changes` | **yes** | **nothing** |
| `POST /api/assets/:id/deliver` | **yes** | inline-workflow, inline-gate:applyTransition |
| `POST /api/assets/:id/game-feedback` | **yes** | inline-self, inline-workflow |
| `POST /api/assets/:id/notes` | **yes** | inline-self, inline-tier, inline-predicate:canViewAsset, inline-predicate:canActAtTlGate, inline-predicate:canOverrideReview, inline-predicate:canEditAsset, inline-predicate:canHandOverInReview, inline-predicate:canMarkDelivered, inline-predicate:canDeliverOutsourced, inline-predicate:canReopenOutsourced, inline-predicate:canReviewAsCD, inline-predicate:canAccessProject, inline-workflow, inline-gate:applyTransition |
| `POST /api/assets/:id/reassign` | **yes** | inline-self, inline-predicate:canActAtTlGate, inline-predicate:canReviewAsCD, inline-predicate:canViewAsset, inline-predicate:canHandOverInReview, inline-workflow, inline-gate:applyTransition |
| `POST /api/assets/:id/relay` | **yes** | inline-workflow, inline-gate:applyTransition |
| `POST /api/assets/:id/review` | **yes** | inline-self, inline-workflow, inline-gate:applyTransition |
| `POST /api/assets/:id/send-to-cd` | **yes** | inline-workflow, inline-gate:applyTransition |
| `POST /api/assets/:id/send-to-client` | **yes** | inline-workflow, inline-gate:applyTransition |
| `POST /api/assets/:id/send-to-client-review` | **yes** | **nothing** |
| `POST /api/assets/:id/start` | **yes** | inline-self, inline-workflow, inline-gate:applyTransition, inline-gate:holdableAsset |
| `POST /api/assets/:id/submit` | **yes** | inline-self, inline-workflow, inline-gate:applyTransition, inline-gate:thumbnailGuard |
| `POST /api/assets/:id/submit-feedback` | **yes** | inline-self, inline-predicate:canActAtTlGate, inline-workflow, inline-gate:applyTransition |
| `POST /api/assets/:id/tasks` | **yes** | inline-self, inline-gate:taskGuard |
| `POST /api/assets/bulk/deliver` | **yes** | inline-self, inline-workflow, inline-gate:applyTransition |
| `POST /api/assets/bulk/outsource-deliver` | **yes** | inline-gate:handle |
| `POST /api/assets/bulk/outsource-stage` | **yes** | inline-self, inline-predicate:canReopenOutsourced, inline-predicate:canDeliverOutsourced, inline-workflow, inline-gate:applyTransition |
| `POST /api/assets/project/:projectId` | **yes** | inline-self, inline-predicate:canCreateAsset, inline-predicate:canAccessProject, inline-workflow, inline-gate:applyTransition |
| `POST /api/auth/bootstrap` | **yes** | **nothing** |
| `POST /api/auth/email-preference` | **yes** | inline-self |
| `POST /api/auth/login` | **yes** | **nothing** |
| `POST /api/auth/password` | **yes** | inline-self |
| `POST /api/auth/push-preference` | **yes** | inline-self |
| `POST /api/auth/tour-seen` | **yes** | inline-self |
| `POST /api/notifications/read` | **yes** | inline-self |
| `POST /api/notifications/read-all` | **yes** | inline-self |
| `POST /api/push/devices` | **yes** | inline-self |
| `POST /api/push/test` | **yes** | inline-self |

292 routes in all; 166 mutating; 67 with no guard in a middleware position.

## The page's own tables

`UI_GATES` — every element whose visibility is a permission question:

| Element | Gate |
|---|---|
| teamTabBtn | `can('user.view_team')` |
| usersTabBtn | `canAnyIn('user')` |
| outsourceTabBtn | `can('outsource.view')` |
| settingsTabBtn | `canOpenSettings()` |
| reportsTabBtn | `can('report.view','report.idle','report.artist_report')` |
| adminDashTabBtn | `can('report.admin_dashboard')` |
| pnlTabBtn | `can('pnl.actual','pnl.fixed')` |
| serverTabBtn | `can('server.view') && SRV.enabled` |
| projectsTabBtn | `can('client.view')` |
| pendingTabBtn | `can('pending.view')` |
| timesheetTabBtn | `can('timesheet.own')` |
| chatWrap | `can('chat.use')` |
| newClientBtn | `can('client.add')` |
| newProjectBtn | `can('project.add')` |
| editProjectBtn | `mayEditCurrentProject()` |
| newAssetBtn | `can('asset.add')` |
| bulkImportBtn | `can('asset.bulk_upload')` |
| downloadSampleBtn | `can('asset.bulk_upload')` |

`SETTINGS_SECTIONS` — every Settings section and the key that reveals it:

| Section | Key |
|---|---|
| Role Permissions | `settings.permissions` |
| Role Groups | `settings.role_groups` |
| Email (Gmail) | `settings.email_delivery` |
| Scope of Work | `settings.asset_types` |
| Branding | `settings.branding` |
| Theme | `settings.theme` |
| Working Hours | `settings.working_hours` |
| Recording Hours | `settings.recording_hours` |
| Time Sheet | `timesheet.options` |
| Holidays | `settings.holidays_view` |
| Start-of-day nudges | `settings.nudges` |
| Server | `settings.server.manage` |
| Leave | `settings.leave.manage` |
| Chat | `chat.settings` |
| MIS Project Access | `settings.mis_access` |
| Priorities | `settings.priorities` |
| Asset Categories | `settings.categories` |
| Project Categories | `settings.project_categories` |
| Milestone Types | `settings.milestone_types` |
| Roles | `settings.roles` |
| IP Allowlist | `settings.ip_allowlist` |
| IP Blocklist | `settings.ip_blocklist` |
| Email Configuration | `settings.email_config` |
| Dev & QA Integration | `settings.integrations` |
| Rate Card | `pnl.manage` |
| Activity Log | `settings.activity_log` |
| Chat Activity | `settings.chat_activity` |
| Mobile Apps | `mobile.distribute` |

