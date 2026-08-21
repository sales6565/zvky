# Zvky Pipeline — backend

A real Node.js + PostgreSQL backend for the Zvky Design Studio asset/animation
tracker: password login, JWTs, and the same five-role permission model as the
prototype (Super Admin, Admin, Team Lead, Coordinator, Artist), now enforced
server-side instead of in the browser.

## 1. Prerequisites

- Node.js 18+
- A PostgreSQL database (local install, Docker, or a managed host like Railway,
  Render, Neon, or RDS)

## 2. Set up the database

Fresh install:
```bash
createdb zvky
psql zvky -f sql/schema.sql
```

Already running the original schema and have live data? Apply the migration instead:
```bash
psql zvky -f sql/migration_2_review_workflow.sql
```
(It maps old statuses onto the new pipeline automatically — see the comments in that file.)

## Review workflow

Assets now move through a fixed pipeline instead of a free-form status field:

```
not_started → in_progress → pending_tl_review ⇄ tl_changes_requested
                                    ↓ (TL approves)
                             pending_cd_review ⇄ cd_changes_requested
                                    ↓ (CD approves)
                             approved_for_client → delivered
```

- The **artist** uploads a file via `POST /api/assets/:id/submit` (multipart,
  field name `file`). Where it routes depends on where it came from: fresh
  work or a team-lead rework request goes to **pending_tl_review**; a
  creative-director rework request skips the team lead and goes straight
  back to **pending_cd_review**.
- The **team lead** calls `POST /api/assets/:id/review` with
  `{ decision: "approved" | "changes_requested", text }` while the asset is
  `pending_tl_review`. Approving sends it to the creative director;
  requesting changes sends it back to the artist with the note attached.
- The **creative director** (or super admin, as an override) does the same
  on `pending_cd_review`. Approving marks it `approved_for_client`.
- Anyone who can manage the project (super admin, admin, coordinator, or the
  creative director) calls `POST /api/assets/:id/deliver` once it's
  `approved_for_client` to mark it `delivered`.

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

Once a project exists, anyone who can create assets in it (super admin,
admin, team lead, coordinator) can import a CSV **or Excel (.xls/.xlsx)**
file instead of adding assets one at a time:

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
| `assignee_email` | Must match an existing artist's email, or it's left unassigned with a warning |
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
- `DATABASE_URL` — your Postgres connection string
- `JWT_SECRET` — a long random string (`node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`)
- `CORS_ORIGIN` — the URL your frontend will be served from

## 5. Install and seed

```bash
npm install
npm run seed
```

The seed script creates:
- 1 super admin — `ava@zvky.studio` / `superadmin`
- 3 creative directors, 15 admins, 40 team leads, 44 coordinators, 400 artists — all `<their email>` / `zvky2026`
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
| GET | `/api/projects` | scoped per role automatically |
| POST | `/api/projects` | super_admin, admin |
| DELETE | `/api/projects/:id` | super_admin, or admin who owns it |
| GET | `/api/projects/:id/artists` | anyone with access to the project |
| GET | `/api/assets/project/:projectId` | scoped per role |
| POST | `/api/assets/project/:projectId` | super_admin, admin, team_lead, coordinator |
| POST | `/api/assets/project/:projectId/bulk` | super_admin, admin, team_lead, coordinator — CSV import |
| PATCH | `/api/assets/:id` | whoever can edit that asset (status limited to not_started ⇄ in_progress) |
| DELETE | `/api/assets/:id` | super_admin, or admin who owns the project |
| POST | `/api/assets/:id/submit` | the assigned artist — uploads a file, advances to the right review stage |
| POST | `/api/assets/:id/review` | the artist's team lead (TL stage) or creative_director/super_admin (CD stage) |
| POST | `/api/assets/:id/deliver` | super_admin, admin, coordinator, creative_director — once approved_for_client |
| GET | `/api/assets/versions/:versionId/download` | whoever can view the asset |
| POST | `/api/assets/:id/tasks` | whoever can edit that asset |
| PATCH | `/api/assets/tasks/:id` | whoever can edit the parent asset |
| POST | `/api/assets/:id/notes` | whoever can view that asset |
| GET | `/api/users` | super_admin (all), admin (users they added) |
| POST | `/api/users` | super_admin (any role), admin (team_lead/coordinator/artist only) |
| DELETE | `/api/users/:id` | super_admin (anyone but another super admin), admin (only users they added) |
| GET | `/api/team` | team_lead only — their own artists' progress |

Every route re-checks permissions against the database on each request — a
role change or removal takes effect on the user's very next request, not just
after their token expires.

## Deploying for real

- Put this behind HTTPS (Render, Railway, Fly.io, an EC2 box with Caddy/Nginx —
  anything that terminates TLS). Never run this over plain HTTP in production.
- Rotate `JWT_SECRET` and the seeded demo passwords immediately.
- Consider forcing a password reset on first login instead of shipping a
  shared default password.
- Add a migrations tool (e.g. `node-pg-migrate`) once you need to evolve the
  schema instead of hand-editing `sql/schema.sql`.
- Back up the database. This is now the single source of truth for the studio.
