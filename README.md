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

**[ZVKY-FORGE-1.0.0-arm64.dmg](ZVKY-FORGE-1.0.0-arm64.dmg)** — 99 MB. Click it, then **Download**.

sha256 `194ed3f7133df7d0358d50a742455a25b6ab0d9bd5705f28f7770034f593e304`

### ZVKY-FORGE-1.0.0.dmg

105 MB — too large for GitHub to hold in one piece, so it is in
2 parts. Download all of them into one folder:

- [ZVKY-FORGE-1.0.0.dmg.part0](ZVKY-FORGE-1.0.0.dmg.part0)
- [ZVKY-FORGE-1.0.0.dmg.part1](ZVKY-FORGE-1.0.0.dmg.part1)

Then rejoin them:

```
cat ZVKY-FORGE-1.0.0.dmg.part* > "ZVKY FORGE-1.0.0.dmg"
```

sha256 `26c98311808b5d1af20d085e3b0ab73279d834d881b9f095b876f9008f606f6f`
