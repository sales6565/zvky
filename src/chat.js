// Talking to each other.
//
// Two shapes of conversation and one table for both. A DIRECT conversation is
// between exactly two people and is found rather than created — see pairKey()
// below. A GROUP has a name, an owner and up to thirty people in it.
//
// WHAT IS NOT HERE, deliberately: any function that reads a conversation the
// caller is not in. Every read below takes a userId and joins chat_members on
// it, so "am I allowed to see this" is not a check a route can forget to make —
// there is no query here that can answer with somebody else's messages. The
// route layer explains why that is a product decision rather than an oversight.
//
// TRANSPORT. Messages are polled for, not pushed. The reasoning is recorded in
// src/routes/notifications.js and applies here with more force: this app runs
// behind hosting that may or may not carry a WebSocket, and more importantly it
// runs as more than one Node worker in production (see src/reference-data.js),
// where an event pushed from the worker holding one browser cannot reach a
// browser held by another without a shared bus this deployment does not have.
// Polling is correct under any number of workers. `seq` below is what makes it
// cheap and what makes it correct.

const { v4: uuid } = require('uuid');
const files = require('./chat-files');
const rolePermissions = require('./role-permissions');
const mentions = require('./chat-mentions');

/* Thirty people in a group, the owner included.
 *
 * Including the owner rather than beside them: "a group of thirty" is thirty
 * people who can read it, and a cap that let the creator sit outside it would
 * make the real limit thirty-one for no reason anybody could explain. */
/* The group size cap is a SETTING now, not a number in this file.
 *
 * It was `const MAX_GROUP_MEMBERS = 30` — enforced in the two places below,
 * published to the browser in two more, and quoted in a permission's
 * description. Thirty was a decision somebody made once when the studio was
 * smaller, and it had no way to change short of a deploy.
 *
 * This name is kept, and points at the module's DEFAULT, so that anything still
 * reading it gets the number the constant always held rather than undefined.
 * Nothing in this file enforces against it any more: every check below asks
 * chatSettings, which reads the live row. */
const chatSettings = require('./chat-settings');

const MAX_GROUP_MEMBERS = chatSettings.DEFAULT_MAX_GROUP_MEMBERS;
const MAX_BODY = 4000;
const MAX_TITLE = 120;

const KINDS = { direct: 'direct', group: 'group' };

const unavailable = (err) => err && (err.code === 'ER_NO_SUCH_TABLE' || /doesn't exist/i.test(err.message || ''));

/* The identity of a one-to-one conversation.
 *
 * Sorted, so the pair has one key whichever end asks, and UNIQUE in the schema
 * so two people opening each other at the same moment cannot end up in two
 * different rooms talking past each other. That race is not exotic — it is what
 * happens when two people react to the same thing at once — and it fails
 * silently, which is why it is prevented in the database rather than checked
 * for here. */
function pairKey(a, b) {
  return [String(a), String(b)].sort().join('|');
}

const trimmed = (v, max) => String(v == null ? '' : v).trim().slice(0, max);

/* HOW LONG A MESSAGE IS, counted the way a person would count it.
 *
 * NOT .length, which counts UTF-16 code units: every emoji outside the basic
 * plane is two of them, so a message of 2001 emoji "is" 4002 characters, and a
 * family emoji built from four people and three joiners is eleven. Spreading
 * the string counts CODE POINTS, which is the nearest thing to what somebody
 * typing believes they have typed.
 *
 * (Grapheme clusters would be nearer still — a family emoji is one thing on
 * screen — but Intl.Segmenter is the only correct way to find them and the
 * limit is a storage limit, not a typography one. Code points are what the
 * column holds and what the page can count identically without shipping a
 * table.) */
const codePoints = (v) => [...String(v == null ? '' : v)].length;

// ---------------------------------------------------------------- membership

/* Is this person in this conversation? The one authorisation question chat
   has, asked in one place so every route asks it the same way. */
async function membership(db, conversationId, userId) {
  const { rows } = await db.query(
    `SELECT m.conversation_id AS conversationId, m.user_id AS userId, m.is_owner AS isOwner,
            m.last_read_seq AS lastReadSeq, c.kind, c.title, c.created_by AS createdBy
       FROM chat_members m
       JOIN chat_conversations c ON c.id = m.conversation_id
      WHERE m.conversation_id = $1 AND m.user_id = $2`,
    [conversationId, userId]
  );
  if (!rows.length) return null;
  const r = rows[0];
  return { ...r, isOwner: Boolean(Number(r.isOwner)), lastReadSeq: Number(r.lastReadSeq) || 0 };
}

async function memberCount(db, conversationId) {
  const { rows } = await db.query(
    'SELECT COUNT(*) AS n FROM chat_members WHERE conversation_id = $1',
    [conversationId]
  );
  return Number(rows[0].n) || 0;
}

async function membersOf(db, conversationIds) {
  const list = (Array.isArray(conversationIds) ? conversationIds : [conversationIds]).filter(Boolean);
  if (!list.length) return [];
  const { rows } = await db.query(
    `SELECT m.conversation_id AS conversationId, m.user_id AS userId, m.is_owner AS isOwner,
            u.\`name\`, u.email, u.role, u.avatar_updated_at AS photoUpdatedAt
       FROM chat_members m
       JOIN users u ON u.id = m.user_id
      WHERE m.conversation_id IN ($1)
      ORDER BY m.is_owner DESC, m.seq ASC`,
    [list]
  );
  return rows.map((r) => ({
    conversationId: r.conversationId,
    id: r.userId,
    name: r.name,
    email: r.email,
    role: r.role,
    photoUpdatedAt: r.photoUpdatedAt || null,
    isOwner: Boolean(Number(r.isOwner)),
  }));
}

// ------------------------------------------------------------------ shielding

/* Whose inbox is shut, and who may knock anyway.
 *
 * Asked of the PERMISSION TABLE, never of a role name. The two designations the
 * studio named are a seeded default in defaultsFor(), and a Super Admin can
 * shield a third or unshield one of these from Settings without this file
 * changing. See the note on chat.open_inbox in src/permission-catalog.js for
 * why the key is phrased as "open" rather than "protected".
 *
 * One query for a list of people rather than one per person: the people picker
 * asks about sixty of them at once, and sixty round trips to answer one
 * question is how a dropdown becomes slow.
 */
async function shieldedAmong(db, userIds) {
  const list = [...new Set((Array.isArray(userIds) ? userIds : [userIds]).map(String).filter(Boolean))];
  if (!list.length) return new Set();
  const { rows } = await db.query('SELECT id, role FROM users WHERE id IN ($1)', [list]);
  const byRole = new Map();
  const shielded = new Set();
  for (const row of rows) {
    if (!byRole.has(row.role)) {
      // eslint-disable-next-line no-await-in-loop
      byRole.set(row.role, await rolePermissions.effectiveFor(db, row.role));
    }
    if (!byRole.get(row.role).has('chat.open_inbox')) shielded.add(String(row.id));
  }
  return shielded;
}

/* Has the shielded person spoken in this conversation?
 *
 * The one thing that reopens it. Without this the shield would make their own
 * messages unanswerable: the studio asked that they still message anybody they
 * like, and a message nobody may reply to is not a message. So the rule is the
 * ordinary one for a shielded inbox anywhere — you may write to them if they
 * have written to you.
 *
 * It also settles what happens to conversations that predate the shield: one
 * where they replied stays a conversation, and one where somebody wrote at them
 * and got no answer goes quiet, which is the case the shield exists for. */
async function hasSpokenIn(db, conversationId, userId) {
  const { rows } = await db.query(
    `SELECT 1 FROM chat_messages
      WHERE conversation_id = $1 AND sender_id = $2 AND kind = 'text' LIMIT 1`,
    [conversationId, userId]
  ).catch((err) => { if (unavailable(err)) return { rows: [] }; throw err; });
  return rows.length > 0;
}

/* May this person write into this conversation?
 *
 * Everybody in it may, unless somebody in it is shielded, they are not that
 * person, they do not hold the key, and the shielded party has not spoken.
 */
async function mayWriteTo(db, { conversationId, senderId, senderMay }) {
  const { rows } = await db.query(
    'SELECT user_id AS id FROM chat_members WHERE conversation_id = $1', [conversationId]);
  const others = rows.map((r) => String(r.id)).filter((id) => id !== String(senderId));
  if (!others.length) return { ok: true };
  if (senderMay) return { ok: true };

  const shielded = await shieldedAmong(db, others);
  if (!shielded.size) return { ok: true };
  for (const id of shielded) {
    // eslint-disable-next-line no-await-in-loop
    if (!(await hasSpokenIn(db, conversationId, id))) {
      return {
        ok: false,
        status: 403,
        error: shielded.size === 1 && others.length === 1
          ? 'This person is not available for direct messages.'
          : 'Somebody in this conversation is not available for messages.',
      };
    }
  }
  return { ok: true };
}

// ------------------------------------------------------------ system entries

/* A line in the transcript that nobody typed: who was added, who left, what the
 * group was renamed to.
 *
 * The sentence is stored as written rather than rebuilt on read, which is the
 * opposite of what src/notifications.js does and is deliberate. A notification
 * is a statement about the world as it is now, so it should track a rename. A
 * transcript is a record of what was true at the time — "Ava added Ben" stays
 * that sentence even if Ben's account is renamed afterwards, the same way
 * anything else said in the conversation does. */
async function systemLine(conn, conversationId, text) {
  const id = uuid();
  await conn.query(
    'INSERT INTO chat_messages (id, conversation_id, sender_id, kind, body) VALUES ($1,$2,NULL,$3,$4)',
    [id, conversationId, 'system', trimmed(text, MAX_BODY)]
  );
  return id;
}

// ------------------------------------------------------------------- opening

/* The one-to-one conversation between two people, made if it is not there yet.
 *
 * Returns the existing one whenever there is one, so "message Ben" always lands
 * in the same thread and history is never split. The ER_DUP_ENTRY branch is the
 * race described at pairKey(): somebody else won, so read what they made. */
async function openDirect(db, meId, otherId) {
  if (!otherId) return { ok: false, status: 400, error: 'Choose somebody to message.' };
  if (String(meId) === String(otherId)) {
    return { ok: false, status: 400, error: 'You cannot open a conversation with yourself.' };
  }
  const { rows: who } = await db.query('SELECT id FROM users WHERE id = $1', [otherId]);
  if (!who.length) return { ok: false, status: 404, error: 'That person is no longer in the studio.' };

  const key = pairKey(meId, otherId);
  const found = await db.query('SELECT id FROM chat_conversations WHERE pair_key = $1', [key]);
  if (found.rows.length) return { ok: true, conversationId: found.rows[0].id, created: false };

  const conn = await db.connect();
  try {
    await conn.query('BEGIN');
    const id = uuid();
    await conn.query(
      'INSERT INTO chat_conversations (id, kind, pair_key, created_by) VALUES ($1,$2,$3,$4)',
      [id, KINDS.direct, key, meId]
    );
    await conn.query(
      'INSERT INTO chat_members (conversation_id, user_id, is_owner) VALUES ($1,$2,0), ($1,$3,0)',
      [id, meId, otherId]
    );
    await conn.query('COMMIT');
    return { ok: true, conversationId: id, created: true };
  } catch (err) {
    await conn.query('ROLLBACK').catch(() => {});
    if (err.code === 'ER_DUP_ENTRY') {
      const again = await db.query('SELECT id FROM chat_conversations WHERE pair_key = $1', [key]);
      if (again.rows.length) return { ok: true, conversationId: again.rows[0].id, created: false };
    }
    throw err;
  } finally {
    conn.release();
  }
}

/* A group. The creator is its owner and its first member.
 *
 * Every id is checked against `users` before anything is written, because a
 * group half-created with two of its five people in it is worse than a refused
 * one — and the caller has no way to tell the difference afterwards. */
async function createGroup(db, { title, ownerId, memberIds = [], ownerName = '' }) {
  const name = trimmed(title, MAX_TITLE);
  if (!name) return { ok: false, status: 400, error: 'Give the group a name.', field: 'title' };

  // The owner is always in it, and a list that names them twice is a typo
  // rather than an error worth refusing.
  const wanted = [...new Set([String(ownerId), ...memberIds.map(String).filter(Boolean)])];
  /* Asked at request time, every time. The limit is a row somebody can change
     between one request and the next, and a value the browser was handed when
     the page loaded is exactly the value not to trust. */
  if (!chatSettings.roomFor(0, wanted.length)) {
    const limit = chatSettings.maxGroupMembers();
    return {
      ok: false,
      status: 400,
      error: `A group holds at most ${limit} people, counting you. That is ${wanted.length}.`,
      field: 'memberIds',
    };
  }
  const { rows: real } = await db.query('SELECT id FROM users WHERE id IN ($1)', [wanted]);
  if (real.length !== wanted.length) {
    return { ok: false, status: 400, error: 'Some of those people are no longer in the studio.', field: 'memberIds' };
  }

  const conn = await db.connect();
  try {
    await conn.query('BEGIN');
    const id = uuid();
    await conn.query(
      'INSERT INTO chat_conversations (id, kind, title, created_by) VALUES ($1,$2,$3,$4)',
      [id, KINDS.group, name, ownerId]
    );
    for (const userId of wanted) {
      await conn.query(
        'INSERT INTO chat_members (conversation_id, user_id, is_owner) VALUES ($1,$2,$3)',
        [id, userId, String(userId) === String(ownerId) ? 1 : 0]
      );
    }
    await systemLine(conn, id, `${ownerName || 'Someone'} created “${name}”.`);
    await conn.query('COMMIT');
    return { ok: true, conversationId: id, members: wanted.length };
  } catch (err) {
    await conn.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

// ---------------------------------------------------------- group management

async function rename(db, conversationId, actor, title) {
  const name = trimmed(title, MAX_TITLE);
  if (!name) return { ok: false, status: 400, error: 'Give the group a name.', field: 'title' };
  const conn = await db.connect();
  try {
    await conn.query('BEGIN');
    await conn.query('UPDATE chat_conversations SET title = $1 WHERE id = $2', [name, conversationId]);
    await systemLine(conn, conversationId, `${actor.name} renamed the group to “${name}”.`);
    await conn.query('COMMIT');
    return { ok: true, title: name };
  } catch (err) {
    await conn.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

/* Adding people, with the cap applied to the RESULT rather than to the request.
 *
 * Counted as "who would be in it afterwards", so adding five to a group of
 * twenty-eight is refused as a whole instead of adding two and dropping three
 * silently. Anybody already in the group is dropped from the request first, so
 * re-adding somebody is a no-op rather than a way to trip the cap. */
async function addMembers(db, conversationId, actor, userIds = []) {
  const wanted = [...new Set(userIds.map(String).filter(Boolean))];
  if (!wanted.length) return { ok: false, status: 400, error: 'Choose somebody to add.', field: 'userIds' };

  const { rows: already } = await db.query(
    'SELECT user_id AS id FROM chat_members WHERE conversation_id = $1',
    [conversationId]
  );
  const inIt = new Set(already.map((r) => String(r.id)));
  const fresh = wanted.filter((id) => !inIt.has(id));
  if (!fresh.length) return { ok: true, added: [], alreadyIn: wanted.length };

  /* A GROUP ALREADY OVER THE CAP IS NOT EMPTIED, it is closed.
   *
   * Lowering the limit blocks the next addition and does nothing else — nobody
   * is removed, no existing group is broken up, and everyone in one stays in
   * it. That is what this comparison says and it is worth saying out loud: it
   * asks whether the group would be over the cap AFTER the addition, so a group
   * of forty under a cap of thirty simply takes no more, and `room` below comes
   * out as zero rather than as a negative number somebody would have to read as
   * "remove ten people". */
  if (!chatSettings.roomFor(inIt.size, fresh.length)) {
    const limit = chatSettings.maxGroupMembers();
    const room = chatSettings.remaining(inIt.size);
    return {
      ok: false,
      status: 400,
      error: `A group holds at most ${limit} people. This one has ${inIt.size}, `
        + `so there is room for ${room} more, not ${fresh.length}.`,
      field: 'userIds',
      room,
    };
  }

  const { rows: real } = await db.query('SELECT id, `name` FROM users WHERE id IN ($1)', [fresh]);
  if (real.length !== fresh.length) {
    return { ok: false, status: 400, error: 'Some of those people are no longer in the studio.', field: 'userIds' };
  }

  const conn = await db.connect();
  try {
    await conn.query('BEGIN');
    for (const row of real) {
      await conn.query(
        'INSERT INTO chat_members (conversation_id, user_id, is_owner) VALUES ($1,$2,0)',
        [conversationId, row.id]
      );
    }
    await systemLine(conn, conversationId,
      `${actor.name} added ${real.map((r) => r.name).join(', ')}.`);
    await conn.query('COMMIT');
    return { ok: true, added: real.map((r) => r.id), alreadyIn: wanted.length - fresh.length };
  } catch (err) {
    await conn.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

async function removeMember(db, conversationId, actor, userId) {
  if (String(userId) === String(actor.id)) {
    return { ok: false, status: 400, error: 'Use Leave group to take yourself out.' };
  }
  const { rows } = await db.query(
    'SELECT m.is_owner AS isOwner, u.`name` FROM chat_members m JOIN users u ON u.id = m.user_id '
    + 'WHERE m.conversation_id = $1 AND m.user_id = $2',
    [conversationId, userId]
  );
  if (!rows.length) return { ok: false, status: 404, error: 'They are not in this group.' };
  if (Number(rows[0].isOwner)) return { ok: false, status: 400, error: 'The owner cannot be removed.' };

  const conn = await db.connect();
  try {
    await conn.query('BEGIN');
    await conn.query('DELETE FROM chat_members WHERE conversation_id = $1 AND user_id = $2',
      [conversationId, userId]);
    await systemLine(conn, conversationId, `${actor.name} removed ${rows[0].name}.`);
    await conn.query('COMMIT');
    return { ok: true, removed: userId };
  } catch (err) {
    await conn.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

/* Leaving, including the case nobody thinks about until it happens.
 *
 * If the OWNER leaves, the group does not become unmanageable: ownership moves
 * to whoever has been in it longest. And if the last person leaves, the
 * conversation is deleted outright — a group with no members is not a thing
 * anybody can reach again, so keeping it would only be keeping rows nobody can
 * ever read. Messages and attachment rows go with it through ON DELETE CASCADE;
 * the files themselves are cleaned by the sweep in src/chat-files.js, which
 * looks at the disk rather than at this table. */
async function leave(db, conversationId, actor) {
  const conn = await db.connect();
  try {
    await conn.query('BEGIN');
    const { rows: mine } = await conn.query(
      'SELECT is_owner AS isOwner FROM chat_members WHERE conversation_id = $1 AND user_id = $2',
      [conversationId, actor.id]
    );
    if (!mine.length) { await conn.query('ROLLBACK'); return { ok: false, status: 404, error: 'You are not in this group.' }; }

    await conn.query('DELETE FROM chat_members WHERE conversation_id = $1 AND user_id = $2',
      [conversationId, actor.id]);

    /* By seq, not joined_at: everybody added when the group was created shares
       one second, and DATETIME cannot order within one. See the schema note. */
    const { rows: left } = await conn.query(
      'SELECT user_id AS id FROM chat_members WHERE conversation_id = $1 ORDER BY seq ASC',
      [conversationId]
    );
    if (!left.length) {
      await conn.query('DELETE FROM chat_conversations WHERE id = $1', [conversationId]);
      await conn.query('COMMIT');
      return { ok: true, closed: true };
    }

    let handedTo = null;
    if (Number(mine[0].isOwner)) {
      handedTo = left[0].id;
      await conn.query('UPDATE chat_members SET is_owner = 1 WHERE conversation_id = $1 AND user_id = $2',
        [conversationId, handedTo]);
    }
    await systemLine(conn, conversationId, `${actor.name} left the group.`);
    await conn.query('COMMIT');
    return { ok: true, closed: false, ownerHandedTo: handedTo };
  } catch (err) {
    await conn.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

// -------------------------------------------------------------------- lists

/* Everything this person is in, with what they have not read.
 *
 * Unread excludes the caller's own messages: a thread does not become unread
 * because you posted in it, and counting your own would leave every
 * conversation permanently bold on whichever tab did not send it. */
async function listFor(db, userId) {
  const { rows } = await db.query(
    `SELECT c.id, c.kind, c.title, c.created_by AS createdBy, m.is_owner AS isOwner,
            m.last_read_seq AS lastReadSeq,
            (SELECT MAX(x.seq) FROM chat_messages x WHERE x.conversation_id = c.id) AS lastSeq,
            (SELECT COUNT(*) FROM chat_messages x
              WHERE x.conversation_id = c.id AND x.seq > m.last_read_seq
                AND (x.sender_id IS NULL OR x.sender_id <> $1)
                AND x.kind = 'text') AS unread
       FROM chat_members m
       JOIN chat_conversations c ON c.id = m.conversation_id
      WHERE m.user_id = $1`,
    [userId]
  ).catch((err) => { if (unavailable(err)) return { rows: [] }; throw err; });
  if (!rows.length) return [];

  const ids = rows.map((r) => r.id);
  const lastSeqs = rows.map((r) => Number(r.lastSeq)).filter((n) => Number.isFinite(n) && n > 0);
  const [members, lastMessages] = await Promise.all([
    membersOf(db, ids),
    lastSeqs.length
      ? db.query(
        `SELECT m.conversation_id AS conversationId, m.seq, m.kind, m.body, m.created_at AS createdAt,
                m.sender_id AS senderId, u.\`name\` AS senderName,
                (SELECT COUNT(*) FROM chat_attachments a WHERE a.message_id = m.id) AS attachmentCount
           FROM chat_messages m LEFT JOIN users u ON u.id = m.sender_id
          WHERE m.seq IN ($1)`, [lastSeqs]
      ).then((r) => r.rows)
      : Promise.resolve([]),
  ]);

  const byConv = new Map();
  for (const m of members) {
    if (!byConv.has(m.conversationId)) byConv.set(m.conversationId, []);
    byConv.get(m.conversationId).push(m);
  }
  const lastBySeq = new Map(lastMessages.map((m) => [Number(m.seq), m]));

  return rows.map((r) => {
    const people = byConv.get(r.id) || [];
    const other = r.kind === KINDS.direct ? people.find((p) => String(p.id) !== String(userId)) || null : null;
    const last = lastBySeq.get(Number(r.lastSeq)) || null;
    return {
      id: r.id,
      kind: r.kind,
      /* A direct conversation is named after the person you are talking to, so
         it reads the same to both ends without storing two titles. */
      title: r.kind === KINDS.direct ? (other ? other.name : 'Removed user') : r.title,
      isOwner: Boolean(Number(r.isOwner)),
      createdBy: r.createdBy || null,
      memberCount: people.length,
      members: r.kind === KINDS.group ? people.map(({ conversationId, ...p }) => p) : [],
      other: other ? { id: other.id, name: other.name, role: other.role, photoUpdatedAt: other.photoUpdatedAt } : null,
      unread: Number(r.unread) || 0,
      lastSeq: Number(r.lastSeq) || 0,
      lastReadSeq: Number(r.lastReadSeq) || 0,
      lastMessage: last
        ? {
          seq: Number(last.seq),
          kind: last.kind,
          senderId: last.senderId || null,
          senderName: last.senderName || null,
          preview: previewOf(last),
          createdAt: last.createdAt,
        }
        : null,
    };
  }).sort((a, b) => (b.lastSeq - a.lastSeq) || String(a.title).localeCompare(String(b.title)));
}

/* One line for the conversation list. An attachment with no words is still
   worth a line, or a photo sent on its own would look like an empty thread. */
function previewOf(row) {
  /* Mentions come out as plain @names here. The preview is one line of text
     under a conversation in the list, with no renderer behind it and no member
     list to resolve ids against — left alone it would read
     "@[Priya Nair](3f2a1b4c-…) can you look at this". */
  const body = mentions.toPlainText(String(row.body || '')).replace(/\s+/g, ' ').trim();
  if (body) return body.slice(0, 140);
  const n = Number(row.attachmentCount) || 0;
  if (n === 1) return 'Sent a file';
  if (n > 1) return `Sent ${n} files`;
  return '';
}

// ----------------------------------------------------------------- messages

const MESSAGE_SELECT = `SELECT m.id, m.seq, m.conversation_id AS conversationId, m.kind, m.body,
       m.created_at AS createdAt, m.sender_id AS senderId,
       m.reply_to_message_id AS replyToId,
       u.\`name\` AS senderName, u.avatar_updated_at AS senderPhotoUpdatedAt
  FROM chat_messages m
  LEFT JOIN users u ON u.id = m.sender_id`;

/* Attach the files to their messages, with expiry decided by the CLOCK and not
   by whether the sweep has run yet. See src/chat-files.js — this is the reason
   an attachment row outlives its file. */
async function withAttachments(db, messages) {
  if (!messages.length) return messages;
  const ids = messages.map((m) => m.id);
  const { rows } = await db.query(
    /* THE EXPIRY AS A COUNTDOWN, from the database's own clock — never the
       stored stamp. files.EXPIRY_SELECT is the one expression that reads it;
       parsing the column here would be the four-hour bug again, in a second
       place. The alias on the table is `a` because that is what the shared
       expression names. */
    `SELECT a.id, a.message_id AS messageId, a.file_name AS fileName, a.mime,
            a.byte_size AS byteSize, a.stored_name AS storedName,
            ${files.EXPIRY_SELECT}, a.deleted_at AS deletedAt
       FROM chat_attachments a WHERE a.message_id IN ($1)`,
    [ids]
  ).catch((err) => { if (unavailable(err)) return { rows: [] }; throw err; });

  const byMessage = new Map();
  for (const row of rows) {
    if (!byMessage.has(row.messageId)) byMessage.set(row.messageId, []);
    byMessage.get(row.messageId).push(files.shape(row));
  }
  return messages.map((m) => ({ ...m, attachments: byMessage.get(m.id) || [] }));
}

const shapeMessage = (r) => ({
  id: r.id,
  seq: Number(r.seq),
  conversationId: r.conversationId,
  kind: r.kind,
  body: r.body || '',
  senderId: r.senderId || null,
  senderName: r.senderName || (r.kind === 'system' ? null : 'Removed user'),
  senderPhotoUpdatedAt: r.senderPhotoUpdatedAt || null,
  createdAt: r.createdAt,
  attachments: [],
  replyToId: r.replyToId || null,
  /* Filled in by withQuotes(), from the TARGET as it is now. Null while the
     target is simply not loaded; see the note there. */
  quote: null,
});

/* THE QUOTED BLOCK ON A REPLY, read LIVE from the message it points at.
 *
 * NOTHING IS COPIED AT SEND TIME, and that is the whole design rather than an
 * implementation detail. A snapshot of the original's text would go on showing
 * it after the original was deleted — which is a leak of exactly the thing
 * deleting it was meant to stop — and would go on showing an attachment's name
 * after the file expired. So the quote is a read, every time, and a target that
 * has gone says so.
 *
 * ONE LEVEL ONLY. A reply to a reply is allowed and quotes its own target; it
 * does not quote what THAT quoted. Chat windows that nest quotes end up
 * rendering a conversation inside a message.
 *
 * SCOPED TO THE SAME CONVERSATION, again, here as well as at send time. The
 * send-time check is what refuses a bad reply; this is what makes a row that
 * somehow holds one anyway render as unavailable rather than reaching into
 * another conversation.
 *
 * ONE QUERY FOR THE PAGE, not one per reply.
 */
async function withQuotes(db, conversationId, messages) {
  const wanted = [...new Set(messages.map((m) => m.replyToId).filter(Boolean))];
  if (!wanted.length) return messages;

  const { rows } = await db.query(
    `SELECT m.id, m.body, m.kind, m.sender_id AS senderId, u.\`name\` AS senderName,
            (SELECT COUNT(*) FROM chat_attachments a WHERE a.message_id = m.id) AS attachmentCount,
            (SELECT a.file_name FROM chat_attachments a WHERE a.message_id = m.id ORDER BY a.id LIMIT 1) AS firstFile,
            (SELECT ${'TIMESTAMPDIFF(SECOND, NOW(), a.expires_at)'} FROM chat_attachments a
              WHERE a.message_id = m.id ORDER BY a.id LIMIT 1) AS firstFileLeft
       FROM chat_messages m
       LEFT JOIN users u ON u.id = m.sender_id
      WHERE m.id IN ($1) AND m.conversation_id = $2`,
    [wanted, conversationId]
  ).catch((err) => { if (unavailable(err)) return { rows: [] }; throw err; });

  const byId = new Map(rows.map((r) => [r.id, r]));
  return messages.map((m) => {
    if (!m.replyToId) return m;
    const target = byId.get(m.replyToId);
    /* GONE: deleted, or in another conversation, or never there. All three read
       the same on purpose — a reader of this conversation learns that the
       original is not available, and nothing more. */
    if (!target) {
      return { ...m, quote: { id: m.replyToId, available: false, senderName: null, snippet: null } };
    }
    return { ...m, quote: quoteOf(target) };
  });
}

/* What a quote says about its target. Its own function so the thread read, a
   single message hand-back and anything added later cannot word it differently. */
function quoteOf(target) {
  const files = Number(target.attachmentCount) || 0;
  const body = String(target.body || '').trim();
  let snippet = null;
  if (body) {
    /* ONE LINE. A quote is a pointer, not a copy — the original is one click
       away, and a quote that reproduces four paragraphs buries the reply. Cut
       by CODE POINTS so an emoji is not halved, and only when it is actually
       too long, so the ellipsis means something. */
    const points = [...body.replace(/\s+/g, ' ')];
    snippet = points.length > 120 ? `${points.slice(0, 120).join('')}\u2026` : points.join('');
  } else if (files) {
    /* WHAT KIND OF ATTACHMENT, in the words the panel uses elsewhere, and the
       file's name when there is one to give — "Photo" alone leaves somebody
       guessing which. An expired one says so rather than naming a file that is
       no longer there to open. */
    const left = Number(target.firstFileLeft);
    const expired = !Number.isFinite(left) || left <= 0;
    if (expired) snippet = 'Attachment expired';
    else snippet = files > 1 ? `${files} attachments` : (target.firstFile || 'Attachment');
  }
  return {
    id: target.id,
    available: true,
    senderName: target.senderName || (target.kind === 'system' ? null : 'Removed user'),
    snippet,
    /* A quote of a message with nothing left in it at all. Its own flag rather
       than a sentence, so the page words it and the server does not have to
       guess which language the reader is in. */
    empty: !snippet,
  };
}

/* A page of a conversation, oldest last.
 *
 * Read newest-first with a LIMIT and then reversed, because "the most recent
 * thirty" is the page a chat window wants and ORDER BY seq ASC LIMIT 30 gives
 * the oldest thirty instead. `before` pages backwards through the history. */
async function messagesIn(db, conversationId, { before, limit = 40 } = {}) {
  const n = Math.min(Math.max(Number(limit) || 40, 1), 100);
  const beforeSeq = Number(before);
  const params = [conversationId];
  let where = 'WHERE m.conversation_id = $1';
  if (Number.isFinite(beforeSeq) && beforeSeq > 0) { where += ' AND m.seq < $2'; params.push(beforeSeq); }

  const { rows } = await db.query(
    `${MESSAGE_SELECT} ${where} ORDER BY m.seq DESC LIMIT ${n}`, params
  ).catch((err) => { if (unavailable(err)) return { rows: [] }; throw err; });

  const page = rows.map(shapeMessage).reverse();
  return {
    messages: await withQuotes(db, conversationId, await withAttachments(db, page)),
    /* Whether there is more behind this page. A full page is the only case
       where there might be, so this costs nothing when there is not. */
    hasMore: rows.length === n,
  };
}

/* MAY THIS MESSAGE ANSWER THAT ONE?
 *
 * Four questions, and all four are the server's because every one of them is a
 * thing a browser can lie about:
 *
 *   it exists                 — or there is nothing to quote
 *   in THIS conversation      — the one that matters. Without it, a reply is a
 *                               way to pull a line of somebody else's
 *                               conversation into one you are in: the quote is
 *                               rendered live from the target, so the target's
 *                               text would be shown to a reader who was never
 *                               in the room it was said in.
 *   not itself                — a message cannot answer itself, and allowing it
 *                               makes a quote that renders its own body
 *   the feature is on         — the studio's switch
 *
 * READABILITY NEEDS NO SEPARATE CHECK, and that is worth saying rather than
 * leaving as an omission: membership of the conversation is the only read rule
 * chat has, the caller has already been checked into it by the route, and the
 * target is required to be in the same conversation. There is no third thing.
 *
 * A REPLY TO A REPLY IS FINE. It quotes its own target and nothing deeper —
 * see quoteOf().
 */
async function checkReplyTarget(db, { conversationId, replyToId, messageId = null }) {
  if (!replyToId) return { ok: true, replyToId: null };
  if (!require('./chat-settings').repliesEnabled()) {
    return { ok: false, status: 409, field: 'replyToId',
      error: 'Replies are switched off for this studio.' };
  }
  if (messageId && replyToId === messageId) {
    return { ok: false, status: 400, field: 'replyToId', error: 'A message cannot reply to itself.' };
  }
  const { rows } = await db.query(
    'SELECT id FROM chat_messages WHERE id = $1 AND conversation_id = $2',
    [replyToId, conversationId]
  ).catch(() => ({ rows: [] }));
  if (!rows.length) {
    /* ONE ANSWER FOR "NOT THERE" AND "SOMEWHERE ELSE". Telling a caller that
       the id exists but belongs to another conversation confirms the existence
       of a message in a conversation they are not in. */
    return { ok: false, status: 404, field: 'replyToId',
      error: 'That message is not in this conversation.' };
  }
  return { ok: true, replyToId };
}

async function send(db, { conversationId, senderId, body, replyToId = null }) {
  /* TRIMMED, NEVER TRUNCATED. The old line was slice(0, MAX_BODY) on the raw
     string, which did two wrong things at once: it silently dropped whatever
     somebody had written past the limit — the first they knew of it was
     reading their own message back short — and it counted UTF-16 units, so it
     could cut a surrogate pair in half and leave a lone surrogate that is not
     valid UTF-8 at all. A long message is refused with its length now, which
     is a thing the sender can act on. */
  const text = String(body == null ? '' : body).trim();
  if (codePoints(text) > MAX_BODY) {
    const err = new Error(`That message is ${codePoints(text)} characters. The longest a chat `
      + `message can be is ${MAX_BODY}.`);
    err.status = 400;
    err.field = 'body';
    throw err;
  }
  const id = uuid();
  const target = await checkReplyTarget(db, { conversationId, replyToId });
  if (!target.ok) {
    const err = new Error(target.error);
    err.status = target.status;
    err.field = target.field;
    throw err;
  }
  /* THE COLUMN MAY NOT BE THERE, on a deployment whose ALTER was refused —
     which on shared hosting is an ordinary outcome. A message still sends; it
     simply cannot carry what it was answering. Narrower than failing the send,
     and the same tolerance every other late column in this application gets. */
  try {
    await db.query(
      `INSERT INTO chat_messages (id, conversation_id, sender_id, kind, body, reply_to_message_id)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, conversationId, senderId, 'text', text, target.replyToId]
    );
  } catch (err) {
    if (err.code !== 'ER_BAD_FIELD_ERROR') throw err;
    await db.query(
      'INSERT INTO chat_messages (id, conversation_id, sender_id, kind, body) VALUES ($1,$2,$3,$4,$5)',
      [id, conversationId, senderId, 'text', text]
    );
  }
  return id;
}

async function messageById(db, id) {
  const { rows } = await db.query(`${MESSAGE_SELECT} WHERE m.id = $1`, [id]);
  if (!rows.length) return null;
  const [withFiles] = await withAttachments(db, [shapeMessage(rows[0])]);
  const [one] = await withQuotes(db, withFiles.conversationId, [withFiles]);
  return one;
}

/* Everything raised in the caller's conversations since they last looked.
 *
 * The cursor is a sequence number, never a timestamp — see the schema note on
 * chat_messages.seq. The caller's own messages are included: a person with the
 * app open in two tabs should see what they sent from the other one.
 *
 * Bounded at 50. A client that has been away long enough to be further behind
 * than that re-reads the conversation instead, which is cheaper for both ends
 * than a poll that returns a thousand rows. */
async function since(db, userId, cursor, { limit = 50 } = {}) {
  const from = Number(cursor);
  if (!Number.isFinite(from)) return [];
  const n = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const { rows } = await db.query(
    `${MESSAGE_SELECT}
      JOIN chat_members me ON me.conversation_id = m.conversation_id AND me.user_id = $1
     WHERE m.seq > $2
     ORDER BY m.seq ASC LIMIT ${n}`,
    [userId, from]
  ).catch((err) => { if (unavailable(err)) return { rows: [] }; throw err; });
  const withFiles = await withAttachments(db, rows.map(shapeMessage));
  /* THE POLL SPANS CONVERSATIONS, so the quotes are fetched a conversation at
     a time — withQuotes scopes its lookup to one, which is what stops a reply
     quoting a message from somewhere else even if its row says so. A handful
     of conversations per poll at most; the alternative is one query per reply. */
  const byConversation = new Map();
  for (const m of withFiles) {
    if (!byConversation.has(m.conversationId)) byConversation.set(m.conversationId, []);
    byConversation.get(m.conversationId).push(m);
  }
  const out = [];
  for (const [conversationId, group] of byConversation) {
    out.push(...await withQuotes(db, conversationId, group));
  }
  /* Back into the order the query gave them, which is by seq ascending and is
     what the caller's cursor arithmetic depends on. */
  return out.sort((a, b) => a.seq - b.seq);
}

// The newest sequence anywhere in this person's conversations, or 0.
async function highWater(db, userId) {
  const { rows } = await db.query(
    `SELECT COALESCE(MAX(m.seq), 0) AS seq
       FROM chat_messages m
       JOIN chat_members me ON me.conversation_id = m.conversation_id AND me.user_id = $1`,
    [userId]
  ).catch((err) => { if (unavailable(err)) return { rows: [{ seq: 0 }] }; throw err; });
  return Number(rows[0].seq) || 0;
}

async function unreadTotal(db, userId) {
  const { rows } = await db.query(
    `SELECT COUNT(*) AS n
       FROM chat_messages m
       JOIN chat_members me ON me.conversation_id = m.conversation_id AND me.user_id = $1
      WHERE m.seq > me.last_read_seq AND m.kind = 'text'
        AND (m.sender_id IS NULL OR m.sender_id <> $1)`,
    [userId]
  ).catch((err) => { if (unavailable(err)) return { rows: [{ n: 0 }] }; throw err; });
  return Number(rows[0].n) || 0;
}

/* Marking read only ever moves forward. Sending a stale sequence — an old tab
   catching up, a request that overtook another — must not make read messages
   unread again. */
async function markRead(db, conversationId, userId, seq) {
  const to = Number(seq);
  if (!Number.isFinite(to)) return 0;
  const out = await db.query(
    'UPDATE chat_members SET last_read_seq = $1 WHERE conversation_id = $2 AND user_id = $3 AND last_read_seq < $1',
    [to, conversationId, userId]
  ).catch((err) => { if (unavailable(err)) return null; throw err; });
  return Number((out && out.result && out.result.affectedRows) || 0);
}

module.exports = {
  MAX_GROUP_MEMBERS, MAX_BODY, MAX_TITLE, KINDS, codePoints,
  checkReplyTarget, quoteOf,
  pairKey, membership, memberCount, membersOf,
  shieldedAmong, hasSpokenIn, mayWriteTo,
  openDirect, createGroup, rename, addMembers, removeMember, leave,
  listFor, messagesIn, send, messageById, since, highWater, unreadTotal, markRead,
};
