const jwt = require('jsonwebtoken');
const db = require('../db');
const { roleDef, capabilitiesFor } = require('../roles');
const referenceData = require('../reference-data');

// Verifies the bearer token and attaches the current user (fetched fresh
// from the database, not just trusted from the token) to req.user.
// Fetching fresh means a role change or removal takes effect immediately
// instead of waiting for the token to expire.
async function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing bearer token' });
  }
  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const { rows } = await db.query(
      'SELECT id, name, email, role, manager_id, team_lead_id, password_changed_at FROM users WHERE id = $1',
      [payload.sub]
    );
    if (!rows.length) {
      return res.status(401).json({ error: 'This account no longer exists' });
    }
    const user = rows[0];

    // The token records which password it was issued under (see signToken).
    // Anything carrying a stale value is a session started with the old
    // password — the account's other devices — so refuse it. Tokens predating
    // this claim read as 0, which matches an account that has never changed its
    // password, so deploying this does not sign anyone out.
    const tokenPwd = Number(payload.pwd) || 0;
    const currentPwd = Number(user.password_changed_at) || 0;
    if (tokenPwd !== currentPwd) {
      return res.status(401).json({ error: 'Your password was changed. Please sign in again.' });
    }
    delete user.password_changed_at;
    if (!roleDef(user.role)) {
      // Either the designation really was removed, or this process is holding a
      // catalogue older than the account. The second is ordinary: the role may
      // have been added a moment ago, by a SQL script or by a sibling worker
      // whose write this process never saw. Reloading before deciding turns
      // what was a hard 403 — signed in, then refused on every request, purely
      // according to which worker answered — into a miss that heals itself.
      await referenceData.refresh(db).catch(() => {});
    }
    if (!roleDef(user.role)) {
      // Now it is a real absence: the designation is not in the table. Fail
      // closed rather than granting an undefined role whatever the last
      // permission check happens to default to.
      return res.status(403).json({
        error: `Your role "${user.role}" is no longer configured. Ask an admin to reassign it.`,
      });
    }
    user.capabilities = capabilitiesFor(user.role);
    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
}

// Usage: requireRole('super_admin', 'admin') — for the few places that really
// do mean specific roles rather than a capability.
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'You do not have permission to do that' });
    }
    next();
  };
}

// Usage: requireCapability('manageUsers') — the preferred check, since it keeps
// working as designations are added to the catalogue.
function requireCapability(capability) {
  return (req, res, next) => {
    const def = req.user && roleDef(req.user.role);
    if (!def || !def[capability]) {
      return res.status(403).json({ error: 'You do not have permission to do that' });
    }
    next();
  };
}

module.exports = { authenticate, requireRole, requireCapability };
