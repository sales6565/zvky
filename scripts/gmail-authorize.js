#!/usr/bin/env node
/* ONE-TIME: turn a Google OAuth client into a refresh token for one mailbox.
 *
 *     node scripts/gmail-authorize.js
 *
 * It prints a URL, you open it IN A NORMAL BROWSER and sign in as the sender
 * mailbox, Google gives you back a code, you paste it here, and this prints the
 * refresh token to store as GMAIL_REFRESH_TOKEN.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A TERMINAL SCRIPT AND NOT A BUTTON IN THE APPLICATION.
 *
 * Google blocks OAuth sign-in inside embedded web views, and it enforces it —
 * "disallowed_useragent". The desktop application is Electron, which is an
 * embedded web view, so a "Connect Gmail" button that loaded accounts.google.com
 * inside the app window would be refused by Google and would look like our bug.
 * There is no way around that and no reason to want one: this is done once in
 * the life of a deployment.
 *
 * ---------------------------------------------------------------------------
 * NOTHING IS WRITTEN ANYWHERE. The token is printed to the terminal and that is
 * all: no file, no database row, no log. Whoever runs this copies it into the
 * host's environment variables. A script that helpfully wrote it to .env would
 * be a script that puts a credential in the working directory of a repository
 * that has had a secret committed before.
 */
const readline = require('node:readline');

const CLIENT_ID = process.env.GMAIL_CLIENT_ID || '';
const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET || '';
/* The out-of-band redirect. Google's own "Desktop app" client type offers it,
   and it is what lets a script with no web server receive the code: Google shows
   it on screen and the person pastes it. localhost would need a listener and a
   free port on a machine that may be a shell over SSH. */
const REDIRECT = process.env.GMAIL_REDIRECT_URI || 'urn:ietf:wg:oauth:2.0:oob';
const SCOPE = 'https://www.googleapis.com/auth/gmail.send';
const TOKEN_URL = process.env.GMAIL_TOKEN_URL || 'https://oauth2.googleapis.com/token';
const AUTH_URL = process.env.GMAIL_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth';

const say = (s = '') => process.stdout.write(`${s}\n`);

function consentUrl() {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT,
    response_type: 'code',
    scope: SCOPE,
    /* offline IS WHAT PRODUCES A REFRESH TOKEN AT ALL. Without it Google
       returns an access token that dies in an hour and nothing to renew it. */
    access_type: 'offline',
    /* And consent FORCES the refresh token to be re-issued. Google only sends
       one on the FIRST authorisation of a client; re-running this script without
       it returns an access token and no refresh token, which is the single most
       confusing thing about this flow. */
    prompt: 'consent',
  });
  return `${AUTH_URL}?${params.toString()}`;
}

async function exchange(code) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT,
      grant_type: 'authorization_code',
    }).toString(),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(payload.error_description || payload.error || `HTTP ${res.status}`);
    err.code = payload.error;
    throw err;
  }
  return payload;
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => { rl.close(); resolve(answer); }));
}

(async () => {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    say('Set the client first, in this shell only — not in a file:');
    say('');
    say('  export GMAIL_CLIENT_ID="…apps.googleusercontent.com"');
    say('  export GMAIL_CLIENT_SECRET="…"');
    say('  node scripts/gmail-authorize.js');
    say('');
    say('Both come from Google Cloud → APIs & Services → Credentials → the OAuth');
    say('client you created for this. See the README section "Sending email through Gmail".');
    process.exit(1);
  }

  say('');
  say('1. Open this URL in a NORMAL BROWSER — Chrome, Safari, Edge. Not inside the');
  say('   ZVKY FORGE desktop app: Google refuses to sign in inside an embedded');
  say('   browser and will say "disallowed_useragent".');
  say('');
  say(consentUrl());
  say('');
  say('2. Sign in as the SENDER MAILBOX itself (the address mail should come from),');
  say('   not as your own account. Whatever you sign in as is what Gmail will put');
  say('   in the From line, whatever the application is configured to say.');
  say('');
  say('3. Approve the one permission it asks for — "Send email on your behalf".');
  say('   It cannot read the mailbox; the scope is gmail.send alone.');
  say('');

  const code = (await ask('4. Paste the code Google gave you here: ')).trim();
  if (!code) { say('No code; nothing done.'); process.exit(1); }

  let token;
  try {
    token = await exchange(code);
  } catch (err) {
    say('');
    say(`Google refused that code: ${err.message}`);
    if (err.code === 'invalid_grant') {
      say('');
      say('invalid_grant here almost always means the code was already used or has');
      say('expired — they are good for a few minutes and once only. Run the script');
      say('again and paste a fresh one.');
    }
    process.exit(1);
  }

  if (!token.refresh_token) {
    say('');
    say('Google returned an access token but NO refresh token.');
    say('');
    say('That happens when this client has been authorised by this account before:');
    say('Google issues the refresh token once. Either revoke this app at');
    say('https://myaccount.google.com/permissions and run this again, or use the');
    say('refresh token you were given the first time — it does not change.');
    process.exit(1);
  }

  say('');
  say('Done. Set this as an environment variable on the server — in cPanel that is');
  say('Setup Node.js App → Environment variables. Do not put it in a file in the');
  say('repository.');
  say('');
  say(`GMAIL_REFRESH_TOKEN=${token.refresh_token}`);
  say('');
  say('Then set, if you have not already:');
  say('');
  say('  EMAIL_TRANSPORT=gmail_api');
  say('  GMAIL_SENDER=sales@zvky.com          # the mailbox you just signed in as');
  say('  GMAIL_SENDER_NAME=ZVKY FORGE         # the display name on the From line');
  say('  GMAIL_REPLY_TO=                      # optional, if replies go elsewhere');
  say('');
  say('Restart the application, then open Settings → Email and press Send test email.');
  say('');
  /* A reminder rather than an action, because this script cannot know which of
     the two cases the domain is. Both are in the README. */
  say('If zvky.com is NOT a Google Workspace domain, read the README note about an');
  say('External app in Testing: its refresh tokens expire after SEVEN DAYS until the');
  say('app is published.');
  process.exit(0);
})().catch((err) => { say(`Failed: ${err.message}`); process.exit(1); });
