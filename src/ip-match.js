// Matching a client address against a single IP or a CIDR range.
//
// Written out rather than pulled in, to stay consistent with how the rest of
// this codebase avoids dependencies for small, testable pieces. It is the part
// of the allowlist that decides who gets in, so it is deliberately strict:
// anything it cannot parse with certainty is treated as no match rather than
// guessed at.
//
// Addresses are compared as byte arrays, which is what lets one function handle
// IPv4, IPv6 and the IPv4-mapped IPv6 form (::ffff:106.51.81.61) that a proxy
// or a dual-stack socket commonly produces.

// --- parsing -----------------------------------------------------------------

function parseIPv4(text) {
  const parts = String(text).split('.');
  if (parts.length !== 4) return null;
  const bytes = [];
  for (const part of parts) {
    // Reject empty, non-numeric, and leading zeros: "010" is octal in some
    // parsers and decimal in others, and an address that reads differently
    // depending on who reads it has no business in an allowlist.
    if (!/^\d{1,3}$/.test(part)) return null;
    if (part.length > 1 && part[0] === '0') return null;
    const value = Number(part);
    if (value > 255) return null;
    bytes.push(value);
  }
  return Uint8Array.from(bytes);
}

function parseIPv6(text) {
  let input = String(text).trim();
  if (!input.includes(':')) return null;

  // A trailing dotted quad, as in ::ffff:106.51.81.61 or 2001:db8::1.2.3.4.
  let tailBytes = null;
  const lastColon = input.lastIndexOf(':');
  const tail = input.slice(lastColon + 1);
  if (tail.includes('.')) {
    tailBytes = parseIPv4(tail);
    if (!tailBytes) return null;
    input = input.slice(0, lastColon + 1) + '0:0';
  }

  const halves = input.split('::');
  if (halves.length > 2) return null; // :: may appear at most once

  const toGroups = (segment) => {
    if (segment === '') return [];
    const groups = segment.split(':');
    const out = [];
    for (const group of groups) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
      out.push(parseInt(group, 16));
    }
    return out;
  };

  const head = toGroups(halves[0]);
  const rest = halves.length === 2 ? toGroups(halves[1]) : [];
  if (head === null || rest === null) return null;

  let groups;
  if (halves.length === 2) {
    const gap = 8 - head.length - rest.length;
    if (gap < 1) return null; // :: must stand for at least one zero group
    groups = [...head, ...Array(gap).fill(0), ...rest];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;

  const bytes = new Uint8Array(16);
  groups.forEach((group, i) => {
    bytes[i * 2] = (group >> 8) & 0xff;
    bytes[i * 2 + 1] = group & 0xff;
  });
  if (tailBytes) bytes.set(tailBytes, 12);
  return bytes;
}

// An IPv4-mapped IPv6 address is the same host as its IPv4 form, so reduce it
// to four bytes and let one entry cover both spellings.
function unmap(bytes) {
  if (bytes.length !== 16) return bytes;
  const isMapped =
    bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  return isMapped ? bytes.slice(12) : bytes;
}

// Returns { bytes, version } or null. Accepts a zone id (fe80::1%eth0) by
// discarding it, since it identifies an interface rather than a host.
function parseIP(text) {
  if (typeof text !== 'string') return null;
  const cleaned = text.trim().replace(/^\[|\]$/g, '').split('%')[0];
  if (!cleaned) return null;

  const v4 = parseIPv4(cleaned);
  if (v4) return { bytes: v4, version: 4 };

  const v6 = parseIPv6(cleaned);
  if (v6) {
    const bytes = unmap(v6);
    return { bytes, version: bytes.length === 4 ? 4 : 6 };
  }
  return null;
}

// --- entries -----------------------------------------------------------------

// Parses "1.2.3.4" or "10.0.0.0/8" or "2001:db8::/32" into something matchable.
// Returns { bytes, version, prefix, text } or null.
function parseEntry(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed) return null;

  const [addressPart, prefixPart, ...extra] = trimmed.split('/');
  if (extra.length) return null;

  const address = parseIP(addressPart);
  if (!address) return null;

  const maxPrefix = address.version === 4 ? 32 : 128;
  let prefix = maxPrefix;
  if (prefixPart !== undefined) {
    if (!/^\d{1,3}$/.test(prefixPart)) return null;
    prefix = Number(prefixPart);
    if (prefix > maxPrefix) return null;
  }

  return { bytes: address.bytes, version: address.version, prefix, text: trimmed };
}

function isValidEntry(text) {
  return parseEntry(text) !== null;
}

// --- matching ----------------------------------------------------------------

function bytesMatch(a, b, prefix) {
  const fullBytes = prefix >> 3;
  for (let i = 0; i < fullBytes; i++) {
    if (a[i] !== b[i]) return false;
  }
  const remainingBits = prefix & 7;
  if (remainingBits === 0) return true;
  const mask = (0xff << (8 - remainingBits)) & 0xff;
  return (a[fullBytes] & mask) === (b[fullBytes] & mask);
}

// Does this client address fall inside this entry?
function matches(clientIP, entryText) {
  const client = parseIP(clientIP);
  const entry = parseEntry(entryText);
  if (!client || !entry) return false;
  if (client.version !== entry.version) return false;
  return bytesMatch(client.bytes, entry.bytes, entry.prefix);
}

// The first entry covering this address, or null. Returning the entry rather
// than a boolean lets the caller log which rule let someone in.
function findMatch(clientIP, entries) {
  const client = parseIP(clientIP);
  if (!client) return null;
  for (const entry of entries) {
    const text = typeof entry === 'string' ? entry : entry && entry.address;
    const parsed = parseEntry(text);
    if (!parsed) continue;
    if (parsed.version !== client.version) continue;
    if (bytesMatch(client.bytes, parsed.bytes, parsed.prefix)) return entry;
  }
  return null;
}

// Canonical spelling, so "::FFFF:106.51.81.61" and "106.51.81.61" are stored
// and compared as the same thing.
function normalise(text) {
  const parsed = parseIP(text);
  if (!parsed) return null;
  if (parsed.version === 4) return Array.from(parsed.bytes).join('.');
  const groups = [];
  for (let i = 0; i < 16; i += 2) {
    groups.push(((parsed.bytes[i] << 8) | parsed.bytes[i + 1]).toString(16));
  }
  return groups.join(':');
}

// Canonical spelling of an entry, keeping any prefix.
function normaliseEntry(text) {
  const parsed = parseEntry(text);
  if (!parsed) return null;
  const address = normalise(
    parsed.version === 4
      ? Array.from(parsed.bytes).join('.')
      : parsed.text.split('/')[0]
  );
  const maxPrefix = parsed.version === 4 ? 32 : 128;
  return parsed.prefix === maxPrefix ? address : `${address}/${parsed.prefix}`;
}

module.exports = {
  parseIP,
  parseEntry,
  isValidEntry,
  matches,
  findMatch,
  normalise,
  normaliseEntry,
};
