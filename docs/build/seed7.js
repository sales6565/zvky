/* Conversations for the chat captures.
 *
 * Two of them, because the manual shows two things: a one-to-one thread as the
 * artist sees it, and a group's member list as its owner sees it. Written here
 * rather than inside shoot.js so that shoot.js only ever photographs — the
 * split the other seeds already follow.
 *
 * No attachment is sent. A chat file is deleted eight hours after it is
 * uploaded, so a screenshot of one would be a picture of something the reader
 * cannot reproduce by the time they read it; the expiry placeholder is
 * described in the manual instead. */
const BASE = 'http://127.0.0.1:4415/api';
const PASS = 'Zvky-Demo-1!';

const api = async (p, o = {}) => {
  const h = { 'Content-Type': 'application/json' };
  if (o.token) h.Authorization = 'Bearer ' + o.token;
  const r = await fetch(BASE + p, {
    method: o.method || 'GET', headers: h,
    body: o.body ? JSON.stringify(o.body) : undefined,
  });
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch { j = t; }
  if (r.status >= 400 && !o.quiet) console.log('  !', o.method || 'GET', p, r.status, JSON.stringify(j).slice(0, 160));
  return { status: r.status, body: j };
};

(async () => {
  const login = async (e) => (await api('/auth/login', { method: 'POST', body: { email: e, password: PASS } })).body.token;
  const root = await login('admin@zvky.test');
  const users = (await api('/users?limit=200', { token: root })).body;
  const list = Array.isArray(users) ? users : (users.users || []);
  const by = (email) => list.find((u) => u.email === email);

  const artist = by('artist@zvky.test');
  const lead = by('lead@zvky.test');
  const cd = by('cd@zvky.test') || by('director@zvky.test');
  if (!artist || !lead) throw new Error('demo artist or lead missing — run the earlier seeds first');

  const artistToken = await login('artist@zvky.test');
  const leadToken = await login('lead@zvky.test');

  // --- the one-to-one, opened by the lead so the artist has something to read
  const direct = await api('/chat/direct', { token: leadToken, method: 'POST', body: { userId: artist.id } });
  const dm = direct.body.conversationId;
  const say = async (token, body) => api(`/chat/${dm}/messages`, { token, method: 'POST', body: { body } });
  const already = (await api(`/chat/${dm}/messages`, { token: leadToken })).body.messages || [];
  if (!already.length) {
    await say(leadToken, 'Ridge Warden — is the silhouette reading at thumbnail size?');
    await say(artistToken, 'Mostly. The shoulder line goes soft under 64px, so I am widening the pauldron.');
    await say(leadToken, 'Good. Keep it in the same language as the Lantern Keeper and I am happy.');
    await say(artistToken, 'Will do. I will put it up for review this afternoon.');
  }

  // --- the group, owned by the lead
  const mine = (await api('/chat', { token: leadToken })).body.conversations || [];
  let group = mine.find((c) => c.kind === 'group' && c.title === 'Nightgarden — characters');
  if (!group) {
    const members = [artist.id, ...(cd ? [cd.id] : [])];
    const made = await api('/chat/groups', {
      token: leadToken, method: 'POST',
      body: { title: 'Nightgarden — characters', memberIds: members },
    });
    if (made.status >= 400) throw new Error('could not create the demo group');
    group = { id: made.body.conversationId };
    await api(`/chat/${group.id}/messages`, { token: leadToken, method: 'POST',
      body: { body: 'Using this for the character pass rather than messaging each of you separately.' } });
  }

  console.log('chat: one conversation and one group ready for the captures.');
})().catch((e) => { console.error(e); process.exit(1); });
