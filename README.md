# ZVKY FORGE 1.0.1

The studio pipeline in a native window, for Windows and Mac. It opens the same
ZVKY FORGE you use in a browser, with the same login and the same data — and
adds an icon in your task bar or dock, notifications the operating system
delivers, and a way to update itself.

**On first launch it asks for your studio address** — the same one you type into
a browser. Your Super Admin has it. It is remembered, and can be changed later
from **File → Studio Address**.

**Notifications:** Windows and macOS each ask once, the first time a
notification is raised, whether ZVKY FORGE may show them. Say yes. To change it
later, that is Settings → System → Notifications on Windows, or System Settings
→ Notifications on a Mac. The app has no setting of its own for this and cannot
override what you tell the operating system.

Neither installer is code-signed — a certificate the studio has not bought,
rather than anything wrong with the files. Each platform warns once, and each
section below says exactly what you will see and what to click.

> This branch exists only to hand out the installers. The source is on
> `claude/tool-roles-server-deploy-cynvp7`, under `desktop/`. **Delete this
> branch once everyone has installed** — it has no history and shares no commits
> with the code, so deleting it is what puts the space back.

## What changed in 1.0.1 — install this one

**1.0.0's "Check for Updates" button was broken.** It reported
`ENOENT ... resources\app-update.yml` and could not be fixed from inside the
app: that build shipped without an update address, and the file it needed in
order to fetch a fix was the file it was missing.

**1.0.1 fixes it, and it is the last time a reinstall is needed for this.**
Uninstall 1.0.0 first, then install this. From here on:

- If no update address is set, the button says so plainly and offers to take
  you to **File → Update Source**, rather than showing an error.
- Whatever you put there is remembered, and updates work from that copy onwards
  — **no further reinstall**.

If a future build is made with the address already baked in, nobody has to set
anything; this is the way back when it is not.

## Windows

**[ZVKY-FORGE-Setup-1.0.1.exe](ZVKY-FORGE-Setup-1.0.1.exe)** — 75 MB. Click it,
then **Download**, then run it.

Uninstall ZVKY FORGE 1.0.0 first (Settings → Apps → ZVKY FORGE → Uninstall).
Your studio address is kept, so you will not have to enter it again.

You will see a blue screen: *"Windows protected your PC — unrecognised
publisher."* That is expected. Click **More info**, then **Run anyway**.

It installs for **you**, not for the whole machine, so it does not ask for an
administrator password.

To check the download arrived whole:

```
certutil -hashfile "ZVKY-FORGE-Setup-1.0.1.exe" SHA256
```

sha256 `16937e25a699c4858e97a21c2141d1522aba9ddd97d6fafbcbabee0fe41da982`

### The previous version

**[ZVKY-FORGE-Setup-1.0.0.exe](ZVKY-FORGE-Setup-1.0.0.exe)** — kept only so a
machine already running it can be matched against a checksum. It has the update
bug above; do not install it.

sha256 `c5adf7542f3551b376cfecbf80ac8777c9ea5f90489fe8fb0c6169105082ae49`

## Mac

Built and **ad-hoc signed** on macOS, which is what lets the Apple Silicon
version start at all — a Mac with an Apple chip refuses to launch a program
carrying no signature whatsoever.

It still has no certificate, so there is one thing to know:

**Do not double-click the app the first time.** macOS refuses to open an
unsigned application that way and offers only Cancel, which reads as a broken
download. Instead: open the .dmg, drag ZVKY FORGE to Applications, then
**right-click it in Applications → Open → Open**. That is Apple's supported
way to run an unsigned app, not a trick, and it is needed once.

Take the **arm64** file for any Mac bought since late 2020, and the other for
an Intel Mac. Unsure which you have? Apple menu → About This Mac.

These are still 1.0.0 and carry the same update bug as the Windows 1.0.0 above.
A 1.0.1 Mac build needs a run of the macOS workflow; ask and it will be built.

### ZVKY-FORGE-1.0.0-arm64.dmg

**[ZVKY-FORGE-1.0.0-arm64.dmg](ZVKY-FORGE-1.0.0-arm64.dmg)** — 91 MB. Click it, then **Download**.

sha256 `c806cbef65ac374795edddb9070877c6f096a689cb7043851042d3b861885f1f`

### ZVKY-FORGE-1.0.0.dmg

**[ZVKY-FORGE-1.0.0.dmg](ZVKY-FORGE-1.0.0.dmg)** — 96 MB. Click it, then **Download**.

sha256 `c66bdd33f61623c14783aef4ce87e8d6bcced37c392c55d95174e554f559c42b`
