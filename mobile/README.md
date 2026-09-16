# Zvky on iOS and Android

Two native apps for the studio's own team. **Neither goes on the App Store or
Google Play** — they are installed from a link on the studio's own server.

Both are *shells*: a native app whose whole screen is a web view pointed at the
live web application. That is the design decision everything else follows from,
so it is worth being blunt about what it buys and what it costs.

**What it buys.** A change deployed to the website is on every phone the next
time somebody opens the app. No rebuild, no redistribution, no App Store review,
nobody stuck on last month's version. Over a year of ordinary feature work this
is the difference between the apps staying useful and the apps quietly rotting.

**What it costs.** The app needs the network to show anything at all. There is
no offline mode and this is not a bug — it shows a proper offline screen with a
retry, and comes back the moment the connection does.

**What is genuinely native**, and could not be done from the browser:

| | |
|---|---|
| Push notifications | Arrive on the lock screen with the app closed. APNs on iOS, FCM on Android. |
| Camera | "Take a photo" beside every file picker, feeding the same upload the web app already has. |
| Session persistence | The sign-in survives the system evicting the web view's storage. |
| Android back button | Closes a panel, then goes back, then asks before leaving. |
| Safe areas | Content clears the notch and the home indicator. |
| Pull to refresh | Re-renders the current screen. |

---

## The shortest path to an installed app

**You do not need Android Studio, and for Android you do not need anything at
all.** Both builds run on GitHub's own machines and come back as a file you
download from the browser:

| | |
|---|---|
| **Android** | Actions → **Mobile — Android APK** → *Run workflow*. A few minutes later the APK is under **Artifacts** on that run. Works with no setup whatsoever — see the note on debug vs release signing in §4 and in the workflow's own header. |
| **iOS** | Actions → **Mobile — iOS IPA (Ad Hoc)** → *Run workflow*. This one needs five Apple secrets set on the repository first, because Apple will not sign an app without the studio's certificate. §5 and §6 are how to get them. |

The workflows are in `.github/workflows/` — `mobile-android.yml`,
`mobile-ios.yml` and `mobile-ios-unsigned.yml` — and each carries its own
instructions at the top.

### Just your own iPhone?

The Ad Hoc route above answers "get the app to the studio". For one person on
one phone it is the wrong tool, and the $99 is a poor reason to go without.
There are three routes and they are genuinely different:

| | Free Apple ID | Ad Hoc ($99/yr) | App Store |
|---|---|---|---|
| Cost | nothing | $99/year | $99/year |
| Devices | your own | up to 100 | anyone |
| Lasts | **7 days** | 1 year | indefinitely |
| Push notifications | **no** | yes | yes |
| Needs a Mac | no | no (CI does it) | no |
| Review by Apple | no | no | yes |

**The free route, start to finish:**

1. Actions → **Mobile — iOS IPA (unsigned, for your own phone)** → *Run
   workflow*. Download the artifact and unzip it. No Apple account is involved
   in this step and the workflow needs no secrets.
2. Install **[Sideloadly](https://sideloadly.io)** (Windows or Mac) or
   **[AltStore](https://altstore.io)** on a computer.
3. Plug the iPhone in, drag `zvky-unsigned.ipa` in, sign in with your ordinary
   Apple ID. It signs the app for your device and installs it.
4. On the phone: **Settings → General → VPN & Device Management → your Apple
   ID → Trust**.

**The seven days are real.** On the eighth day the app stops opening until you
plug in and re-sign it. AltStore can do that refresh over wifi on its own if
you leave its helper running; with Sideloadly it is a manual repeat. This is
Apple's limit on free provisioning — nothing in this repository can move it,
and the paid membership is what lifts it to a year.

**Push will not work on a free-signed build**, because the entitlement needs a
paid team. Everything else does: the whole application, the camera, the offline
screen, pull to refresh.

The signing is deliberately left to your own machine rather than done in CI. A
free Apple ID cannot sign from CI at all, and doing it there would mean handing
a workflow your Apple password — so the build stops one step short and your
credentials stay where they belong.

Everything below is the manual route, and the reference for what the automated
one is doing.

---

## Contents

1. [What is in this folder](#1-what-is-in-this-folder)
2. [First-time setup](#2-first-time-setup)
3. [Push notifications — the keys](#3-push-notifications--the-keys)
4. [Building and distributing Android](#4-building-and-distributing-android)
5. [Building and distributing iOS](#5-building-and-distributing-ios)
6. [Adding a new employee's iPhone](#6-adding-a-new-employees-iphone)
7. [The annual iOS rebuild](#7-the-annual-ios-rebuild-not-optional)
8. [Hosting the files, and the install links](#8-hosting-the-files-and-the-install-links)
9. [When something does not work](#9-when-something-does-not-work)

---

## 1. What is in this folder

```
mobile/
  capacitor.config.json     the server URL, the offline fallback, plugin config
  package.json              the Capacitor dependencies and the build scripts
  shell/
    index.html              only ever seen if server.url is unreachable at build time
    offline.html            the offline screen, with a real retry
  resources/
    source.html             the brand mark — ONE definition, rendered into both images
    icon.png                1024x1024, generated
    splash.png              2732x2732, generated
  scripts/
    make-resources.js       source.html -> icon.png + splash.png
    build-android.sh        one signed release APK
    make-ios-manifest.js    the .plist an itms-services:// link needs
```

Two things live **outside** this folder on purpose:

- **`public/native-bridge.js`** — everything native-specific that the *page* does
  (safe areas, back button, camera, pull-to-refresh, push registration). It is
  part of the web app, so it updates with a web deploy like everything else. If
  it lived in the shell, changing the back-button behaviour would mean
  rebuilding and redistributing both apps.
- **`android/` and `ios/`** — created by `npx cap add`, not committed. They are
  generated, they are large, and Capacitor regenerates them from the config.

### The web app at phone width

The shells are the width of a phone, so the web application was swept at 390px
and 360px in a real browser, tab by tab, looking for the one failure that only
happens there: something wider than the viewport, which makes the whole
*document* scroll sideways so the header and tab strip slide away while you read
a column. Three were found and fixed in the web app, not in the shells:

- **The tab strip.** Eleven tabs need 733px. `.tabs` was `overflow:hidden` with
  no wrapping, so at 390px seven tabs were not squeezed or wrapped — they were
  unreachable. It now scrolls horizontally below 860px, and `setTab` scrolls the
  chosen tab into view so a tab reached from the Android back button or a
  redraw is never the hidden one.
- **Wide tables.** The Assets List is 1088px and the Users list 975px. Each
  table now gets its own horizontal scroller (`wrapWideTables()` after every
  render), so the table scrolls and the page does not. Tables that already had
  a scroller — the P&L ones — are left alone rather than double-wrapped.
- **Two layout floors.** The Users toolbar did not wrap, and `.pnl-panel` sat
  414px inside a 342px grid cell because a grid item's `min-width` defaults to
  `auto` and will not shrink below its content.

All three are inside `@media (max-width: 860px)` or are inert on a wide screen,
and the desktop layout was re-checked at 1600px afterwards and is unchanged.

---

## 2. First-time setup

This is the **local** route. If you only want the finished app, the workflows
above build both without any of it.

You need **Node 20+**. For Android you also need **Android Studio**, which
brings the SDK; for iOS, **a Mac with Xcode**. Neither can be worked around
locally — every part of the Android toolchain is served from `dl.google.com`,
and Apple will not sign an app anywhere but macOS.

```bash
cd mobile
npm install

# Point the apps at the studio's real address, if it is not already right.
#   capacitor.config.json -> server.url
# It MUST be https. Android and iOS both refuse a plain-http origin by default.

# Generate the icon and splash from resources/source.html, then fan them out
# into every size the two platforms want.
node scripts/make-resources.js
npm run icons

npm run add:android      # creates android/
npm run add:ios          # creates ios/   (Mac only)
npm run sync
```

`npm run sync` is the command to re-run after **any** change to
`capacitor.config.json` or the plugin list. It is cheap; run it when in doubt.

---

## 3. Push notifications — the keys

Push is **off** until the server has keys, and the app is careful about that: it
asks `/api/push/config` before it prompts anybody for permission, so a build
talking to a server with no keys never raises a notification prompt it cannot
honour. Settings → Mobile Apps, and the Profile toggle, both say so plainly.

All of the following go in the server's `.env` — **not** in this repository, and
not into a chat window.

### Apple (APNs)

1. In the [Apple Developer portal](https://developer.apple.com/account) →
   **Certificates, Identifiers & Profiles → Keys** → **+**.
2. Tick **Apple Push Notifications service (APNs)**, name it, **Continue**,
   **Register**.
3. **Download the `.p8`.** Apple lets you download it exactly once. Put it in the
   studio's password manager immediately.
4. Note the **Key ID** (on that page) and the **Team ID** (top right of the
   portal).

```bash
APNS_KEY_ID=ABCD123456
APNS_TEAM_ID=TEAM123456
APNS_BUNDLE_ID=com.zvky.forge
APNS_KEY_P8="-----BEGIN PRIVATE KEY-----\nMIGT...\n-----END PRIVATE KEY-----"
# APNS_HOST defaults to api.push.apple.com, which is correct for Ad Hoc builds.
# A *development* build from Xcode talks to api.sandbox.push.apple.com instead.
```

`\n` is accepted in place of real newlines, because .env files handle multi-line
values badly.

### Google (FCM)

1. [Firebase console](https://console.firebase.google.com) → create or open the
   project → **Add app → Android**, package name **`com.zvky.forge`**.
2. Download **`google-services.json`** and put it at
   `mobile/android/app/google-services.json`. **The Android build needs this
   file** — without it the app cannot obtain a token at all.
3. **Project settings → Service accounts → Generate new private key**. That JSON
   holds the three values below.

```bash
FCM_PROJECT_ID=zvky-forge
FCM_CLIENT_EMAIL=firebase-adminsdk-xxxxx@zvky-forge.iam.gserviceaccount.com
FCM_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIIEv...\n-----END PRIVATE KEY-----"
```

Restart the server after adding either set. Then, from a phone with the app
installed and signed in, use **`POST /api/push/test`** — it sends one
notification to your own account and tells you which half of the pipeline failed
if it does not arrive.

> **One platform at a time is fine.** Missing APNs keys switch iOS push off and
> leave Android working, and the reverse. Nothing else in the application
> changes: the bell and the emails are unaffected either way.

---

## 4. Building and distributing Android

### The keystore — read this before the first build

Android identifies an app **by the key it was signed with**. An update must be
signed with the *same* key as the install it replaces, forever.

```bash
keytool -genkeypair -v -keystore zvky-release.jks -alias zvky \
  -keyalg RSA -keysize 4096 -validity 10000
```

> ### Back this file up somewhere that is not the build machine.
> If the keystore is lost, there is no recovery and no appeal. Every person in
> the studio has to **uninstall** the app and install the new one — there is no
> upgrade path across a key change. Password manager, and an encrypted copy
> somewhere else. Not in this repository.

### Building

> Or skip all of this: Actions → **Mobile — Android APK** builds it on a
> GitHub runner and hands you the APK. Set `ANDROID_KEYSTORE_BASE64`,
> `ANDROID_KEYSTORE_PASSWORD` and `ANDROID_KEY_ALIAS` as repository secrets and
> it signs with the key below; leave them unset and you get a debug build you
> can install today.

```bash
export ZVKY_KEYSTORE=/secure/path/zvky-release.jks
export ZVKY_KEYSTORE_PASS='…'
export ZVKY_KEY_ALIAS=zvky          # optional, defaults to zvky
bash scripts/build-android.sh
```

It syncs, runs `gradle assembleRelease` with the signing injected, writes
`dist-mobile/zvky.apk`, and prints the size and the SHA-256.

### Distributing

Upload `zvky.apk` to the server's `dist-mobile/` directory and send people the
install link from **Settings → Mobile Apps**. The install page carries the
"Install unknown apps" instructions, which is the one step that confuses people:
Android blocks the install until the browser doing the downloading is allowed to
install apps, and the message it shows does not say that clearly.

Play Protect will also say it does not recognise the app. It says that about
every app not from the Play Store. **Install anyway** is the correct answer.

### Updating

Raise `version` in `mobile/package.json`, rebuild, replace `zvky.apk` on the
server. People install over the top; the session survives.

Because the app loads the site live, **ordinary feature work needs none of
this.** Rebuild only when the shell itself changes: a new plugin, a new
permission, the icon, or the server URL.

---

## 5. Building and distributing iOS

### Prerequisites that are not code

These are the studio's to arrange and cannot be done from here:

- **An Apple Developer Program membership — $99/year.** Ad Hoc distribution is
  a paid-account feature. Let it lapse and the apps stop installing.
- **The UDID of every iPhone and iPad that will run the app.** Ad Hoc builds run
  **only** on devices named inside the build. The limit is **100 devices per
  device type per year** — for a team of 10–60 that is comfortable, but the
  count resets only once a year, at membership renewal.
- **A Mac with Xcode.** Apple will not sign an app anywhere else.

### Collecting UDIDs

Easiest, and what to send people: **Settings → General → About**, tap and hold
the **Serial Number** row, choose **Copy UDID**, paste it into a message.

(Plugging into a Mac and reading it from Finder also works, and so does
Xcode → Window → Devices and Simulators.)

### Registering devices and making the profile

1. Developer portal → **Devices** → **+** for each UDID.
2. **Identifiers** → register **`com.zvky.forge`**, with **Push Notifications**
   enabled.
3. **Profiles** → **+** → **Ad Hoc** → pick the App ID → pick the distribution
   certificate → **tick every device** → download the `.mobileprovision`.

### Exporting the .ipa

> Or let a runner do it: Actions → **Mobile — iOS IPA (Ad Hoc)**, once the five
> Apple secrets are set. It archives, exports and writes the manifest, and both
> files come back as artifacts. The portal work above still has to happen first —
> no workflow can create an Apple certificate for you.

```bash
cd mobile
npm run sync
npm run open:ios          # opens Xcode
```

In Xcode:

1. **Signing & Capabilities** → team selected, **Push Notifications** capability
   added, provisioning profile set to the Ad Hoc one.
2. Target device **Any iOS Device (arm64)**.
3. **Product → Archive**.
4. In the Organizer: **Distribute App → Ad Hoc → Export**.
5. Rename the exported file **`zvky.ipa`**.

### The manifest

iOS will not install an `.ipa` from a link. It installs from a **manifest** — a
plist naming the `.ipa`'s absolute URL — and the install link points at the
manifest:

```
itms-services://?action=download-manifest&url=https://…/manifest.plist
```

Generate it with the token directory from Settings → Mobile Apps:

```bash
node scripts/make-ios-manifest.js \
  --base https://zvkydesign.com/m/YOUR_TOKEN \
  --version 1.0.0
```

It writes `dist-mobile/manifest.plist` and prints the install link.

**`--version` must match the version inside the `.ipa`.** If they disagree the
install dies at "Unable to Install" and says nothing about why.

### Distributing

Upload `zvky.ipa` and `manifest.plist` to `dist-mobile/` and send the install
link from Settings → Mobile Apps. iPhone users **must open it in Safari** —
Chrome and in-app browsers on iOS cannot start an install.

First launch shows "Untrusted Developer". **Settings → General → VPN & Device
Management → [the studio's profile] → Trust.** Worth putting in the message you
send with the link.

---

## 6. Adding a new employee's iPhone

Six months from now, somebody joins. Their phone is not in the current build and
**the existing `.ipa` will not install on it** — it will fail with "Unable to
Install" and no explanation.

1. Ask them for their UDID (Settings → General → About → hold Serial Number →
   Copy UDID).
2. Developer portal → **Devices** → **+** → add it.
3. **Profiles** → edit the Ad Hoc profile → tick the new device → **Save** →
   download the regenerated `.mobileprovision`.
4. On the Mac: `npm run sync`, `npm run open:ios`, refresh the profile in
   Signing & Capabilities, **Archive**, **Distribute → Ad Hoc → Export**.
5. Replace `zvky.ipa` on the server and regenerate `manifest.plist` if the
   version changed.
6. Send them the same install link.

**Everybody else keeps what they have.** Adding a device does not invalidate
existing installs — they are only affected at the annual expiry below.

Android has no equivalent step. Any Android phone can install the APK.

---

## 7. The annual iOS rebuild (not optional)

> **Ad Hoc provisioning profiles expire one year after they are created.**
> When the profile expires, **the app stops launching on every device** — not
> just new ones. It shows a message about the developer no longer being trusted
> and refuses to open. There is no warning and no grace period.

**Put a calendar reminder eleven months out, with this file linked from it.**
The fix is not difficult; being surprised by it on a Monday morning is.

The rebuild:

1. Confirm the Apple Developer membership is current (renew if it is close).
2. Developer portal → **Profiles** → regenerate the Ad Hoc profile with every
   current device ticked. Take the chance to drop devices that have left.
3. `npm run sync`, `npm run open:ios`, refresh the profile, **Archive**,
   **Distribute → Ad Hoc → Export**.
4. Bump the version, regenerate the manifest with the new `--version`, upload
   both files, send the link round.

Android does not expire. Its keystore `-validity 10000` is about 27 years, and
an installed APK keeps working regardless.

---

## 8. Hosting the files, and the install links

The application serves all of this itself. Nothing else needs to be set up.

### The directory

Drop the built files here, under exactly these names:

```
dist-mobile/
  zvky.apk           the Android build
  zvky.ipa           the iOS build
  manifest.plist     generated by scripts/make-ios-manifest.js
  .dist-token        generated on first use — do not delete (see below)
```

`MOBILE_DIST_DIR` moves that directory if the deployment needs it elsewhere.

### The links

Everything is served under one unguessable path:

```
https://zvkydesign.com/m/<token>/                 the install page
https://zvkydesign.com/m/<token>/zvky.apk         the Android build
https://zvkydesign.com/m/<token>/zvky.ipa         the iOS build
https://zvkydesign.com/m/<token>/manifest.plist   the iOS manifest

itms-services://?action=download-manifest&url=https://zvkydesign.com/m/<token>/manifest.plist
```

The token is shown in **Settings → Mobile Apps**, along with the full install
page link, a Copy button, and what is currently on the server.

### Why those paths are not behind the sign-in

They cannot be. Tapping an `itms-services://` link hands the manifest URL to a
**system daemon**, and that daemon fetches the manifest and the `.ipa` itself —
with none of Safari's cookies, storage or headers. An authenticated path gets
the sign-in page instead of a plist, and the install fails with "Cannot connect
to zvkydesign.com" and nothing else.

So the path carries a secret instead: 24 random bytes, over HTTPS, compared in
constant time. Stated plainly:

> **Anybody who has the link can download the builds.** The link *is* the
> credential.

What that does and does not expose: the builds are **shells**. They contain no
studio data, no database and no credentials — they load the web application over
the network, and everything inside is still behind the same sign-in as the
website. A stranger with the link gets an app that shows them a login screen.
Keep the link inside the studio anyway, and if it ever leaks:

```bash
MOBILE_DIST_TOKEN=<a new long random string>
```

in the environment, then restart. The old link stops working immediately, and
the new one is in Settings → Mobile Apps.

### Two settings the deployment must get right

```bash
MOBILE_DIST_BASE=https://zvkydesign.com   # the public https origin, exactly
```

Without it the server guesses from the incoming request, which bakes whatever
the phone happened to type into the manifest — and the manifest's URL is fetched
by that system daemon, so a wrong one fails silently. Settings → Mobile Apps
warns when it is unset or not https.

**The IP allowlist applies here too.** If `IP_ALLOWLIST_MODE=enforce` and the
office network is the only allowed range, a phone on mobile data cannot reach
the install page — or the app. Worth checking before telling sixty people the
link is broken.

---

## 9. When something does not work

| Symptom | Cause |
|---|---|
| iOS: **"Cannot connect to <host>"** | The manifest or the `.ipa` is not reachable over **https** with a certificate iOS trusts, or the URL inside the manifest is wrong. Open the manifest URL in a desktop browser — you should get XML, not a login page. |
| iOS: **"Unable to Install"** | Almost always the device is not in the build's provisioning profile → §6. Otherwise `--version` does not match the version inside the `.ipa`. |
| iOS: nothing happens on tapping Install | Not Safari. Chrome and in-app browsers on iOS cannot start an install. |
| iOS: **"Untrusted Developer"** on first launch | Normal. Settings → General → VPN & Device Management → Trust. |
| iOS: the app stops launching for **everyone**, at once | The Ad Hoc profile expired → §7. |
| Android: the install is blocked | "Install unknown apps" is not enabled for the browser. The install page walks through it. |
| Android: Play Protect warns | Expected for any app not from the Play Store. Install anyway. |
| Android: no push token | `google-services.json` is missing from `android/app/`. |
| Either: the app opens on the offline screen | The phone cannot reach `server.url`. Check it in a phone browser first, then check the IP allowlist. |
| Either: push never arrives | Settings → Mobile Apps shows whether keys are configured; Profile shows whether *you* have a device registered and are opted in. `POST /api/push/test` says which of the two is wrong. |
| Push stopped for one person | They reinstalled or were signed out; the token changed. Opening the app re-registers it. Dead tokens are dropped automatically after the service reports them gone. |
