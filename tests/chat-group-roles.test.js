/* THE RULE THAT LIVES IN TWO FILES, AND THE TEST THAT KEEPS IT ONE RULE.
 *
 * ===========================================================================
 * The page has to hide what the server will refuse — an action offered and then
 * rejected teaches somebody that the screen lies — and this application has no
 * build step, so groupMemberCan exists in src/chat-group-roles.js and again,
 * verbatim, in public/index.html. That is a duplication with a known failure
 * mode: one copy gets edited.
 *
 * So the two are compared CHARACTER FOR CHARACTER here. Not "behaves the same"
 * — a behavioural comparison would need the page's copy to be loaded and
 * called, which is a browser, and it would pass for a copy that had drifted in
 * a way the test happened not to exercise.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const roles = require('../src/chat-group-roles');
const MODULE_SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'chat-group-roles.js'), 'utf8');
const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

const slice = (text, what) => {
  const from = text.indexOf(roles.SHARED_START);
  const to = text.indexOf(roles.SHARED_END, from + 1);
  assert.ok(from !== -1, `${what} has the opening marker`);
  assert.ok(to > from, `${what} has the closing marker after it`);
  return text.slice(from, to + roles.SHARED_END.length);
};

test('the page copy of groupMemberCan is the module, character for character', () => {
  const fromModule = slice(MODULE_SRC, 'src/chat-group-roles.js');
  const fromPage = slice(PAGE, 'public/index.html');
  assert.strictEqual(fromPage, fromModule,
    'public/index.html and src/chat-group-roles.js have drifted. Copy the block between the '
    + 'two markers from the module into the page, markers and all.');
  /* AND IT IS A REAL BLOCK, not an empty slice that would compare equal to
     another empty slice. */
  assert.ok(fromModule.length > 500, `the shared block is substantial: ${fromModule.length} bytes`);
  assert.match(fromModule, /function groupMemberCan\(role, action, targetRole\)/);
  /* ONCE IN EACH FILE. Two copies in the page would mean the second one is the
     one that runs and nothing compares it.
     
     COUNTED AT THE START OF A LINE, because the module also names the marker in
     its exports so this test cannot invent its own spelling of it — that
     mention is indented inside an object literal and is not a marker. */
  const count = (text) => text.split('\n')
    .filter((line) => line.startsWith(roles.SHARED_START)).length;
  assert.strictEqual(count(MODULE_SRC), 1, 'one copy in the module');
  assert.strictEqual(count(PAGE), 1, 'one copy in the page');
});

test('the shared block decides on its own, with nothing from outside it', () => {
  /* IT HAS TO RUN IN BOTH PLACES, so it may not reach for anything either
     place might not have: no require, no module, no window, no document, and
     none of this application's own helpers. Evaluated here in a scope that has
     nothing in it, which is the strongest statement available without a
     browser. */
  const block = slice(MODULE_SRC, 'the module');
  for (const forbidden of ['require(', 'module.', 'window.', 'document.', 'process.',
    'chatState', 'ROLES.', 'await ']) {
    assert.ok(!block.includes(forbidden), `the shared block does not use ${forbidden}`);
  }
  const standalone = new Function(`${block}\nreturn groupMemberCan;`)();
  assert.strictEqual(standalone('owner', 'promote'), true);
  assert.strictEqual(standalone('admin', 'promote'), false);
});

test('the matrix: every role against every action', () => {
  /* THE WHOLE RULE AS A TABLE, so it reads as the specification it is and a
     change to any cell is a change somebody has to make on purpose.
     
     `-` is "the action takes no target". remove_member is the only one that
     does, and the three target roles are spelled out rather than looped,
     because the interesting cases are precisely the asymmetric ones: an admin
     may remove a member and not another admin. */
  const TABLE = [
    // role     action           target     allowed
    ['owner',  'promote',        null,      true],
    ['admin',  'promote',        null,      false],
    ['member', 'promote',        null,      false],
    ['owner',  'demote',         null,      true],
    ['admin',  'demote',         null,      false],
    ['member', 'demote',         null,      false],
    ['owner',  'add_member',     null,      true],
    ['admin',  'add_member',     null,      true],
    ['member', 'add_member',     null,      false],
    ['owner',  'remove_member',  'member',  true],
    ['owner',  'remove_member',  'admin',   true],
    ['owner',  'remove_member',  'owner',   false],
    ['admin',  'remove_member',  'member',  true],
    ['admin',  'remove_member',  'admin',   false],
    ['admin',  'remove_member',  'owner',   false],
    ['member', 'remove_member',  'member',  false],
    ['member', 'remove_member',  'admin',   false],
    ['member', 'remove_member',  'owner',   false],
    ['owner',  'rename',         null,      true],
    ['admin',  'rename',         null,      true],
    ['member', 'rename',         null,      false],
    ['owner',  'edit_details',   null,      true],
    ['admin',  'edit_details',   null,      true],
    ['member', 'edit_details',   null,      false],
    /* NOBODY, including the owner: there is no delete-a-group in this
       application. A group ends when its last member leaves. */
    ['owner',  'delete_group',   null,      false],
    ['admin',  'delete_group',   null,      false],
    ['member', 'delete_group',   null,      false],
  ];
  for (const [role, action, target, want] of TABLE) {
    assert.strictEqual(roles.groupMemberCan(role, action, target), want,
      `${role} / ${action}${target ? ` on a ${target}` : ''} should be ${want}`);
  }

  /* AND NOTHING ELSE IS A ROLE OR AN ACTION. An unknown value is never a
     power: a hand-edited column, a typo in a route, a renamed action. */
  for (const role of ['', null, undefined, 'Owner', 'super_admin', 'admin ', 'root']) {
    for (const action of ['promote', 'add_member', 'rename']) {
      assert.strictEqual(roles.groupMemberCan(role, action), false, `${JSON.stringify(role)} is nobody`);
    }
  }
  for (const action of ['', null, 'make_owner', 'promote_self', 'delete', 'remove']) {
    assert.strictEqual(roles.groupMemberCan('owner', action), false,
      `${JSON.stringify(action)} is not an action`);
  }
});

test('the switch turns an admin into a member and leaves everybody else alone', () => {
  const { effectiveRole } = roles;
  assert.strictEqual(effectiveRole('admin', { adminsEnabled: true }), 'admin');
  assert.strictEqual(effectiveRole('admin', { adminsEnabled: false }), 'member',
    'with the feature off an admin acts as an ordinary member');
  /* THE OWNER IS NOT PART OF THE FEATURE. Ownership predates it and does not
     go away when it is switched off. */
  assert.strictEqual(effectiveRole('owner', { adminsEnabled: false }), 'owner');
  assert.strictEqual(effectiveRole('member', { adminsEnabled: false }), 'member');
  /* ANYTHING ELSE IS A MEMBER, including NULL from a deployment whose ALTER
     has not applied. */
  for (const odd of [null, undefined, '', 'ADMIN', 'root']) {
    assert.strictEqual(effectiveRole(odd, { adminsEnabled: true }), 'member', JSON.stringify(odd));
  }
  assert.strictEqual(effectiveRole('admin'), 'admin', 'the default is on');
});

test('only admin and member can be assigned, never owner', () => {
  assert.deepStrictEqual(roles.ASSIGNABLE, ['admin', 'member']);
  assert.ok(!roles.ASSIGNABLE.includes('owner'),
    'this feature never moves ownership — the one thing a studio must be able to rely on');
});

test('the two sentences in the page are the ones in the module', () => {
  /* The modal tells somebody what an admin can and cannot do. Those sentences
     live in the module beside the rule they describe; the page has its own
     copy, because it cannot require anything, and this is what keeps them the
     same sentences. */
  assert.ok(PAGE.includes(`const CHAT_ADMIN_CAN = '${roles.ADMIN_CAN}';`),
    'the page states ADMIN_CAN exactly as the module does');
  const cannot = PAGE.slice(PAGE.indexOf('const CHAT_ADMIN_CANNOT'), PAGE.indexOf('const CHAT_ADMIN_CANNOT') + 260);
  const joined = cannot.replace(/'\s*\n?\s*\+\s*'/g, '').replace(/\s+/g, ' ');
  assert.ok(joined.includes(roles.ADMIN_CANNOT.replace(/\s+/g, ' ')),
    `the page states ADMIN_CANNOT exactly as the module does: ${joined}`);
});
