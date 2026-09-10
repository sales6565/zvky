// Which columns of `users` a query should read when it wants "the user".
//
// This exists because of one column. `avatar` is a MEDIUMBLOB, and three
// queries in this codebase said SELECT * — including the one behind sign-in,
// whose row is handed straight back to the browser. The moment profile photos
// were added, that turned every login response into the user's photo
// re-encoded as a JSON array of byte values, several times the size of the
// image itself, for a screen that only ever needed to know whether a photo
// exists.
//
// So: name the columns. `avatar_updated_at` comes back as photoUpdatedAt,
// which is all any caller needs — the page builds the image URL from the id
// and uses the timestamp to bust its cache. The bytes are read in exactly one
// place, src/avatar.js, by the route that serves them.
//
// Adding a column to `users` means adding it here too. That is the cost of not
// shipping a blob to every caller by default, and it is the right way round:
// a new column is opted in, rather than leaked and noticed later.

const USER_COLUMNS = [
  'id', 'name', 'email', 'role',
  'manager_id', 'team_lead_id', 'reports_to_id',
  /* Whether the account may be used at all. Read on EVERY authenticated
     request, not only at sign-in: deactivating somebody who is already signed
     in has to end that session too, or the account stays usable for as long as
     their tab is open — which is precisely the window somebody is deactivated
     to close. */
  'is_active', 'deactivated_at',
  'password_changed_at', 'created_at',
  'avatar_updated_at AS `photoUpdatedAt`',
  // NULL until somebody finishes or skips the Quick Tour, which is what
  // decides whether it launches itself on sign-in.
  'tour_seen_at AS `tourSeenAt`',
  /* Set when an administrator resets this account's password. While it is on,
     authenticate() answers nothing but the password change — so it has to
     travel with the user on every request, not just at sign-in. */
  'must_change_password AS `mustChangePassword`',
];

// The same list plus the hash, for the two places that verify a password.
const USER_COLUMNS_WITH_HASH = [...USER_COLUMNS, 'password_hash'];

const userFields = (withHash = false) =>
  (withHash ? USER_COLUMNS_WITH_HASH : USER_COLUMNS).join(', ');

module.exports = { USER_COLUMNS, USER_COLUMNS_WITH_HASH, userFields };
