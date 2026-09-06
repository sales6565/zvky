# ZVKY FORGE 1.0.2

The studio pipeline in a native window, for Windows and Mac. It opens the same
ZVKY FORGE you use in a browser, with the same login and the same data — and
adds an icon in your task bar or dock, notifications the operating system
delivers, and updates that apply themselves.

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

## Updates: nobody presses anything

From 1.0.2 onwards, updating is automatic:

- The app checks shortly after it starts, and every six hours while it stays
  open.
- A new version **downloads in the background**. A red bar says so. It is a
  notice, not a question — ignoring it is fine.
- It **installs when you close ZVKY FORGE**, adding a few seconds to a close you
  were doing anyway. Nothing is ever interrupted mid-work.

**Restart Now** on that bar is for anyone who wants it immediately. Nobody has
to press it; every copy updates either way.

**One thing has to be set up once**, by whoever publishes versions: the folder
on the studio's hosting where installers are kept. Either it is baked into the
build, or it goes in under **File → Update Source**. Until then the app runs
perfectly and simply has nowhere to look.

## Which build should I install?

**1.0.2 — this one.** 1.0.0's update button was broken outright, and 1.0.1
still needed a click for each update.

Uninstall whatever is there first (Settings → Apps → ZVKY FORGE → Uninstall),
then install 1.0.2. Your studio address is kept, so you will not re-enter it.
**This is the last uninstall–reinstall needed** — from 1.0.2 on, versions
replace themselves.

## Windows

**[ZVKY-FORGE-Setup-1.0.2.exe](ZVKY-FORGE-Setup-1.0.2.exe)** — 75 MB. Click it,
then **Download**, then run it.

You will see a blue screen: *"Windows protected your PC — unrecognised
publisher."* That is expected. Click **More info**, then **Run anyway**.

It installs for **you**, not for the whole machine, so it does not ask for an
administrator password.

To check the download arrived whole:

```
certutil -hashfile "ZVKY-FORGE-Setup-1.0.2.exe" SHA256
```

sha256 `1fc3721f25cd9a3cb2a81e3de9908763d8971be2b4368444fe6a11187180465e`

### Older Windows builds

Kept only so a machine already running one can be matched against a checksum.
Do not install these.

- `ZVKY-FORGE-Setup-1.0.1.exe` — updates work but need a click each time.
  sha256 `16937e25a699c4858e97a21c2141d1522aba9ddd97d6fafbcbabee0fe41da982`
- `ZVKY-FORGE-Setup-1.0.0.exe` — the update button fails with an error.
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

### ZVKY-FORGE-1.0.2-arm64.dmg

**[ZVKY-FORGE-1.0.2-arm64.dmg](ZVKY-FORGE-1.0.2-arm64.dmg)** — 91 MB. Click it, then **Download**.

sha256 `aabd30dd699aa0ff16009272f750701bcd4db37ecf0013bb015f96c959067808`

### ZVKY-FORGE-1.0.2.dmg

**[ZVKY-FORGE-1.0.2.dmg](ZVKY-FORGE-1.0.2.dmg)** — 96 MB. Click it, then **Download**.

sha256 `b57e4f3553153e513d64eceb2f295617d266cfb729f8a55cecfcfc1b19c83559`
