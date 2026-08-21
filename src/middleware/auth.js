const jwt = require('jsonwebtoken');
const db = require('../db');
const { roleDef, capabilitiesFor } = require('../roles');

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
      'SELECT id, name, email, role, manager_id, team_lead_id FROM users WHERE id = $1',
      [payload.sub]
    );
    if (!rows.length) {
      return res.status(401).json({ error: 'This account no longer exists' });
    }
    const user = rows[0];
    if (!roleDef(user.role)) {
      // The designation was removed from the catalogue while this account
      // still holds it. Fail closed rather than granting an undefined role
      // whatever the last permission check happens to default to.
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
