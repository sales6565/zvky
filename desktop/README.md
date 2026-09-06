# ZVKY FORGE for the desktop

A native window onto the studio's own ZVKY FORGE, for Windows and Mac.

It is a **wrapper**, not a second copy of the application. It opens the same
address a browser opens, over the same HTTPS, with the same login and the same
data. What it adds is the three things a browser tab cannot give it:

- an icon in the task bar and the dock, with its own window;
- **notifications the operating system delivers**, which arrive whether or not
  a browser is open, and which do not ask each person for permission;
- **an update it can install itself**, from a folder on the studio's own hosting.

## What it did NOT change

Nothing. Not one file of the web application, its database, or its GoDaddy
deployment was modified to make this work, and none needs to be:

- The web application already calls the standard `new Notification(...)`.
  Inside this window that same code reaches the operating system's notification
  centre instead of the browser's. The desktop notifications are the web
  application's own, unchanged.
- This project is a directory beside the application, not inside it. It requires
  nothing from it and is required by nothing in it.
- `scripts/build-godaddy-zip.sh` packs an explicit list of top-level
  directories, so this one is not in the deployed zip and cannot make it larger.

If this wrapper were deleted tomorrow, the web application would be exactly as it
is now.

---

## Installing it

### Windows

Run **ZVKY FORGE Setup 1.0.0.exe**.

**You will see a blue warning:** *"Windows protected your PC — unrecognised
publisher."* This is expected. The installer is not code-signed, which is a
certificate the studio has not bought rather than anything wrong with the file.

- Click **More info**, then **Run anyway**.

It installs **for the person running it**, not for the whole machine, so it does
not ask for an administrator password.

### macOS

Open **ZVKY FORGE-1.0.0.dmg** (Intel) or **ZVKY FORGE-1.0.0-arm64.dmg** (Apple
Silicon — any Mac bought since late 2020), and drag ZVKY FORGE to Applications.

**Do not double-click it the first time.** macOS refuses to open an unsigned
application that way and offers only Cancel, which reads as a broken download.

- **Right-click** (or Control-click) ZVKY FORGE in Applications → **Open** →
  **Open**.

That is Apple's supported way to run an unsigned application, not a trick. It is
needed once; afterwards it opens normally.

### The first time it starts

It asks for your **studio address** — the same one you type into a browser. Your
Super Admin has it. It is remembered, and can be changed later from
**File → Studio Address**.

### Notifications

Windows and macOS each ask you once, the first time a notification is raised,
whether this application may show them. Say yes. If you said no and want them
back:

- **Windows:** Settings → System → Notifications → ZVKY FORGE.
- **macOS:** System Settings → Notifications → ZVKY FORGE.

The application itself has no setting for this and cannot override the
operating system's answer, in either direction.

---

## Updating

It checks quietly a few seconds after it starts. **Nothing downloads and nothing
installs on its own.**

- When there is a new version, a red bar appears across the top of the window:
  *"Version 1.1.0 of ZVKY FORGE is available."* with **Update Now** and
  **Later**.
- **Check for Updates…** under File (Windows) or the application menu (Mac) does
  the same check on demand, and always answers — including "you have the latest
  version", which a silent button never tells you.
- **Update Now** downloads, showing progress. When it has finished it asks
  again before restarting, because that is the step that closes what you are
  looking at.

### Publishing an update

1. Raise `version` in `desktop/package.json`.
2. Build with the feed address set:

   ```sh
   cd desktop
   ZVKY_UPDATE_FEED=https://your-domain.com/desktop/ npm run build:win
   ```

3. Upload **everything in `desktop/dist/`** that the build produced — the
   installer, its `.blockmap`, and `latest.yml` — into that same folder on the
   hosting.

`latest.yml` is what an installed copy reads. The installer without it means
nobody is told there is an update; `latest.yml` without the installer beside it
means everybody is told about a version they cannot download. Upload them
together.

The feed address is **baked into the installer at build time**. A copy built
without `ZVKY_UPDATE_FEED` works perfectly but will report that no update
information was published — so set it before the first build you hand out.

It is deliberately a different setting from the studio address: one is where the
installers live, the other is where the studio is.

---

## Building

```sh
cd desktop
npm install

npm run check     # what can be checked without a screen
npm run smoke     # runs the real app in a window and asks it questions
npm run build:win # -> dist/ZVKY FORGE Setup <version>.exe
```

### Windows, from Linux

Works, and is how the current installer was built. It needs Wine — not to run
anything, but to set the icon and version details on the `.exe`:

```sh
sudo dpkg --add-architecture i386 && sudo apt-get update
sudo apt-get install --no-install-recommends wine wine32
```

Without it the build stops with *"wine is required"* rather than producing an
`.exe` with a default Electron icon.

### macOS

**A `.dmg` cannot be built anywhere but on a Mac.** It is made with `hdiutil`,
which is part of macOS; there is no cross-compiler and no flag that changes
this. `npm run build:mac` on Linux says so and then fails on the same fact.

Two routes:

- **On a Mac:** `npm install && npm run build:mac`.
- **Without one:** copy `ci/build-macos.yml` to `.github/workflows/` and run it
  from the Actions tab. It is dispatch-only — it never runs by itself — and it
  builds both the Intel and Apple Silicon disk images on a GitHub macOS runner.
  It is not placed there already because that directory belongs to the web
  application, which this project does not touch.

### Signing, later

Both platforms are built **unsigned**, as agreed — which is why each shows a
one-time warning above. Signing removes the warnings and costs a certificate per
year:

- **Windows** (~£200/yr, and an EV certificate is needed for SmartScreen to trust
  it immediately): set `CSC_LINK` and `CSC_KEY_PASSWORD` in the build
  environment. Nothing in this project changes.
- **macOS** (an Apple Developer account, ~£80/yr): remove `identity: null` from
  `electron-builder.yml`, set `hardenedRuntime: true`, and notarise. Both lines
  are commented in that file to say so.

---

## What is in here

| | |
|---|---|
| `src/main.js` | The window, the menu, and which permissions the page is granted. |
| `src/config.js` | Which studio this window opens, and where that is remembered. |
| `src/updates.js` | The update policy: check quietly, install only on a click. |
| `src/preload.js` | The update bar, and the bridge — exposed only to the screens below. |
| `renderer/setup.html` | First run: which studio? |
| `renderer/offline.html` | When it cannot be reached, and what to try. |
| `scripts/check.js` | Static checks: `npm run check`. |
| `scripts/smoke.js` | The real app in a real window: `npm run smoke`. |
| `scripts/build.js` | Build wrapper: makes the update feed optional. |
| `scripts/make-icon.js` | Generates the icon and the installer sidebar. |
| `ci/build-macos.yml` | The macOS build, to copy into `.github/workflows/`. |

### The two checks

`npm run check` reads the source. It catches the mistakes that are **silent at
runtime** — chief among them a missing or mismatched Windows Application User
Model ID, without which Windows discards every notification with no error
anywhere.

`npm run smoke` starts the real `main.js`, waits for the window, and questions it
from outside: does the page load, is `Notification.permission` actually
`granted`, is `window.zvky` absent from the studio's page, does the update bar
appear and then remove itself. It writes a screenshot of each screen to
`dist-smoke/`.

```sh
ZVKY_APP_URL=https://your-domain.com npm run smoke
```

It is worth having because of what it found: the permission check compared
`https://studio` against `https://studio/` and refused. Notifications were
silently unavailable, and nothing in the code read as wrong.
