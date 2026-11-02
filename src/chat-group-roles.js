// WHO MAY DO WHAT INSIDE A CHAT GROUP, decided once.
//
// ===========================================================================
// THREE ROLES, AND ONE FUNCTION THAT ANSWERS FOR ALL OF THEM.
//
//   owner   the person who created the group, or whoever inherited it when a
//           previous owner left. Everything, including handing out and taking
//           back the admin role. Exactly one per group.
//   admin   a delegated subset and nothing more: add people, remove ORDINARY
//           members, rename the group. An admin cannot promote or demote
//           anybody, cannot remove the owner or another admin, and cannot
//           become the owner. Any number per group.
//   member  what every member of a group could do before this existed.
//
// WHY A FUNCTION AND NOT A TABLE OF `if`s AT EACH ROUTE. The page has to hide
// what the server will refuse — an action offered and then rejected is worse
// than one that was never there — so the rule exists in two places by
// necessity. There is no build step in this application: public/index.html is
// served as it is written. So the function below is COPIED VERBATIM into the
// page between the same two markers, and tests/chat-group-roles.test.js
// compares the two character for character and fails if they drift. One rule,
// written once, checked mechanically.
//
// THE SWITCH IS NOT IN HERE. "Chat group admins" being off means an admin acts
// as an ordinary member, and the caller resolves that before asking — see
// effectiveRole(). Keeping it out leaves this function pure and total: a role
// and an action in, a boolean out, no settings, no database, no clock.

/* ==========================================================================
 * SHARED WITH THE PAGE. Everything between the two markers below is copied
 * verbatim into public/index.html. Do not edit one without the other;
 * tests/chat-group-roles.test.js compares them character for character.
 * ========================================================================== */
// --8<-- groupMemberCan --8<--
function groupMemberCan(role, action, targetRole) {
  /* Anybody who is not in the group decides nothing. membership is checked
     before this is ever called; this is the second latch. */
  if (role !== 'owner' && role !== 'admin' && role !== 'member') return false;
  switch (action) {
    /* HANDING OUT THE ROLE IS THE OWNER'S ALONE, and that is the whole point of
       there being an owner at all. An admin who could promote could build a
       majority; an admin who could demote could remove the only person able to
       stop them. */
    case 'promote':
    case 'demote':
      return role === 'owner';
    /* ADDING IS THE DELEGATED JOB people actually asked for. Whoever is added
       arrives as an ordinary member whichever of the two did the adding. */
    case 'add_member':
      return role === 'owner' || role === 'admin';
    /* REMOVING DEPENDS ON WHO. The owner can remove anybody but themselves
       (Leave group is how an owner goes). An admin can remove ordinary members
       only: not the owner, and not another admin — two admins who could remove
       each other is a race, not a hierarchy. */
    case 'remove_member':
      if (targetRole === 'owner') return false;
      if (role === 'owner') return true;
      if (role === 'admin') return targetRole === 'member';
      return false;
    /* THE GROUP'S NAME AND DETAILS. One action in the vocabulary for each, so a
       future group description or icon has a name here already; today they are
       the same field and the same answer. */
    case 'rename':
    case 'edit_details':
      return role === 'owner' || role === 'admin';
    /* NOBODY DELETES A GROUP, including the owner, because there is no such
       thing in this application: a group ends when the last person leaves it
       (see leave() in src/chat.js). The action is in the vocabulary so the
       answer is written down rather than missing, and so that a mutation that
       hands it to an admin has something to fail against. */
    case 'delete_group':
      return false;
    default:
      return false;
  }
}
// --8<-- end --8<--

/* WHAT THE ROLE IS *TODAY*, with the studio's switch applied.
 *
 * With "Chat group admins" off, an admin acts as an ordinary member — and the
 * stored role is left exactly as it is, so turning the switch back on restores
 * every admin without anybody having to remember who they were. The owner is
 * never affected: ownership is not part of the feature being switched.
 *
 * Kept out of groupMemberCan on purpose; see the note at the top. */
function effectiveRole(storedRole, { adminsEnabled = true } = {}) {
  const role = String(storedRole || 'member');
  if (role === 'admin' && !adminsEnabled) return 'member';
  if (role !== 'owner' && role !== 'admin') return 'member';
  return role;
}

const ROLES = { owner: 'owner', admin: 'admin', member: 'member' };

/* The two values the promote/demote endpoint will accept as a NEW role. Not
   'owner': this feature never moves ownership, which is the one thing a studio
   asking for "make them an admin" must be able to rely on. */
const ASSIGNABLE = ['admin', 'member'];

/* The sentence the confirmation modal and the system line are built from, so
   the screen and the stream cannot come to describe the role differently. */
const ADMIN_CAN = 'add members, remove ordinary members, and rename the group';
const ADMIN_CANNOT = 'remove or demote the owner or other admins, make anybody else an admin, '
  + 'or delete the group';

module.exports = {
  groupMemberCan, effectiveRole, ROLES, ASSIGNABLE, ADMIN_CAN, ADMIN_CANNOT,
  /* The marker text, exported so the test that compares the page copy cannot
     drift from the file it is slicing. */
  SHARED_START: '// --8<-- groupMemberCan --8<--',
  SHARED_END: '// --8<-- end --8<--',
};
