# Deploying to GoDaddy (cPanel Node.js)

This walks through getting `zvky-backend-godaddy.zip` running on GoDaddy shared
or Business hosting, which runs Node apps through cPanel's **Setup Node.js App**
tool (Phusion Passenger underneath).

You need a plan whose cPanel shows **Setup Node.js App** under Software. If it
isn't there, the plan doesn't support Node and no amount of configuration will
make it work — that needs a VPS or a plan upgrade.

---

## 1. Create the database

cPanel → **MySQL Databases**

1. Create the database. cPanel prefixes it with your account name, so entering
   `production` gives you something like `zvky_production`.
2. Create a database user and set its password.
3. Under **Add User To Database**, add that user to that database with
   **ALL PRIVILEGES**.

Write down all three values exactly as cPanel displays them — the prefixes are
part of the names, and a mismatch shows up later as a generic
`ER_ACCESS_DENIED_ERROR` that gives no hint which of the three is wrong.

## 2. Import the schema

cPanel → **phpMyAdmin** → select your database → **Import** tab → choose
`sql/schema.sql` from the zip → **Go**.

You should end up with nine tables: `users`, `projects`, `project_team_leads`,
`project_coordinators`, `assets`, `tasks`, `notes`, `asset_versions`, `feedback`.

## 3. Upload the application

cPanel → **File Manager**

1. Create a folder for the app, e.g. `/home/<account>/zvky-backend`.
   Put it *outside* `public_html` — Passenger serves the app itself, and
   anything inside `public_html` is also reachable as plain files.
2. Upload `zvky-backend-godaddy.zip` into that folder and **Extract** it.
3. The folder should now contain `app.js`, `package.json`, `src/`, `public/`,
   `sql/`, `uploads/` and `.env.example`.

> The archive holds **no `.env` and no secret**. The database password,
> `JWT_SECRET` and every other setting go into the app's **Environment
> variables** (step 5). `.env.example` lists the names. Keep the app folder outside
> `public_html` anyway, so nothing in it can be served over HTTP.

## 4. Create the Node application

cPanel → **Setup Node.js App** → **Create Application**

| Field | Value |
|---|---|
| Node.js version | 18 or newer |
| Application mode | Production |
| Application root | `zvky-backend` (the folder from step 3) |
| Application URL | the domain or subdomain to serve it from |
| Application startup file | `app.js` |

Click **Create**.

## 5. Set the environment variables

Still in **Setup Node.js App**, open the app and add these under
**Environment variables**. They are the app's only source of settings on the
host; no `.env` file is used or needed. The app refuses to start, and logs which
name is missing, if the database settings or `JWT_SECRET` are absent or still a
placeholder.

| Name | Value |
|---|---|
| `DB_HOST` | `localhost` |
| `DB_NAME` | your prefixed database name |
| `DB_USER` | your prefixed database user |
| `DB_PASSWORD` | that user's password |
| `JWT_SECRET` | a long random value (at least 32 characters; 96 hex characters below) |
| `CORS_ORIGIN` | the site URL, e.g. `https://pipeline.zvky.com` |
| `TRUST_PROXY` | `1` |

Don't set `PORT` — Passenger assigns it.

A random `JWT_SECRET`, from any machine with Node.js:
`node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`, or a
96-character random string from a password manager. Changing it signs everyone
out. If a mail server password was saved under Settings → Email and
`EMAIL_ENCRYPTION_KEY` is not set, that password was encrypted with the old
`JWT_SECRET`: the Email screen says so, and you enter it again once.

**Rotating the database password.** In cPanel → **MySQL Databases**, change the
user's password; then put the new password in the app's `DB_PASSWORD`
environment variable and **Restart** the app. Nothing in the files changes.

## 6. Install dependencies

In the app's panel click **Run NPM Install**. This reads `package.json` and
installs into the app folder.

If you'd rather use the terminal, the panel shows a "Enter to the virtual
environment" command — run that first, then `npm install`, so you're using the
right Node version rather than the system one.

## 7. Create the first account

The app has no users until you make one. In the virtual environment, from the
application root:

```bash
npm run seed
```

That creates the demo studio: a super admin (`ava@zvky.studio` / `superadmin`),
plus sample staff across every designation and four projects with assets at
each stage of the review pipeline. It refuses to run if the `users` table
already has rows.

**Change that password immediately after your first sign-in**, and delete the
demo accounts once you've added your real staff.

### No shell on this host?

Some managed platforms give you a database console but no terminal, so
`npm run seed` isn't available.

**Check the startup log first.** When the database has no accounts, the app
prints a ready-made command with a one-time token:

```
========================================================================
This database has no accounts yet, so nobody can sign in.

Create the first super admin by sending this request ...
  curl -X POST <your-site-url>/api/auth/bootstrap ...
========================================================================
```

Copy that command, fill in your name, email and password, and run it. Nothing
needs configuring. The token is regenerated on every restart and stops working
the moment an account exists.

If you'd rather set a fixed token — because you can set environment variables
and would prefer not to read logs — set

```
BOOTSTRAP_TOKEN=<any long random string>
```

restart, and create the account the same way:

```bash
curl -X POST https://your-domain.com/api/auth/bootstrap \
  -H 'Content-Type: application/json' \
  -d '{"token":"<the same string>","name":"Your Name","email":"you@zvky.com","password":"a-strong-password"}'
```

The app hashes the password itself, using its own database connection — so
there is no hash to paste and no way to write to the wrong database. The route
returns 404 once any account exists, so it can't become a back door. If you set
`BOOTSTRAP_TOKEN`, unset it once you're signed in.

> **Which database is the app actually using?** The one named by the app's
> environment variables. (A `.env` file, used only in local development, never
> replaces a variable that is already set.) This is worth checking
> before hand-writing SQL: `/api/health` reports whether the database the app is
> connected to has any accounts.

### Or by hand, via SQL

If you'd rather insert the row yourself:

```bash
node scripts/make-admin-sql.js "Your Name" you@zvky.com
```

It prints an `INSERT` to paste into phpMyAdmin, and the generated password to
your terminal. Two things to watch: paste the SQL into a **database console**,
not a shell — a bcrypt hash contains `$` characters that a shell will expand
and corrupt — and make sure the console is connected to the same database the
app's `DB_NAME` points at, or the row will land somewhere the app never reads.

## 8. Start it

Click **Restart** in the app panel, then open your Application URL. You should
get the sign-in screen.

Check `https://your-domain.com/api/health` — it should return `{"ok":true}`.

---

## Uploads

Artist submissions are written to `uploads/` inside the application root. That
folder ships empty in the zip and must stay writable by the app.

It is *not* inside `public_html`, and files are only served back through
`GET /api/assets/versions/:id/download`, which re-checks permissions on every
request. Don't move it into a web-served directory — that would make every
submitted file publicly downloadable by URL.

Shared hosting has a disk quota; art files are large. Keep an eye on it, and
move storage to S3 or similar when it becomes a problem — `src/upload.js` is
the only file that needs to change.

## Backups

cPanel → **Backup** exports the database. This database is now the studio's
source of truth for every asset, review decision and piece of feedback, so
schedule it rather than doing it by hand.

---

## Troubleshooting

**"We're sorry, but something went wrong"** — Passenger's generic error page.
The real cause is in `stderr.log` in the application root, or in the app
panel's log viewer.

**`ER_ACCESS_DENIED_ERROR`** — `DB_USER`, `DB_PASSWORD` or `DB_NAME` doesn't
match, or the user was never added to the database in step 1.3. Re-check all
three against cPanel → MySQL Databases, including the account prefix.

**`ER_NO_SUCH_TABLE`** — step 2 didn't complete. Re-import `sql/schema.sql`.

**Sign-in returns 500** — `JWT_SECRET` isn't set.

**"Too many sign-in attempts"** — the whole office shares one public IP, so the
rate limit counts everyone together. Raise `LOGIN_RATE_MAX`.

**App won't start after an upload** — Passenger caches the old process. Hit
**Restart** in the app panel; touching `tmp/restart.txt` in the app root does
the same thing.

**Changes to environment variables don't take effect** — same reason. Restart the app.

**App exits at start with "Forge cannot start: its configuration is incomplete"** —
the log lists each missing or placeholder variable by name. Set it under
**Environment variables** and restart.
