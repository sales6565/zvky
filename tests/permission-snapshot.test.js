/* THE GOLDEN VISIBILITY SNAPSHOT, COMPARED.
 *
 * ===========================================================================
 * THE PROMISE THIS ENFORCES, which until now nothing did.
 *
 * docs/permission-snapshot.txt records, for every built-in role: the permission
 * keys it resolves to, every element of the page whose visibility is a
 * permission question, every Settings section, and every write endpoint it can
 * call. scripts/permission-snapshot.js generates it, and its header has always
 * said that "tests/permission-snapshot.test.js fails if the two differ by one
 * character".
 *
 * THAT TEST DID NOT EXIST. The file was generated and committed, and nothing
 * compared it — so the promise attached to it ("nothing changes for any
 * existing role") was a convention rather than a check, kept only by whoever
 * remembered to regenerate it. Three prompts in a row regenerated it correctly
 * and the fourth would not have had to.
 *
 * SO THIS IS THE CHECK, and it is deliberately the dullest possible one: build
 * the snapshot in memory from the current tree and compare it to the committed
 * file, byte for byte.
 *
 * WHAT A FAILURE MEANS, in the order worth considering:
 *
 *   1. A ROLE'S VISIBILITY CHANGED. Somebody's tab, section or endpoint moved.
 *      If that was intended, regenerating the file puts it in the diff where a
 *      reviewer sees it — which is the whole point. If it was not intended, this
 *      test is the only thing between the change and production.
 *   2. A NEW KEY, TAB, SECTION OR ROUTE was added. Same answer: regenerate, and
 *      the diff shows exactly who gained what.
 *   3. THE GENERATOR CHANGED. Then the diff is noise and should be reviewed as
 *      a change to the generator, not to anybody's access.
 *
 * It is never "just regenerate it" without reading the diff. That is the one
 * way this check can be defeated, so it is said here rather than left implied.
 *
 * NO SERVER AND NO DATABASE. The snapshot is built from the catalogue, the
 * page's two declarative tables and the route list, which is what makes it
 * cheap enough to run on every suite.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const FILE = path.join(ROOT, 'docs', 'permission-snapshot.txt');
const generator = require('../scripts/permission-snapshot.js');

test('the committed snapshot is what the tree produces', () => {
  const committed = fs.readFileSync(FILE, 'utf8');
  const fresh = generator.build();

  if (committed === fresh) {
    assert.ok(true);
    return;
  }

  /* THE FIRST DIFFERING LINE, NAMED. A byte-for-byte failure that printed two
     half-megabyte strings would be a failure nobody could read, and the useful
     information is almost always one line: which role, and which tab, section
     or endpoint moved. */
  const a = committed.split('\n');
  const b = fresh.split('\n');
  let at = 0;
  while (at < a.length && at < b.length && a[at] === b[at]) at += 1;

  /* WHICH ROLE'S BLOCK THAT LINE IS IN, searched backwards from the
     difference — the heading is what makes the line mean something. */
  let heading = '(before the first role)';
  for (let n = at; n >= 0; n -= 1) {
    if ((a[n] || '').startsWith('## ')) { heading = a[n]; break; }
  }

  assert.fail(
    'docs/permission-snapshot.txt does not match what this tree produces.\n'
    + `First difference at line ${at + 1}, inside ${heading}:\n`
    + `  committed: ${JSON.stringify(a[at])}\n`
    + `  this tree: ${JSON.stringify(b[at])}\n`
    + `(${a.length} committed lines, ${b.length} produced)\n\n`
    + 'If somebody\'s access was MEANT to change, run\n'
    + '  node scripts/permission-snapshot.js\n'
    + 'and READ THE DIFF before committing it — it names every role that gained\n'
    + 'or lost a tab, a Settings section or an endpoint. If it was not meant to\n'
    + 'change, this test is the thing that caught it.'
  );
});

test('the snapshot covers every built-in role and is not silently empty', () => {
  /* THE WAY A SNAPSHOT TEST FAILS USELESSLY is by comparing two empty strings,
     or two files that cover nothing, and passing. So the shape is asserted
     independently of the comparison above. */
  const roles = require('../src/roles');
  const committed = fs.readFileSync(FILE, 'utf8');

  const headings = [...committed.matchAll(/^## ROLE (\S+)$/gm)].map((m) => m[1]);
  assert.deepStrictEqual([...headings].sort(), [...roles.roleKeys()].sort(),
    'every built-in role has a block, and the file names no role that is gone');

  /* AND EACH BLOCK SAYS SOMETHING ABOUT ALL FOUR THINGS. A generator that
     silently stopped emitting, say, the write endpoints would otherwise pass
     this file as "unchanged" for ever after one bad regeneration. */
  for (const role of headings) {
    const block = committed.slice(committed.indexOf(`## ROLE ${role}\n`));
    const mine = block.slice(0, block.indexOf('\n## ') === -1
      ? block.length : block.indexOf('\n## '));
    /* THE HEADINGS THE GENERATOR ACTUALLY WRITES. "write routes:" and not
       "write endpoints", which is what I first guessed — and the guess failing
       here is this assertion doing its job: a label this test gets wrong is a
       label it cannot notice disappearing. */
    for (const section of ['keys(', 'sees:', 'settings sections:', 'write routes:']) {
      assert.ok(mine.includes(section),
        `${role}'s block records ${section}`);
    }
  }

  /* THE SUPER ADMIN HOLDS EVERY KEY IN THE CATALOGUE, which is the one
     invariant that must survive every future prompt and is cheap to assert
     here while the file is open. */
  const catalog = require('../src/permission-catalog');
  const su = /^## ROLE super_admin\nkeys\(\d+\): (.*)$/m.exec(committed);
  assert.ok(su, 'the Super Admin block is there');
  assert.deepStrictEqual(su[1].split(' ').sort(), [...catalog.KEYS].sort(),
    'the Super Admin holds every catalogue key, in the snapshot as in the code');
});
