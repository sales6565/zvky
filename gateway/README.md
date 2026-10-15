# The office file gateway

This is the only process in the system that touches the studio's file share. It
runs on a machine in the office, serves files to browsers on the office network,
and reports to Forge over the internet. **Forge never connects to it.**

```
  browser  ──HTTPS on the LAN──►  this gateway  ──►  \\SERVER\Projects
     │                                 │
     └──HTTPS over the internet──► Forge (GoDaddy) ◄─┘ heartbeat, config, callbacks
                                   permissions, tokens, audit — never a file
```

Three rules this installation has to keep. Everything below is in service of them.

1. **Do not port-forward this.** It listens on the LAN address you give it and
   nothing else. Everyone who needs it is in the office.
2. **It cannot delete, rename, move or overwrite a stored file.** There is no
   route and no code path for it. The one thing it deletes is its own
   `.incoming` scratch area. Removing a file for real is a job you do on the
   server, by hand — see [Deletion requests](#deletion-requests).
3. **No file ever reaches Forge.** Bytes go browser ⇄ gateway. Forge gets a
   path, a size and a checksum.

---

## 1. What you need

* A machine on the office LAN that is on whenever people are working, with the
  file share mounted or local. A small VM or an always-on workstation is fine;
  this process is I/O, not CPU.
* **Node.js 18 or newer.** No build step and no dependencies to install — the
  package uses only what Node ships with.
* An **internal DNS name** pointing at that machine's LAN address, under a
  domain you control: `files.office.example`.
* A **TLS certificate** for that name (§3).
* From Forge: Settings → Server gives you the **gateway secret** (shown once)
  and tells you the **gateway id** you set there.

## 2. Install

Copy the `gateway/` folder out of the repository onto the machine. It is not in
the Forge deploy zip, on purpose: this code must never run on the hosting.

```
C:\forge-gateway\      (Windows)
/opt/forge-gateway/    (Linux)
```

Configuration is environment variables. Every one of them is local to this
machine; nothing here comes from Forge.

| Variable | Example | What it is |
|---|---|---|
| `FILE_ROOT` | `D:\Projects` or `/srv/projects` | The top of the share. Nothing outside it is reachable, ever. |
| `LISTEN_ADDRESS` | `192.168.10.20` | The LAN address to bind. **Required.** `0.0.0.0` is refused. |
| `LISTEN_PORT` | `8443` | Default 8443. |
| `TLS_CERT` / `TLS_KEY` | paths | The certificate and key for the internal DNS name (§3). |
| `FORGE_URL` | `https://pipeline.zvky.com` | Where Forge is. Also decides the one browser origin CORS allows. |
| `GATEWAY_ID` | `GW-OFFICE` | Must match Settings → Server exactly. A token for another gateway is refused. |
| `GATEWAY_SECRET` | 64 characters | From Settings → Server → Generate. Shown once. |
| `STATE_DIR` | `C:\forge-gateway\state` | Config cache, callback queue, audit log. Defaults to `state/` beside the package. |
| `HEARTBEAT_SECONDS` | `30` | Default 30. |
| `CONFIG_SECONDS` | `300` | How often to re-read settings from Forge. Default 300. |
| `RATE_LIMIT_PER_MINUTE` | `600` | Per client address. Default 600; a large upload is hundreds of chunk requests. |

Start it by hand first, and read what it prints:

```
node index.js
```

It refuses to start with an incomplete configuration and names each missing
variable. Then check `https://files.office.example:8443/health` from a browser
**on the office network** — you should get `{"ok":true}`.

### Windows, as a service

Run it under the Windows Service Wrapper or NSSM so it starts with the machine.
With NSSM:

```
nssm install ForgeGateway "C:\Program Files\nodejs\node.exe" "C:\forge-gateway\index.js"
nssm set ForgeGateway AppDirectory C:\forge-gateway
nssm set ForgeGateway AppEnvironmentExtra FILE_ROOT=D:\Projects LISTEN_ADDRESS=192.168.10.20 ^
  TLS_CERT=C:\forge-gateway\cert.pem TLS_KEY=C:\forge-gateway\key.pem ^
  FORGE_URL=https://pipeline.zvky.com GATEWAY_ID=GW-OFFICE GATEWAY_SECRET=...
nssm set ForgeGateway AppStdout C:\forge-gateway\state\out.log
nssm set ForgeGateway AppStderr C:\forge-gateway\state\err.log
nssm start ForgeGateway
```

Run the service as a **dedicated account** with the share permissions in §4 —
not as a user who can delete things.

### Linux, as a systemd unit

`/etc/systemd/system/forge-gateway.service`:

```ini
[Unit]
Description=Forge office file gateway
After=network-online.target remote-fs.target

[Service]
Type=simple
User=forge-gateway
WorkingDirectory=/opt/forge-gateway
EnvironmentFile=/etc/forge-gateway.env
ExecStart=/usr/bin/node index.js
Restart=always
RestartSec=5
# It needs the share and its own state directory, and nothing else.
ProtectSystem=strict
ReadWritePaths=/srv/projects /opt/forge-gateway/state
PrivateTmp=yes
NoNewPrivileges=yes

[Install]
WantedBy=multi-user.target
```

`/etc/forge-gateway.env` holds the variables, `chmod 600`, owned by root. It
contains the gateway secret, so it is a credential file:

```
systemctl daemon-reload && systemctl enable --now forge-gateway
journalctl -u forge-gateway -f
```

## 3. The certificate, without opening anything

The page that talks to this gateway is served over HTTPS, so the gateway must be
HTTPS too — a browser will not let an https page talk to an http address. And it
must be a certificate browsers already trust, on a **name**, because an IP
address certificate is a bad time.

Use **DNS-01** validation. It proves you control the domain by writing a DNS
record, so the machine never has to be reachable from the internet:

```
certbot certonly --manual --preferred-challenges dns -d files.office.example
```

or, better, your DNS provider's plugin so renewal is automatic:

```
certbot certonly --dns-cloudflare -d files.office.example
```

Point `files.office.example` at the machine's **LAN address** in internal DNS
(or in the provider's zone — a public A record pointing at 192.168.x.x is not a
security problem and makes laptops work without split-horizon DNS).

> **Do NOT port-forward 8443, and do not put this behind a public reverse
> proxy.** The certificate is for a name, not for exposure. DNS-01 exists so you
> never have to open a port to get one.

After renewal, restart the service — Node reads the certificate at start.

## 4. Share permissions: the service account may create, never destroy

This is where rule 2 stops being a promise and becomes a fact about the
filesystem. The gateway's account should be able to add files and folders and
**not** be able to change or remove what is already there.

### NTFS

On `FILE_ROOT`, for the gateway's service account:

| Permission | Setting |
|---|---|
| Traverse folder / execute file | Allow |
| List folder / read data | Allow |
| Read attributes, read permissions | Allow |
| **Create files / write data** | Allow |
| **Create folders / append data** | Allow |
| Write attributes | Allow |
| **Delete** | **Deny** |
| **Delete subfolders and files** | **Deny** |
| Change permissions, take ownership | **Deny** |

Then, on `FILE_ROOT\.incoming` only, **remove the two Deny entries** so the
gateway can clean up its own scratch area. Create that folder yourself first:

```
mkdir D:\Projects\.incoming
icacls D:\Projects\.incoming /grant "FORGE-GATEWAY:(OI)(CI)(M)"
```

A Deny on Delete at the root and an Allow inside `.incoming` is the whole
arrangement. With it in place, a bug in this software cannot delete a render.

### Linux

Give the gateway its own user, make the share group-writable to it, and make
finished files read-only (the gateway already chmods them to `0444`):

```
chown -R root:forge-gateway /srv/projects
chmod -R 2775 /srv/projects            # setgid, so new files inherit the group
chmod +t /srv/projects                 # sticky: only the owner may unlink
mkdir -p /srv/projects/.incoming && chown forge-gateway /srv/projects/.incoming
```

The sticky bit on the directories is the important part: it stops the gateway's
account unlinking a file it does not own, which is every finished file, because
ownership passes with the `0444`. `.incoming` is its own, so cleanup still works.

## 5. Backups and shadow copies

Nothing in this system is a backup, and nothing in it can undo a deletion.

* Windows: turn on **Shadow Copies** for the volume holding `FILE_ROOT`, twice a
  day. Previous Versions then gives you a right-click restore for an overwritten
  or deleted file, which is the fastest recovery there is.
* Linux: ZFS or Btrfs snapshots on a schedule, or `rsnapshot` to a second disk.
* Either way, an **off-machine copy** as well. A ransomware event takes the
  share and its snapshots together.

## 6. Rotating the secret and the keys

Both are done in Forge, in Settings → Server, and both have an overlap window
(default 60 minutes) so there is no moment when everything fails.

**Gateway secret.** Press Regenerate, copy the value shown — it is shown once —
put it in `GATEWAY_SECRET`, restart the service. Forge accepts the old and the
new secret until the overlap expires.

**Token signing key.** Press Rotate. The gateway picks both keys up on its next
configuration fetch (within `CONFIG_SECONDS`), so tokens minted before the
rotation keep working. Nothing to do on this machine.

The gateway holds **public** keys only. There is no private key on this machine
to steal, which is why a compromised gateway cannot mint itself a token.

## 7. Deletion requests

People in Forge can ask for a file to be deleted, with a reason. Whoever holds
*Resolve Deletion Requests* sees the list in the Server tab.

**Forge cannot carry it out.** You delete the file here, on the server, with
Explorer or `rm`, using an account that is allowed to — not the gateway's. Then
mark the request done in Forge, which records that it was handled and tells the
person who asked.

That split is deliberate: a studio's archive should not be deletable by anybody
who can get a session cookie.

## 8. What it serves, exactly

| Route | What it does |
|---|---|
| `GET /health` | `{"ok":true}`. Nothing else — no version, no paths. |
| `GET /v1/app` | The small page the Server tab opens when a browser will not talk to a private address directly (§10). Serves no file content. |
| `GET /v1/list` | One folder, paginated, no recursion. |
| `POST /v1/folder` | Creates a folder. Fails if it exists. |
| `PUT /v1/upload/:id/chunk` | One chunk, written at its offset. |
| `GET /v1/upload/:id/status` | Which byte ranges have arrived, so a browser can resume. |
| `POST /v1/upload/:id/complete` | Checks the size and moves the file into place. |
| `GET /v1/download` | One file, as an attachment, with Range support. |
| `PUT` / `GET /v1/selftest` | Writes and reads a kilobyte inside `.incoming/selftest`. |

Anything else is 404. Any other verb on these is 405. **There is no DELETE.**

Every one of them except `/health` and `/v1/app` requires a token Forge signed,
for that operation, for that path, which expires in 60 seconds (30 minutes for
an upload) and — for a download — works exactly once.

## 9. Troubleshooting

**"The office file gateway cannot start: its configuration is incomplete."**
It names each missing variable. `LISTEN_ADDRESS` is the one people forget; it is
required on purpose so this can never bind every interface.

**Settings → Server says no heartbeat has arrived.** The gateway dials out to
`FORGE_URL` every 30 seconds. Check, in order: the service is running
(`journalctl -u forge-gateway` / the NSSM logs); outbound HTTPS from this machine
is allowed; `FORGE_URL` has no typo and no trailing path; the time on this
machine is right — a signature more than five minutes out is refused, and a
clock that has drifted is the single most common cause.

**"The request signature does not match" in Forge's log.** `GATEWAY_SECRET` is
not the value Forge now holds. Regenerate it in Settings → Server and paste it
again. Watch for a trailing newline or a space from the copy.

**The Server tab says "contact IT" but the service is running.** The heartbeat
is getting through but the browser cannot reach you. Press *Run self-test* in
Settings → Server from a machine in the office: it checks reachability, the
certificate and CORS separately and says which one failed.

**The browser reaches `/health` but uploads do nothing, with no error.** That is
Chrome's Local Network Access permission, and it is what §10 is about.

**A file came out as `name (2).ext`.** Working as intended: a file with that name
already existed and nothing is ever overwritten. The person who uploaded it is
told what it was saved as.

**`.incoming` is large.** Abandoned uploads are swept after
`incomingMaxAgeMinutes` (Settings → Server, default a day). It is safe to delete
anything in there by hand while nobody is uploading.

## 10. Why there is a second window sometimes

Current Chromium — Chrome and Edge both — refuses a `fetch` from a page on a
**public** address (Forge, on the internet) to a server on a **private** address
(this gateway) until the user grants *Local Network Access*. Measured in Chromium
141: the request does not fail, it **hangs**, with nothing on the wire and
nothing in the console. An iframe is treated the same way. A **top-level
navigation** is not, and neither is a page talking to its own origin.

So the Server tab checks, without making a request, whether this browser has
that gate:

* **The desktop app** (Electron 33 / Chromium 130) has no such gate. It talks to
  the gateway directly.
* **A browser where you have set the policy** (below) has the permission already.
  Same — direct.
* **Anything else** opens a small window served by this gateway (`/v1/app`),
  which relays between the Forge tab and this machine. The person sees an extra
  window titled "Office file link" and is told to keep it open. Files still go
  straight from their browser to this machine.

To get the direct path everywhere, push this policy to the office fleet
(Group Policy on Windows, a configuration profile on macOS, or
`/etc/opt/chrome/policies/managed/forge.json` on Linux):

```json
{ "LocalNetworkAccessAllowedForUrls": ["https://pipeline.zvky.com"] }
```

Verified to work: with it set, `navigator.permissions.query({name:
'local-network-access'})` reports `granted` and the tab uses the direct path with
no prompt. The older `InsecurePrivateNetworkRequestsAllowedForUrls` policy has
**no effect** in current Chromium — do not bother with it.

## 11. Logs

* `state/audit.log` — one JSON line per operation: who, what, which path, how
  many bytes. Tokens and signatures are redacted before anything is written.
* The service log — requests with their status and duration, configuration
  fetches, heartbeat failures, and anything refused with the reason.

Neither ever contains a token, a secret or file content.
