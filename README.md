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
| Design | Senior UI/UX Designer, Game Designer, Associate - UI/UX Designer | Assigned work, submit it for review |

Seniority (Trainee → Associate → Senior) is recorded and displayed but does not
by itself change access: a Trainee Game Artist and a Senior Game Artist have the
same permissions and differ in title and reporting line. Change that by editing
the entry in `src/roles.js`.

### Adding a designation

Add one entry to `DEFINITIONS` in `src/roles.js`:

```js
lead_technical_artist: contributor('Lead Technical Artist', ART, 55, '#4db8ff'),
```

The API validates against it, the role dropdown and badges pick it up from
`GET /api/auth/roles`, and the permission checks apply immediately. No database
migration is needed — `users.role` is a `VARCHAR`, not an `ENUM`.

## 1. Prerequisites

- Node.js 18+
- A MySQL 5.7+ / MariaDB 10.2+ database

## 2. Set up the database

Fresh install:
```bash
mysql -u root -p -e "CREATE DATABASE zvky CHARACTER SET utf8mb4"
mysql -u root -p zvky < sql/schema.sql
```

Already running the earlier six-role version with live data? Apply the role
migration instead — it maps the old roles onto the designations:
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

## 3. Bulk-importing assets

Once a project exists, anyone whose designation can create assets in it (super
admin, admin, any lead or supervisor, production coordinator) can import a CSV
**or Excel (.xls/.xlsx)** file instead of adding assets one at a time:

```
POST /api/assets/project/:projectId/bulk
Content-Type: multipart/form-data
file: <your.csv | your.xlsx>
```

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

The response reports how many rows were created and lists any rows that
were skipped and why (bad type, unknown assignee email, etc.) — nothing
fails the whole batch.

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
