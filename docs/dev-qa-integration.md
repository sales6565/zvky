# Dev & QA integration: contract v1

This page is what the Dev & QA app relies on. It is implemented in
`src/routes/integration.js`, `src/integration-events.js`, `src/feedback-lifecycle.js` and
`src/integration-outbox.js`, and tested in `tests/integration-contract.test.js`.

## Switch and settings

| Variable | Purpose |
|---|---|
| `INTEGRATION_ENABLED` | **Required** (`true`). Without it, `/api/integration/v1/*` answers 503 and no events are written or delivered |
| `INTEGRATION_INBOUND_SECRET` | Verifies Dev & QA's signed calls |
| `INTEGRATION_INBOUND_SECRET_PREVIOUS` | Also accepted during a rotation; remove afterwards |
| `INTEGRATION_OUTBOUND_URL` | Dev & QA's receiver: `https://<dev-qa>/api/integrations/forge/events` |
| `INTEGRATION_OUTBOUND_SECRET` | Signs the pushes. It must differ from the inbound secret |
| `INTEGRATION_TEST_ENDPOINTS` | Test suite only. It mounts the `/counter` probe; never set it on a server |

The key is issued under Settings → Dev & QA Integration, with the actions
`health, clients, projects, assets, handoffs, feedback, events` (plus `files` if needed).

## Events

Every event is written in the same transaction as the change it describes, in one
envelope:

```
{ eventId, sequence, type, occurredAt, source: "forge", schemaVersion: 1,
  projectId, entity: { type, id, version }, payload }
```

`entity.version` rises with every event about that entity (`integration_entity_versions`).
Receivers ignore older versions.

The event types are:

- **Clients:** `client.created`, `client.updated`, `client.deleted`
- **Projects:** `project.created`, `project.updated`, `project.deleted`
- **Hand-offs:** `handoff.created`, `handoff.updated`, `handoff.cancelled`
- **Feedback:** `feedback.received`, `feedback.accepted`, `feedback.assigned`,
  `feedback.fix_submitted`, `feedback.changes_requested`, `feedback.fix_approved`,
  `feedback.declined`, `feedback.withdrawn`
- **Assets:** `asset.ready_for_reintegration`

Client and project events carry the whole record. They are emitted by a hook on the
client and project routers, and only when something Dev & QA can see has changed.

## A game bug's life in Forge (`external_feedback.state`)

| State | Meaning |
|---|---|
| `with_lead` | It arrived and moved the idle asset into Game Feedback |
| `noted` | The asset was busy; the bug was noted on the current round |
| `with_artist` | The Team Lead passed it to the artist, or asked for changes to a fix |
| `in_review` | The artist submitted a fix |
| `fix_approved` | Approved at a review gate. `asset.ready_for_reintegration` follows. **Forge never places the asset in a build**; Dev & QA reports the build later through `PUT /assets/:id/in-game` |
| `declined`, `withdrawn` | Closed |

## Calls, results and paging

See `docs/forge-api-contract.md` in the Dev & QA repository for the full table. In short:

- Feedback answers with `result`: `created`, `note_only`, `duplicate`, `refused` (409 with
  a `code`) or `rejected` (400/404 with `errors[]`). An unknown field is refused, never
  dropped. A replay says `replayed: true`.
- Lists page with an opaque cursor. Clients and projects use (updated_at, id); assets use
  (change marker, id), which fixes the old `updated_since` walk that looped when more than
  `limit` assets shared a marker.
- For reconciliation: `GET /health`, `/clients[/:id]`, `/projects[/:id]`,
  `/handoffs[/:id]`, `/feedback/:id` and `/feedback?client_bug_id=`. Withdrawal is
  `POST /assets/:id/feedback/:fid/withdraw`. An internal Send to Dev can be cancelled with
  `POST /api/assets/handoffs/:id/cancel` until Dev & QA acknowledges it.

## Signatures, and checking both apps hold the same secret

Dev & QA signs every call: HMAC-SHA256 over `t.METHOD.<target>.<raw body>` with
`INTEGRATION_INBOUND_SECRET`, where the target is `/api/integration/v1/<path>` with its
query parameters sorted by name. Forge accepts a signature over any of these, each an
exact function of the request that arrived:
- the request line as received (`req.originalUrl`);
- the mount path plus the router path;
- that path with the query in the same fixed order.

So a proxy that adds or strips a path prefix, or reorders the query, does not break it.
Nothing unsigned is accepted, and the ±300 s timestamp window is unchanged.

Surrounding spaces and line breaks in a secret are ignored, and the start-up log says so.
A value wrapped in quotes, or with whitespace inside it, is refused with a clear message.

**Fingerprints.** Forge logs
`[integration] Integration inbound signing key fingerprint: sha256:<12 hex>` at start-up
and shows it to the Super Admin under Settings → Dev & QA Integration. Dev & QA shows the
fingerprint of its `FORGE_SIGNING_SECRET` the same way. Equal fingerprints mean the same
secret. A refused signature is logged with safe facts only: method, path, query names,
body size, timestamp age, signature length, the fingerprint, and whether the API key was
recognised.

