# Permission coverage audit

*Every feature in Zvky Forge, and whether Settings → Permissions can control it.*

Read out of the code rather than from memory: every route in `src/routes/`, every key in
`src/permission-catalog.js`, and every entry in the page's `UI_GATES` table were enumerated and
matched against each other. Nothing below was added or changed as a result — this is the report
first, as asked.

---

## The shape of it

| | |
|---|---|
| Permissions in the catalogue | **64**, in 9 groups |
| API routes | **139** |
| Gated by a catalogue permission | **~120** (61 by `requirePermission`, the rest by a permission read inside the handler — `holds()`, `can()`, or a guard that calls one) |
| Gated by something that is **not** a permission | **7 actions** (listed below) |
| Deliberately open | **12** (sign-in, the password rules, your own password, your own notifications, the branding and working-hours *reads*, the Quick Tour) |

Two structural points worth stating, because they explain most of the "no gate" hits in a naive scan:

- **A permission check is not always a middleware.** The asset workflow — submit, review, relay,
  deliver, the whole client round — is gated inside `contextFor()` in `src/routes/assets.js`, which
  reads `holds(user, 'review.tl')`, `holds(user, 'review.deliver')` and so on and hands the answers
  to `src/asset-workflow.js`. Those routes look ungated in a grep and are not.
- **Reference data is gated per collection.** `src/routes/reference.js` uses one custom middleware,
  `requireCollectionPermission`, which looks up the key for whichever list is being edited. So
  Asset Types, Categories, Priorities, Designations and Project Categories each have their own
  toggle already.

---

## The gaps

Seven actions decide who may do them by a **relationship or a role tier**, not by a switch in
Settings. Each is a real decision somebody made; the question is whether the studio wants to be
able to change it.

### 1. The asset checklist — add, rename, tick, delete

`POST /assets/:id/tasks`, `PATCH /assets/tasks/:id`, `PATCH /assets/tasks/:id/text`,
`DELETE /assets/tasks/:id`

Decided by `canManageTasks()`: the person who **created** the asset, its **team lead**, or anybody
holding `review.cd`. There is no `asset.manage_tasks` key.

The rule is deliberate and is written down in the refusal message — *"the checklist is set by
whoever added this asset and by its reviewers; being assigned the work does not carry the right to
change what the work is."* But it cannot be relaxed. A studio that wants artists to add their own
checklist items has no way to say so.

**This is the largest gap, and the one I would fill first.**

### 2. The asset preview image

`POST /assets/:id/thumbnail`, `DELETE /assets/:id/thumbnail`

Decided by `assetThumbnail.mayChange()`: the **assignee**, or anybody who could edit the asset.
Half of that is a permission (`asset.edit`); the assignee half is not. No `asset.thumbnail` key.

Low stakes — it is a picture — but it is a gap of the same kind.

### 3. Editing an asset is bounded by *who created it*

Not a missing permission, but worth naming because it surprises people. `asset.edit` grants the
action; `ownsAsset()` then limits it to assets the person **created** (or to anybody with
full studio access). So granting `asset.edit` to a Team Lead does **not** let them edit an asset a
producer added. That is scope, which the catalogue says stays with the role — but it means the
switch does less than its label suggests.

The same pattern applies to `asset.assign` and `asset.delete`.

### 4. Handing work on while it is in review

`canHandOverInReview()` lets the **reviewer currently holding** an asset pass it to somebody else,
in addition to the person who created it. The creator half comes from a permission; the
"reviewer holding it" half is a relationship. No key of its own.

### 5. Who may administer whom

`mayAdministerUser()` — an account with full studio access can only be edited or removed by
another account with full studio access. A hard rule, not a toggle, and I would keep it that way:
it is what stops a permission grant becoming a way to take over the studio. Listed for
completeness, not as something to fix.

### 6. The Quick Tour

Reachable by every signed-in account, with no permission at all. Called out in the code as
deliberate: *"the tour is an orientation aid, and a help screen somebody can be denied is not
one."* Listed so the absence is a decision on the record rather than an oversight.

### 7. Your own notifications, your own password, your own profile photo

`/notifications/*`, `POST /auth/password`, `POST /users/:id/photo` (for yourself). Self-scoped, so
there is no "who may do this to whom" to answer. Correct as they are.

---

## Permissions that exist but nothing enforces

| Key | Status |
|---|---|
| `settings.audit_logs` | **Declared but unbuilt** — flagged `pending` in the catalogue, and the Settings screen says so rather than showing a switch that does nothing. Not a hole; a placeholder. The Activity Log itself is gated by `settings.activity_log`, which *is* enforced. |
| `review.client_view` | Read by the page, never by the API — see the note below, which applies to three other keys as well. |
| `asset.override_stage` | Checked on the server (`PATCH /assets/:id` refuses a status move outside the normal flow without it) and read nowhere in the page. Correct: it is not a button, it is a rule about what a request may ask for. |
| `project.review_queue`, `project.review_mine`, `timesheet.team`, `timesheet.all`, `chat.open_inbox`, `chat.message_protected`, `chat.group_create` | Server-side only by design — they shape what an endpoint *returns* rather than gating a button, so there is nothing for the page to read. Correct. |

### Four board columns are hidden by the browser, not by the server

`RESTRICTED_STATUSES` in the page hides four columns from anybody without the matching key:

| Column | Key |
|---|---|
| Not Assigned | `asset.add` |
| CD Review | `asset.add` + `review.cd` |
| CD Feedbacks | `asset.add` + `review.cd` |
| Awaiting Client Feedback | `review.client_view` |

`GET /assets/project/:id` returns **every** asset in a project the caller can reach (narrowed only
for contributors, to their own work). The four filters above are applied after that, in the
browser.

So the switches do what their labels say for what people *see* — the column is gone from the board
and the Assets List — but they are presentation, not confidentiality. Somebody who can reach the
project and knows the API can read those rows. Whether that matters depends on what "hidden" is
meant to buy: if it is tidiness, this is fine as it is; if it is meant to keep the client round
away from people, it is not enough.

**Worth a decision. It is the only place in the audit where a permission does less than it looks
like it does.**

---

## Permissions whose default is worth a second look

These are enforced correctly; the question is only whether the **default** matches what the studio
wants. Each was flagged in an earlier round and is still as it was:

- `project.review_send`, `review.client_send`, `review.client_deliver`, `review.client_return`,
  `pending.view`, `project.review_mine` — **Super Admin only** out of the box. A producer cannot
  submit a project for review, and nobody can run the client round, until these are granted.
- `user.reset_password` — **now** Super Admin only, as asked in this round. It used to be implied
  by "manage users", so a migration switched it off for the seven designations that had it only
  because it was seeded that way. Anybody who had been *given* it deliberately keeps it.

---

## What I would do about it, if you want any of it

In the order I would take them:

1. **`asset.manage_tasks`** — the checklist. The one gap where a studio is likely to want a
   different answer from the one hardcoded.
2. **The four hidden columns, enforced server-side** — filter `GET /assets/project/:id` by the same
   rule the page uses, so the switch means the same thing on both sides. Only if hiding those
   columns is meant to be a restriction rather than a tidy-up; tell me which.
3. **`asset.thumbnail`** — small and tidy.
4. Leave 3, 4, 5, 6 and 7 as they are, and record the reasoning rather than adding switches to
   things where a switch would be misleading.

Nothing above has been built. Say which of these you want and I will add them with the standing
rule applied — Super Admin gets each new permission automatically, and the switch appears in
Settings → Permissions.
