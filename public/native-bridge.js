/* The native half of the mobile apps — and it lives HERE, in the web app.
 *
 * WHY THIS FILE IS SERVED RATHER THAN BUNDLED. The iOS and Android shells load
 * this site live: the whole point of the exercise is that a web deploy reaches
 * every phone without rebuilding anything. If the camera wiring, the back
 * button and the push registration were compiled into the shells, they would be
 * the one part of the app that could only be changed by rebuilding an .ipa,
 * collecting UDIDs and asking sixty people to reinstall. Keeping them here
 * means the NATIVE BEHAVIOUR updates on the next app open too.
 *
 * It is inert in a desktop browser. Everything below is behind a check for the
 * Capacitor bridge, which only exists inside the shells, so this file changes
 * nothing for anybody on a laptop.
 *
 * Plugins are reached through window.Capacitor.Plugins rather than by importing
 * @capacitor/... packages: there is no bundler in this project, and the shells
 * register every plugin they ship onto that object at startup.
 */
(function () {
  const Cap = window.Capacitor;
  if (!Cap || !Cap.isNativePlatform || !Cap.isNativePlatform()) return;

  const P = Cap.Plugins || {};
  const platform = Cap.getPlatform ? Cap.getPlatform() : 'web';
  const isIOS = platform === 'ios';
  document.documentElement.classList.add('is-native', 'is-' + platform);

  const log = function () { try { console.log.apply(console, ['[native]'].concat([].slice.call(arguments))); } catch (e) { /* nothing */ } };

  // --- 1. iOS safe areas ----------------------------------------------------
  //
  // The notch and the home indicator. The page uses a fixed header and a
  // bottom-left chat launcher, and without this the first sits under the clock
  // and the second under the home bar.
  //
  // env(safe-area-inset-*) reports zero unless the viewport meta carries
  // viewport-fit=cover, which the shell sets. Published as variables so the
  // page's own rules can use them, and applied only under .is-native so the
  // desktop layout is untouched.
  function applySafeAreas() {
    const style = document.createElement('style');
    style.id = 'native-safe-areas';
    style.textContent = [
      ':root.is-native {',
      '  --safe-top: env(safe-area-inset-top, 0px);',
      '  --safe-bottom: env(safe-area-inset-bottom, 0px);',
      '  --safe-left: env(safe-area-inset-left, 0px);',
      '  --safe-right: env(safe-area-inset-right, 0px);',
      '}',
      ':root.is-native body { padding-top: var(--safe-top); }',
      ':root.is-native .chat-launcher { bottom: calc(18px + var(--safe-bottom)); }',
      ':root.is-native #toast { bottom: calc(24px + var(--safe-bottom)); }',
      ':root.is-native .modal { max-height: calc(100vh - var(--safe-top) - var(--safe-bottom)); }',
    ].join('\n');
    document.head.appendChild(style);
  }

  // --- 2. Android hardware back --------------------------------------------
  //
  // Left alone, the back button closes the app from anywhere — including from
  // a modal, which is the one place a person presses it expecting "close this".
  //
  // The order below is the order a person expects: dismiss what is on top, then
  // go back through the app's own history, and only leave when there is nothing
  // left. Leaving is CONFIRMED rather than immediate, because an accidental
  // exit in the middle of a submission is a lost submission.
  function wireBackButton() {
    if (!P.App || !P.App.addListener) return;
    P.App.addListener('backButton', function (ev) {
      const openLayer = document.querySelector(
        '.modal-wrap.show, .drawer.open, #chatPanel.open, .ip-panel.open'
      );
      if (openLayer) {
        const closer = openLayer.querySelector(
          '[id^="cancel"], .modal-actions .btn-ghost, .drawer-close, .chat-close'
        );
        if (closer) { closer.click(); return; }
        openLayer.classList.remove('show', 'open');
        return;
      }
      if ((ev && ev.canGoBack) || window.history.length > 1) { window.history.back(); return; }
      if (window.confirm('Close Zvky?') && P.App.exitApp) P.App.exitApp();
    });
  }

  // --- 3. The session, kept across restarts --------------------------------
  //
  // The token already lives in localStorage, and inside a WebView that is the
  // app's own sandboxed store — not readable by other apps. It is mirrored into
  // secure storage as well for one reason worth stating: iOS may evict a
  // WKWebView's local storage under disk pressure, and a person silently signed
  // out on a Monday morning is how an app gets uninstalled.
  //
  // Keychain on iOS, EncryptedSharedPreferences on Android. The mirror is only
  // ever READ when localStorage has nothing, so the web app stays the source of
  // truth and this can never overwrite a fresher session.
  const TOKEN_KEY = 'zvky_token';

  function restoreSession() {
    if (!P.Preferences) return Promise.resolve();
    if (localStorage.getItem(TOKEN_KEY)) return Promise.resolve();
    return P.Preferences.get({ key: TOKEN_KEY }).then(function (res) {
      if (res && res.value) {
        localStorage.setItem(TOKEN_KEY, res.value);
        log('session restored from secure storage');
      }
    }).catch(function (e) { log('restore failed', e && e.message); });
  }

  function mirrorSession() {
    if (!P.Preferences) return;
    /* localStorage fires no event in the tab that wrote it, so both writers are
       wrapped. Cheap, and it catches sign-in, sign-out and a token cleared by a
       401 without the page having to call anything. */
    const setItem = localStorage.setItem.bind(localStorage);
    const removeItem = localStorage.removeItem.bind(localStorage);
    localStorage.setItem = function (key, value) {
      setItem(key, value);
      if (key === TOKEN_KEY) P.Preferences.set({ key: key, value: value }).catch(function () {});
    };
    localStorage.removeItem = function (key) {
      removeItem(key);
      if (key === TOKEN_KEY) {
        P.Preferences.remove({ key: key }).catch(function () {});
        unregisterDevice();
      }
    };
    const existing = localStorage.getItem(TOKEN_KEY);
    if (existing) P.Preferences.set({ key: TOKEN_KEY, value: existing }).catch(function () {});
  }

  // --- 4. Push notifications ------------------------------------------------
  //
  // Registration only, and only once there is a session: a device token is
  // stored against a user, so asking before sign-in would have nobody to store
  // it against. The permission prompt is deferred for the same reason — a
  // prompt on the login screen is the one most people refuse.
  let pushToken = null;

  function setUpPush() {
    if (!P.PushNotifications) return;
    const session = localStorage.getItem(TOKEN_KEY);
    if (!session) return;

    /* Never raise a permission prompt this deployment cannot honour. */
    fetch('/api/push/config', { headers: { Authorization: 'Bearer ' + session } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (cfg) {
        if (!cfg || !cfg.configured) { log('push not configured on this deployment'); return; }
        return P.PushNotifications.checkPermissions().then(function (perm) {
          if (perm.receive === 'prompt' || perm.receive === 'prompt-with-rationale') {
            return P.PushNotifications.requestPermissions();
          }
          return perm;
        }).then(function (perm) {
          if (!perm || perm.receive !== 'granted') { log('push permission not granted'); return; }
          P.PushNotifications.addListener('registration', function (t) {
            pushToken = t.value;
            sendToken(t.value);
          });
          P.PushNotifications.addListener('registrationError', function (e) { log('registration error', e); });
          P.PushNotifications.addListener('pushNotificationActionPerformed', function (action) {
            openFromPush((action && action.notification && action.notification.data) || {});
          });
          return P.PushNotifications.register();
        });
      })
      .catch(function (e) { log('push setup failed', e && e.message); });
  }

  function sendToken(token) {
    const session = localStorage.getItem(TOKEN_KEY);
    if (!session) return;
    fetch('/api/push/devices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + session },
      body: JSON.stringify({ token: token, platform: isIOS ? 'ios' : 'android' }),
    }).catch(function () { /* a failed registration retries on the next app open */ });
  }

  function unregisterDevice() {
    if (!pushToken) return;
    const session = localStorage.getItem(TOKEN_KEY);
    /* Best effort and deliberately not awaited: the sign-out is already
       happening and must not wait on the network. */
    fetch('/api/push/devices/' + encodeURIComponent(pushToken), {
      method: 'DELETE',
      headers: session ? { Authorization: 'Bearer ' + session } : {},
    }).catch(function () {});
    pushToken = null;
  }

  /* Where a tapped notification lands. Deliberately small: it opens the right
     thing through the page's own entry points rather than reaching into
     internals that will move. */
  function openFromPush(data) {
    try {
      if (data.kind === 'chat' && typeof window.openChat === 'function') { window.openChat(); return; }
      if (data.assetId && typeof window.openDrawer === 'function') { window.openDrawer(data.assetId); return; }
      const tab = document.querySelector('button[data-tab="dashboard"]');
      if (tab) tab.click();
    } catch (e) { log('open from push failed', e && e.message); }
  }

  // --- 5. Camera and photo library -----------------------------------------
  //
  // The page's file inputs already work in a WebView. What they do NOT do on
  // iOS is offer the camera as a first-class choice, and they give no control
  // over size — a 12-megapixel photo through the asset upload is a slow upload
  // and a large row.
  //
  // So every image file input gets a native picker beside it, handing back a
  // resized JPEG through the input the page already listens to. The original
  // input is untouched, so the desktop path is unchanged and this is purely an
  // addition.
  const IMAGE_INPUT = 'input[type="file"][accept*="image"]';

  function pickImage(source) {
    if (!P.Camera) return Promise.resolve(null);
    return P.Camera.getPhoto({
      quality: 82,
      allowEditing: false,
      resultType: 'base64',
      source: source,
      width: 2048,
      correctOrientation: true,
    }).then(function (photo) {
      if (!photo || !photo.base64String) return null;
      const binary = atob(photo.base64String);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const raw = (photo.format || 'jpeg').toLowerCase();
      const ext = raw === 'jpg' ? 'jpg' : raw;
      const mime = 'image/' + (ext === 'jpg' ? 'jpeg' : ext);
      return new File([bytes], 'photo-' + Date.now() + '.' + ext, { type: mime });
    });
  }

  function attachTo(input) {
    if (input.dataset.nativePicker) return;
    input.dataset.nativePicker = '1';
    const bar = document.createElement('div');
    bar.className = 'native-pick';
    bar.innerHTML = '<button type="button" data-src="CAMERA">Take photo</button>'
      + '<button type="button" data-src="PHOTOS">Choose photo</button>';
    input.insertAdjacentElement('afterend', bar);

    bar.addEventListener('click', function (e) {
      const btn = e.target.closest('button[data-src]');
      if (!btn) return;
      e.preventDefault();
      pickImage(btn.dataset.src).then(function (file) {
        if (!file) return;
        /* Handed to the page through the input it already listens to, so every
           existing validation, preview and upload path runs unchanged. */
        const dt = new DataTransfer();
        dt.items.add(file);
        input.files = dt.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }).catch(function (err) {
        if (err && /cancel/i.test(err.message || '')) return;   // they backed out
        log('picker failed', err && err.message);
      });
    });
  }

  function wireCamera() {
    if (!P.Camera) return;
    const style = document.createElement('style');
    style.textContent = '.native-pick { display:flex; gap:8px; margin-top:8px; }'
      + '.native-pick button { flex:1; padding:10px; font-size:13px; border-radius:6px;'
      + ' border:1px solid var(--border, #444); background:transparent; color:inherit; }';
    document.head.appendChild(style);

    const scan = function () {
      const list = document.querySelectorAll(IMAGE_INPUT);
      for (let i = 0; i < list.length; i++) attachTo(list[i]);
    };
    scan();
    /* The page paints its panels on demand, so inputs appear long after load. */
    new MutationObserver(scan).observe(document.body, { childList: true, subtree: true });
  }

  // --- 6. Pull to refresh ---------------------------------------------------
  //
  // Written here rather than taken from a plugin because the page is one long
  // scrolling document: what should happen at the top of an overscroll is a
  // RE-RENDER, not a WebView reload. A reload would throw away the open tab,
  // the filters and any half-typed form.
  function wirePullToRefresh() {
    let startY = 0;
    let pulling = false;
    const bar = document.createElement('div');
    bar.className = 'native-ptr';
    bar.textContent = 'Pull to refresh';
    document.body.appendChild(bar);

    const style = document.createElement('style');
    style.textContent = '.native-ptr { position:fixed; top:var(--safe-top,0px); left:0; right:0;'
      + ' text-align:center; font-size:12px; padding:8px; opacity:0; pointer-events:none;'
      + ' transform:translateY(-8px); transition:opacity .15s, transform .15s;'
      + ' background:var(--surface,#1b1b1f); color:var(--ink-muted,#aaa); z-index:9999; }'
      + '.native-ptr.on { opacity:1; transform:translateY(0); }';
    document.head.appendChild(style);

    const scroller = document.scrollingElement || document.documentElement;
    window.addEventListener('touchstart', function (e) {
      /* Only from a genuine top-of-page, so this never fights a scrollable
         panel the finger happens to be on. */
      pulling = scroller.scrollTop <= 0;
      startY = e.touches[0].clientY;
    }, { passive: true });

    window.addEventListener('touchmove', function (e) {
      if (!pulling) return;
      bar.classList.toggle('on', e.touches[0].clientY - startY > 40);
    }, { passive: true });

    window.addEventListener('touchend', function () {
      if (!pulling || !bar.classList.contains('on')) { bar.classList.remove('on'); return; }
      bar.textContent = 'Refreshing…';
      Promise.resolve()
        .then(function () {
          return typeof window.render === 'function' ? window.render() : window.location.reload();
        })
        .catch(function () { window.location.reload(); })
        .then(function () {
          setTimeout(function () {
            bar.classList.remove('on');
            bar.textContent = 'Pull to refresh';
          }, 400);
        });
    }, { passive: true });
  }

  // --- 7. Coming back from the background ----------------------------------
  //
  // A phone out of a pocket after an hour is showing an hour-old screen.
  // Repaint on resume, and re-send the push token: iOS reissues one after a
  // restore from backup, and a stale token is a silent phone.
  function wireResume() {
    if (!P.App || !P.App.addListener) return;
    P.App.addListener('appStateChange', function (state) {
      if (!state || !state.isActive) return;
      if (typeof window.render === 'function') { try { window.render(); } catch (e) { /* ignore */ } }
      if (pushToken) sendToken(pushToken);
    });
  }

  // --- start ----------------------------------------------------------------
  function start() {
    applySafeAreas();
    restoreSession().then(function () {
      mirrorSession();
      wireBackButton();
      wireCamera();
      wirePullToRefresh();
      wireResume();
      /* After the page has had a chance to sign in — push registration needs a
         session, and on a cold start the token appears a moment later. */
      setTimeout(setUpPush, 2500);
      /* And again on sign-in, which is when most people first have one. */
      window.addEventListener('zvky:signed-in', function () { setUpPush(); });
      log('bridge ready on', platform);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
