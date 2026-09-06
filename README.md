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

Not here — a `.dmg` can only be built on a Mac. See `desktop/README.md` on the
`claude/tool-roles-server-deploy-cynvp7` branch for the two ways to produce one.

---

This branch exists only to hand out the installer. The source is on
`claude/tool-roles-server-deploy-cynvp7`, under `desktop/`. **Delete this branch
once everyone has installed it** — that is what keeps the 78 MB out of the
repository for good.
