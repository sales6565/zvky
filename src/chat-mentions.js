// Tagging somebody in a message.
//
// A mention is written into the message body as a token — @[Priya Nair](uuid)
// — and the id in it is the whole of what the server reads. The name is there
// so the raw body stays readable to a person looking at the database, and so a
// client that knows nothing about mentions still shows something sensible
// rather than a bare uuid.
//
// THE NAME IN THE TOKEN IS NEVER TRUSTED. It is the sender's text, and the
// sender chose it: nothing stops somebody typing @[Ananya Rao](their-own-id)
// by hand and having a message appear to tag the Creative Director. So the
// name is decoration and the id is the fact — every reader resolves the id
// against the conversation's member list and shows THAT person's name, or
// shows the token as plain text when the id belongs to nobody in the room.
// idsIn() below is what the notification side uses, and it returns ids only.
//
// WHY IN THE BODY AND NOT IN A TABLE. A chat message is edited by nobody and
// deleted with its conversation; there is no second lifecycle for a mention to
// have. A join table would be a second place for the truth to live and a second
// thing to keep in step with an INSERT that already happens. The body is the
// message, so the body carries the mention.

/* The token, and the grammar is deliberately tight.
 *
 * The id is a uuid, so the closing paren cannot be part of it and the pattern
 * cannot run away. The name stops at the first ] or newline, which is what
 * makes a name containing a bracket fail to parse rather than swallow the rest
 * of the line — the composer strips those on the way in for the same reason.
 * 120 is a generous ceiling for a person's name and a short one for a regular
 * expression to back off from. */
const TOKEN = /@\[([^\]\n]{1,120})\]\(([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)/gi;

/* Every mention in a body, in the order they appear.
 *
 * Duplicates are kept: "@[Ana](x) and @[Ana](x) again" really does contain two,
 * and it is the caller who decides whether that means one notification or two.
 * dedupe below is how they say so. */
function parse(body) {
  const text = String(body == null ? '' : body);
  const found = [];
  /* A fresh regex each call. A module-level /g/ carries lastIndex between
     calls, so two parses of the same string would disagree — the kind of bug
     that only shows up once something loops. */
  const re = new RegExp(TOKEN.source, 'gi');
  let m = re.exec(text);
  while (m) {
    found.push({ name: m[1], id: m[2].toLowerCase(), index: m.index, raw: m[0] });
    m = re.exec(text);
  }
  return found;
}

/* Just the ids, each once, in the order first mentioned. What the notification
   side wants: one person tagged three times is one person to tell. */
function idsIn(body) {
  const seen = new Set();
  for (const one of parse(body)) seen.add(one.id);
  return [...seen];
}

/* The body as a person reads it, with the tokens turned back into plain
 * @names.
 *
 * For anywhere a message appears without a renderer that understands tokens:
 * the one-line preview under a conversation in the list, the oversight screen,
 * a future export. Without it those all show "@[Priya Nair](3f2a…)" where they
 * mean "@Priya Nair".
 *
 * It uses the name FROM THE TOKEN, which is the one place that is right to do
 * — this is a plain-text rendering with no member list to hand and no styling
 * to confer, so the worst a forged name can do here is read as text somebody
 * typed, which is what it is. */
function toPlainText(body) {
  return String(body == null ? '' : body).replace(new RegExp(TOKEN.source, 'gi'), '@$1');
}

/* Who, of the people tagged, is actually in the room and is not the sender.
 *
 * THE VALIDATION, and it is a filter rather than a refusal. A body naming
 * somebody who is not a member is not an error to throw at the sender: the
 * dropdown only ever offers members, so a token for a non-member arrived by
 * hand or survived that person being removed from the group between the typing
 * and the sending. Neither is worth failing a message over, and neither is
 * worth telling a stranger they were talked about. They are simply not
 * notified.
 *
 * The sender is dropped too. Tagging yourself is a thing people do to make a
 * note; it is not a thing to buzz your own phone about. */
function recipients({ body, members, senderId }) {
  const inRoom = new Map();
  for (const member of members || []) {
    const id = member && (member.id || member.user_id || member.userId);
    if (id) inRoom.set(String(id).toLowerCase(), String(id));
  }
  const out = [];
  for (const id of idsIn(body)) {
    const real = inRoom.get(id);
    if (!real) continue;                                   // not in this conversation
    if (senderId && String(real) === String(senderId)) continue;   // yourself
    out.push(real);
  }
  return out;
}

module.exports = { TOKEN, parse, idsIn, toPlainText, recipients };
