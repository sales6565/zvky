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
| Supervision | Art Supervisor, Associate Animation Supervisor, Senior Team Lead, Team Lead, Associate Team Lead | Run a team, hold the first review gate, create and edit assets |
| Art | Senior Game Artist, Senior Motion Graphics Artist, Game Artist, Associate Game Artist, Trainee Game Artist | Assigned work, submit it for review |
| Animation | Senior Game Animator, Game Animator, Associate Game Animator, Trainee Game Animator | Assigned work, submit it for review |
| Design | Senior UI/UX Designer, Game Designer, Associate Game Designer, Consultant - Lead Game Designer, Associate - UI/UX Designer | Assigned work, submit it for review |
| Leadership | Managing Director & CEO, Vice President - Global Operations & Business Development | See every project; no pipeline actions. Widen an entry if one of them needs to review, deliver or administer |
| Production | Senior Producer, Producer, Creative Producer, Senior Project Manager, Project Manager, Associate Project Manager, Senior Production Coordinator | Work across the projects they're attached to; create and edit assets; sign off delivery |
| Engineering | Senior/Technical Artist, Associate Technical Artist, Senior/Unity Developer, Associate Unity Developer, Game Developer, Associate Game Developer, Test Engineer, Associate Test Engineer, Trainee - Test Engineer | Assigned work, submit it for review |
| Game Math | Game Mathematician, Associate Game Mathematician, Associate Math Analyst | Assigned work, submit it for review |
| Business & Operations | Senior Business Development Executive, Senior Operations Financial Analyst, Account Manager - Marketing, MIS Analyst, Junior Accountant | Directory only — no access to the asset pipeline |
| People & Culture | People & Culture Partner, Assistant Manager - HR Generalist, Talent Acquisition Specialist | Directory only — no access to the asset pipeline |

Seniority (Trainee → Associate → Senior) is recorded and displayed but does not
by itself change access: a Trainee Game Artist and a Senior Game Artist have the
same permissions and differ in title and reporting line. Change that by editing
the entry in `src/roles.js`.

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

Assets now move through a fixed pipeline instead of a free-form status field:

```
not_started → in_progress → pending_tl_review ⇄ tl_changes_requested
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

Board/list drag-and-drop in the frontend only works between `not_started`
and `in_progress` — everything past that point has to go through the actions
above, and the API enforces this even if someone calls `PATCH` directly.

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
| Where | Board toolbar | Users tab |
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

```bash
cp .env.example .env
```

Edit `.env` and set:
- `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` — your MySQL
  connection (or a single `DATABASE_URL` instead)
- `JWT_SECRET` — a long random string (`node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`)
- `CORS_ORIGIN` — the URL your frontend will be served from
- `TRUST_PROXY` — number of reverse proxies in front of the app (`1` behind
  cPanel/Passenger, so the login rate limit sees real client addresses)
- `LOGIN_RATE_MAX` — sign-in attempts allowed per address per window. A whole
  office shares one public IP, so this counts the studio together
- `IP_ALLOWLIST_*` — optional; restricts the app to specific addresses. Read
  [Restricting access by IP address](#restricting-access-by-ip-address) before
  enabling it, and deploy in monitor mode first

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

## 6. Run it

```bash
npm start          # production
npm run dev         # auto-restart on change (needs the dev dependency: npm install)
```

The API is served at `http://localhost:4000/api/*`, and the bundled frontend
(`public/index.html`) at `http://localhost:4000/`.

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
| PATCH | `/api/assets/:id` | whoever can edit that asset (status limited to not_started ⇄ in_progress) |
| DELETE | `/api/assets/:id` | super_admin, or admin who owns the project |
| POST | `/api/assets/:id/submit` | the assigned contributor — uploads a file, advances to the right review stage |
| POST | `/api/assets/:id/review` | their lead/supervisor (TL stage) or art_director/super_admin (CD stage) |
| POST | `/api/assets/:id/deliver` | any role that can deliver — once approved_for_client |
| GET | `/api/assets/versions/:versionId/download` | whoever can view the asset |
| POST | `/api/assets/:id/tasks` | whoever can edit that asset |
| PATCH | `/api/assets/tasks/:id` | whoever can edit the parent asset |
| POST | `/api/assets/:id/notes` | whoever can view that asset |
| GET | `/api/users` | super_admin (all), admin (users they added) |
| POST | `/api/users` | super_admin (any designation), admin (anything that neither manages users nor sees the whole studio) |
| PATCH | `/api/users/:id` | change someone's designation or reporting line, same scoping as above |
| DELETE | `/api/users/:id` | super_admin (anyone but another super admin), admin (only users they added) |
| GET | `/api/team` | any designation that runs a team — their reports' progress |

Every route re-checks permissions against the database on each request — a
role change or removal takes effect on the user's very next request, not just
after their token expires.

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

### Removing the entry that lets you in

Removing or deactivating the entry covering your own address is refused unless
you confirm it. The browser asks first; the API refuses a `DELETE` without
`?confirm=yes` regardless, so a script or a stale tab gets the same protection.
The message distinguishes the two cases — whether another entry still covers
you, or whether this is the one thing keeping you in.

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

## Packaging for deployment

```bash
DB_NAME=... DB_USER=... DB_PASSWORD=... CORS_ORIGIN=https://your-domain.com npm run package
```

Writes `dist/zvky-backend-godaddy.zip`: the application, a generated `.env`
carrying those values and a fresh `JWT_SECRET`, and no `node_modules` (cPanel
installs those itself). Credentials come from the environment so they are never
written into a committed file. See [DEPLOY-GODADDY.md](DEPLOY-GODADDY.md).

## Deploying for real

- Put this behind HTTPS. Never run it over plain HTTP in production.
- Rotate `JWT_SECRET` and the seeded demo passwords immediately.
- Consider forcing a password reset on first login instead of shipping a
  shared default password.
- Add a migrations tool once you need to evolve the schema instead of
  hand-editing `sql/schema.sql`.
- Back up the database. This is now the single source of truth for the studio.
