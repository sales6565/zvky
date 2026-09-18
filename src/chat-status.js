// Sent, delivered, read — one tick, two grey, two blue.
//
// WHAT EACH ONE MEANS HERE, because the words are looser than the ticks:
//
//   sent       the row is in chat_messages. The send route answered 201, so it
//              is on the server and cannot now be lost. Nothing is stored for
//              this: a message that exists is sent, and a message that does not
//              exist has nothing to show a tick beside.
//
//   delivered  the recipient's browser has ASKED FOR AND BEEN GIVEN that
//              message — through the poll, or by opening the conversation.
//              There is no socket in this application: chat is a poll, so
//              "arrived at their client" is exactly "a request of theirs
//              returned it", which is what the two marking calls below are
//              hung off.
//
//   read       they had the conversation open and in front of them when it
//              was on screen. The page only calls the read route from an open,
//              visible thread, which is the difference between this and
//              delivered — an app sitting behind another window goes on
//              polling and goes on being delivered to, and reads nothing.
//
// ONE ROW PER PERSON PER MESSAGE, because a group's ticks are an AND across its
// members and a "message info" list is those rows shown one by one. A single
// status on the message could not answer either. The row is written once and
// only ever gains stamps — neither is cleared, because neither can be untrue
// later.
//
// WHY THE WRITES ARE BOUNDED. A watermark per member per conversation
// (last_delivered_seq beside the last_read_seq that was already there) says how
// far each person has been caught up to. Every call below writes rows only for
// the GAP between that watermark and where they have now reached, so opening a
// conversation with four thousand messages in it writes four thousand rows once
// and nothing ever again — and the ordinary case, one new message, writes one
// row. Without it every poll would rewrite the whole history.
//
// NOTHING HERE MAY AFFECT DELIVERY. Every function swallows its own failures
// and returns. A message is sent by src/routes/chat.js and is already stored
// before any of this runs; a status table that is missing, locked or slow must
// cost somebody a tick, never a message.

const unavailable = (err) => {
  const code = err && err.code;
  return code === 'ER_NO_SUCH_TABLE' || code === 'ER_BAD_FIELD_ERROR';
};

/* How far this person has been caught up to in this conversation. */
async function watermarks(db, conversationId, userId) {
  const { rows } = await db.query(
    `SELECT COALESCE(last_delivered_seq, 0) AS delivered, COALESCE(last_read_seq, 0) AS read_
       FROM chat_members WHERE conversation_id = $1 AND user_id = $2`,
    [conversationId, userId]
  );
  if (!rows.length) return null;
  return { delivered: Number(rows[0].delivered) || 0, read: Number(rows[0].read_) || 0 };
}

/* Write the gap.
 *
 * `stamps` decides which columns are filled: delivery sets delivered_at, a read
 * sets both — you cannot have read something that never reached you, and a
 * client that opens a thread it never polled would otherwise record a read with
 * no delivery before it.
 *
 * COALESCE on update rather than overwrite: the first stamp is the true one.
 * Polling again must not move a delivery forward, and re-reading a conversation
 * must not rewrite when it was first read.
 *
 * The sender is excluded. Your own message is not delivered to you, and
 * counting it would make a one-to-one need two deliveries to go grey.
 */
async function record(db, { conversationId, userId, fromSeq, throughSeq, read }) {
  const sql = `
    INSERT INTO chat_message_status (message_id, user_id, delivered_at, read_at)
    SELECT m.id, $1, NOW(), ${read ? 'NOW()' : 'NULL'}
      FROM chat_messages m
     WHERE m.conversation_id = $2 AND m.seq > $3 AND m.seq <= $4
       AND (m.sender_id IS NULL OR m.sender_id <> $1)
       AND m.kind = 'text'
    ON DUPLICATE KEY UPDATE
      delivered_at = COALESCE(chat_message_status.delivered_at, VALUES(delivered_at))
      ${read ? ', read_at = COALESCE(chat_message_status.read_at, VALUES(read_at))' : ''}`;
  await db.query(sql, [userId, conversationId, fromSeq, throughSeq]);
}

/* Their browser has been handed everything up to `throughSeq`. */
async function markDelivered(db, { conversationId, userId, throughSeq }) {
  const to = Number(throughSeq);
  if (!Number.isFinite(to) || to <= 0) return 0;
  try {
    const marks = await watermarks(db, conversationId, userId);
    if (!marks) return 0;                       // not a member: nothing to record
    if (to <= marks.delivered) return 0;        // already caught up
    await record(db, { conversationId, userId, fromSeq: marks.delivered, throughSeq: to, read: false });
    await db.query(
      `UPDATE chat_members SET last_delivered_seq = $1
        WHERE conversation_id = $2 AND user_id = $3 AND COALESCE(last_delivered_seq, 0) < $1`,
      [to, conversationId, userId]
    );
    return to - marks.delivered;
  } catch (err) {
    if (unavailable(err)) return 0;
    console.warn(`[chat status] could not record delivery for ${userId}: ${err.message}`);
    return 0;
  }
}

/* They had it open and were looking at it. The caller — src/routes/chat.js —
   has already moved last_read_seq; this fills in the per-message stamps for
   the same stretch, and carries the delivery stamp with it. */
async function markRead(db, { conversationId, userId, throughSeq, fromSeq }) {
  const to = Number(throughSeq);
  if (!Number.isFinite(to) || to <= 0) return 0;
  try {
    const marks = await watermarks(db, conversationId, userId);
    if (!marks) return 0;
    /* fromSeq is where they had read up to BEFORE this call, which the route
       knows and this no longer can — markRead on chat_members has already run
       by the time this is reached, so reading the watermark here would find the
       new value and write nothing. */
    const from = Number.isFinite(Number(fromSeq)) ? Number(fromSeq) : marks.read;
    if (to <= from) return 0;
    await record(db, { conversationId, userId, fromSeq: from, throughSeq: to, read: true });
    await db.query(
      `UPDATE chat_members SET last_delivered_seq = $1
        WHERE conversation_id = $2 AND user_id = $3 AND COALESCE(last_delivered_seq, 0) < $1`,
      [to, conversationId, userId]
    );
    return to - from;
  } catch (err) {
    if (unavailable(err)) return 0;
    console.warn(`[chat status] could not record a read for ${userId}: ${err.message}`);
    return 0;
  }
}

/* The tick to draw beside each of a set of messages.
 *
 * COUNTED AGAINST CURRENT MEMBERS ONLY, and that join is the whole of the
 * "somebody left the group" rule. A member who has gone is not in chat_members
 * any more, so their row — which is still in the status table, and still true
 * — no longer counts towards the total OR towards the tally. A message nobody
 * remaining is waiting on goes blue, where before it would have been stuck
 * grey for ever waiting on somebody who had left.
 *
 * Returns a Map of messageId -> { status, delivered, read, audience }.
 * `audience` is how many people the message is FOR: every current member but
 * the sender. Zero — a group somebody is alone in — reads as sent, because
 * there is nobody for it to be delivered to.
 */
async function forMessages(db, { conversationId, messageIds }) {
  const out = new Map();
  const ids = (messageIds || []).filter(Boolean);
  if (!ids.length) return out;
  try {
    const { rows: counted } = await db.query(
      `SELECT s.message_id AS messageId,
              SUM(s.delivered_at IS NOT NULL) AS delivered,
              SUM(s.read_at IS NOT NULL) AS readCount
         FROM chat_message_status s
         JOIN chat_members cm ON cm.conversation_id = $1 AND cm.user_id = s.user_id
        WHERE s.message_id IN ($2)
        GROUP BY s.message_id`,
      [conversationId, ids]
    );
    const { rows: sizeRows } = await db.query(
      'SELECT COUNT(*) AS n FROM chat_members WHERE conversation_id = $1', [conversationId]
    );
    const members = Number(sizeRows[0].n) || 0;
    const audience = Math.max(0, members - 1);      // everybody but the sender

    const byId = new Map(counted.map((r) => [r.messageId, r]));
    for (const id of ids) {
      const row = byId.get(id) || {};
      const delivered = Number(row.delivered) || 0;
      const read = Number(row.readCount) || 0;
      let status = 'sent';
      if (audience > 0 && read >= audience) status = 'read';
      else if (audience > 0 && delivered >= audience) status = 'delivered';
      out.set(id, { status, delivered, read, audience });
    }
    return out;
  } catch (err) {
    if (unavailable(err)) return out;
    console.warn(`[chat status] could not read the statuses: ${err.message}`);
    return out;
  }
}

/* Who has had it, and when — the message-info list.
 *
 * CURRENT MEMBERS, again, and this time it is a LEFT JOIN the other way round:
 * the list is driven by who is in the conversation now, so somebody who has
 * never been delivered the message appears with no stamps rather than not
 * appearing. "Waiting on Bo" is the question this view exists to answer, and a
 * missing row is the answer.
 */
async function detailFor(db, { conversationId, messageId, senderId }) {
  try {
    const { rows } = await db.query(
      `SELECT u.id, u.\`name\`, u.avatar_updated_at AS photoUpdatedAt,
              s.delivered_at AS deliveredAt, s.read_at AS readAt
         FROM chat_members cm
         JOIN users u ON u.id = cm.user_id
         LEFT JOIN chat_message_status s ON s.message_id = $2 AND s.user_id = cm.user_id
        WHERE cm.conversation_id = $1 AND cm.user_id <> $3
        ORDER BY (s.read_at IS NULL), s.read_at DESC, u.\`name\``,
      [conversationId, messageId, senderId]
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      photoUpdatedAt: r.photoUpdatedAt || null,
      deliveredAt: r.deliveredAt || null,
      readAt: r.readAt || null,
    }));
  } catch (err) {
    if (unavailable(err)) return [];
    console.warn(`[chat status] could not read the breakdown: ${err.message}`);
    return [];
  }
}

module.exports = { markDelivered, markRead, forMessages, detailFor, watermarks };
