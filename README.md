# ZVKY FORGE for Windows — 1.0.0

**[ZVKY-FORGE-Setup-1.0.0.exe](ZVKY-FORGE-Setup-1.0.0.exe)** — 78 MB

Click the file above, then the **Download** button. Run it.

## What you will see

A blue screen: *"Windows protected your PC — unrecognised publisher."*

That is expected. The installer is not code-signed — a certificate the studio has
not bought, rather than anything wrong with the file.

- Click **More info**, then **Run anyway**.

It installs for **you**, not for the whole machine, so it does not ask for an
administrator password.

## First launch

It asks for your **studio address** — the same one you type into a browser.
Your Super Admin has it. It is remembered, and can be changed later from
**File → Studio Address**.

## Notifications

Windows asks once, the first time a notification is raised, whether ZVKY FORGE
may show them. Say yes. To change it later: Settings → System → Notifications →
ZVKY FORGE.

## Checking the download

```
certutil -hashfile "ZVKY-FORGE-Setup-1.0.0.exe" SHA256
```

should print:

```
c5adf7542f3551b376cfecbf80ac8777c9ea5f90489fe8fb0c6169105082ae49
```

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

### ZVKY-FORGE-1.0.0-arm64.dmg

**[ZVKY-FORGE-1.0.0-arm64.dmg](ZVKY-FORGE-1.0.0-arm64.dmg)** — 91 MB. Click it, then **Download**.

sha256 `c806cbef65ac374795edddb9070877c6f096a689cb7043851042d3b861885f1f`

### ZVKY-FORGE-1.0.0.dmg

**[ZVKY-FORGE-1.0.0.dmg](ZVKY-FORGE-1.0.0.dmg)** — 96 MB. Click it, then **Download**.

sha256 `c66bdd33f61623c14783aef4ce87e8d6bcced37c392c55d95174e554f559c42b`
