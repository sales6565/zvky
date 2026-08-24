// What the gate has actually seen, so a rollout is decided from data.
//
// Monitor mode exists to answer one question before enforcement is switched on:
// "if this were enforcing, who would I have locked out?" That question was only
// answerable by reading the server log, which is a scrolling stream with no
// aggregation — a chatty scanner buries the one line that matters, and the
// address you most need to see is the one that appeared once an hour ago.
//
// So the gate records what it judged, and Settings shows it. Every decision is
// kept, not just refusals: knowing which addresses are currently reaching the
// app is half of knowing what enforcing would break.
//
// Deliberately in memory and deliberately bounded. Writing a row per blocked
// request would let anyone scanning the internet drive load on the database,
// which is a poor trade for data that is only interesting during a rollout. The
// cost is that this covers one process since it last started — see summary()'s
// `since`, and note that a host running several workers gives each its own
// view.

const MAX_ADDRESSES = 500;
const MAX_SAMPLE_PATHS = 3;

let observations = new Map();
let startedAt = Date.now();
let overflowed = false;

// Whether a decision means "this address would be, or was, refused".
const REFUSING = new Set(['denied', 'would-deny', 'storage-unavailable-closed']);

function record(ip, { decision, method, path, rule } = {}) {
  if (!ip || !decision) return;

  let entry = observations.get(ip);
  if (!entry) {
    // Evict the address seen longest ago rather than growing without bound. A
    // Map iterates in insertion order and re-inserting on each hit below keeps
    // that order meaningful, so the first key is the least recently seen.
    if (observations.size >= MAX_ADDRESSES) {
      overflowed = true;
      observations.delete(observations.keys().next().value);
    }
    entry = {
      address: ip,
      firstSeen: Date.now(),
      count: 0,
      decisions: {},
      paths: [],
      rule: null,
    };
  } else {
    observations.delete(ip); // re-inserted below, so recency drives eviction
  }

  entry.lastSeen = Date.now();
  entry.count++;
  entry.decisions[decision] = (entry.decisions[decision] || 0) + 1;
  if (rule) entry.rule = rule;

  const where = `${method || 'GET'} ${path || '/'}`;
  if (entry.paths.length < MAX_SAMPLE_PATHS && !entry.paths.includes(where)) {
    entry.paths.push(where);
  }

  observations.set(ip, entry);
}

// Newest activity first, which is the order someone reviewing a rollout wants:
// the address they just tried from is at the top.
function summary() {
  const all = [...observations.values()]
    .map((entry) => ({
      ...entry,
      // The single fact the rollout turns on.
      wouldBeRefused: Object.keys(entry.decisions).some((d) => REFUSING.has(d)),
      allowed: Boolean(entry.decisions.allowed),
    }))
    .sort((a, b) => b.lastSeen - a.lastSeen);

  return {
    since: startedAt,
    // Says plainly what this can and cannot tell you.
    scope: 'One server process, since it last restarted. A host running several workers gives each its own view.',
    total: all.length,
    truncated: overflowed,
    limit: MAX_ADDRESSES,
    refused: all.filter((e) => e.wouldBeRefused),
    allowed: all.filter((e) => e.allowed && !e.wouldBeRefused),
    addresses: all,
  };
}

// Used after adding an address, so the screen stops showing it as a problem
// once it has been dealt with rather than keeping a stale warning.
function forget(ip) {
  return observations.delete(ip);
}

function reset() {
  observations = new Map();
  startedAt = Date.now();
  overflowed = false;
}

module.exports = { record, summary, forget, reset, MAX_ADDRESSES };
