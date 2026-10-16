/* THE PROJECT LINK, AND EVERY PATH COMPUTED FROM IT.
 *
 * ===========================================================================
 * ONE RULE, SAID TWICE, PINNED HERE.
 *
 * src/server-link.js decides whether a link is acceptable; public/index.html
 * carries the same rule so it can say so as somebody types. They cannot be one
 * function — src/ goes to the host and the page goes to the browser, with no
 * build step between — so this file runs BOTH against one shared matrix and
 * fails naming any input they disagree about. That is what makes the
 * duplication a mirror rather than a second opinion.
 *
 * ===========================================================================
 * AND THE PATH A FILE LANDS AT, which is the other half of the feature:
 *
 *     <project's folder> / <discipline> / <the person's own folder>
 *
 * computed from the asset's project and category and the uploader's account,
 * never from anything the browser sent.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const serverLink = require('../src/server-link');
const serverPaths = require('../src/server-paths');

const ROOT = path.join(__dirname, '..');
const PAGE = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

const UNC = '\\\\SERVER\\Projects';
const POSIX = '/mnt/projects';

/* THE SHARED MATRIX. Both implementations see exactly this.
   [ prefix, link, expected relative or null ] */
const MATRIX = [
  // the ordinary cases, in both notations
  [UNC, '\\\\SERVER\\Projects\\Hero', 'Hero'],
  [UNC, '\\\\SERVER\\Projects\\Hero Quest', 'Hero Quest'],
  [UNC, '\\\\SERVER\\Projects\\Hero\\Art', 'Hero/Art'],
  [POSIX, '/mnt/projects/Hero', 'Hero'],
  [POSIX, '/mnt/projects/Hero/Art', 'Hero/Art'],
  // separators and case fold for COMPARISON, and the tail keeps its own case
  [UNC, '//SERVER/Projects/Hero', 'Hero'],
  [UNC, '\\\\server\\projects\\Hero', 'Hero'],
  [UNC, '\\\\SERVER\\Projects\\\\Hero\\\\', 'Hero'],
  [UNC, '  \\\\SERVER\\Projects\\Hero  ', 'Hero'],
  [POSIX, '/MNT/PROJECTS/Hero', 'Hero'],
  // refusals
  [UNC, '', null],
  [UNC, '\\\\SERVER\\Projects', null],                 // the prefix alone
  [UNC, '\\\\SERVER\\Projects\\', null],
  [UNC, '\\\\OTHER\\Projects\\Hero', null],            // another server
  [UNC, '\\\\SERVER\\Other\\Hero', null],              // another share
  [UNC, '\\\\SERVERX\\Projects\\Hero', null],          // a longer host name
  [UNC, '\\\\SERVER\\ProjectsOld\\Hero', null],        // a longer share name
  [UNC, '\\\\SERVER\\Projects\\..\\Elsewhere', null],
  [UNC, '\\\\SERVER\\Projects\\.\\Hero', null],
  [UNC, '\\\\SERVER\\Projects\\Hero.', null],          // trailing dot
  [UNC, '\\\\SERVER\\Projects\\Hero ', 'Hero'],        // trailing space on the LAST segment is trimmed with the link
  [UNC, '\\\\SERVER\\Projects\\Hero \\Art', null],     // and not in the middle
  [UNC, '\\\\SERVER\\Projects\\NUL', null],
  [UNC, '\\\\SERVER\\Projects\\CON\\Art', null],
  [UNC, '\\\\SERVER\\Projects\\a:b', null],
  [UNC, `\\\\\\\\SERVER\\\\Projects\\\\${'x'.repeat(200)}`, null],
  [POSIX, '/mnt/projectsX/Hero', null],
  [POSIX, 'mnt/projects/Hero', null],                  // not absolute
  // no prefix configured at all
  ['', '\\\\SERVER\\Projects\\Hero', null],
  [null, '/mnt/projects/Hero', null],
];

/* The page's copy, lifted and run. Only the two functions, with nothing else
   from the page in scope — so a test that passed because some other page global
   happened to exist is not possible. */
function pageValidator() {
  const from = PAGE.indexOf('function srvFoldLink(');
  const to = PAGE.indexOf('/* Draw the field, or leave it hidden.');
  assert.ok(from > 0 && to > from, "the page's link rule is where this test expects it");
  const source = PAGE.slice(from, to);
  // eslint-disable-next-line no-new-func
  return new Function(`${source}; return { srvValidateLink, srvFoldLink };`)();
}

test('the page and the server agree about every link in the matrix', () => {
  const page = pageValidator();
  for (const [prefix, link, want] of MATRIX) {
    const mine = serverLink.validateLink(link, prefix);
    const theirs = page.srvValidateLink(link, prefix);
    assert.strictEqual(mine.ok, theirs.ok,
      `disagreement on ${JSON.stringify(link)} under ${JSON.stringify(prefix)}: `
      + `server says ${mine.ok ? 'ok' : mine.reason}, page says ${theirs.ok ? 'ok' : theirs.reason}`);
    if (mine.ok) {
      assert.strictEqual(mine.relative, theirs.relative,
        `both accept ${JSON.stringify(link)} but resolve it differently: ${mine.relative} vs ${theirs.relative}`);
    }
    // And the matrix's own expectation, so a shared bug in both is still caught.
    if (want === null) assert.strictEqual(mine.ok, false, `${JSON.stringify(link)} should be refused`);
    else assert.strictEqual(mine.relative, want, `${JSON.stringify(link)} should resolve to ${want}`);
  }
});

test('a refused link always carries a sentence somebody can act on', () => {
  for (const [prefix, link, want] of MATRIX) {
    if (want !== null) continue;
    const out = serverLink.validateLink(link, prefix);
    assert.ok(out.error && out.error.length > 10, `${JSON.stringify(link)} refused with no reason`);
    // The commonest mistake names the prefix, because that is the fix.
    if (out.reason === 'outside-prefix') assert.ok(out.error.includes(String(prefix).trim()));
  }
});

test('the link is stored exactly as typed', () => {
  /* The same bargain src/submission-link.js makes: there is no normal form for
     a UNC path that is still a path somebody can paste into Explorer, so
     nothing is normalised. Only the surrounding whitespace goes. */
  const out = serverLink.validateLink('  \\\\SERVER\\Projects\\Hero Quest  ', UNC);
  assert.strictEqual(out.link, '\\\\SERVER\\Projects\\Hero Quest');
  const lower = serverLink.validateLink('\\\\server\\projects\\Hero Quest', UNC);
  assert.strictEqual(lower.link, '\\\\server\\projects\\Hero Quest', 'the case it was typed in is kept');
  assert.strictEqual(lower.relative, 'Hero Quest', 'and the tail keeps its own case too');
});

test('projectFolderRel is the one answer to "where is this project"', () => {
  assert.strictEqual(serverLink.projectFolderRel({ server_link: `${UNC}\\Hero` }, UNC), 'Hero');
  assert.strictEqual(serverLink.projectFolderRel({ server_link: null }, UNC), null,
    'a project with no link has no folder — which is every project in production');
  assert.strictEqual(serverLink.projectFolderRel({}, UNC), null);
  assert.strictEqual(serverLink.projectFolderRel(null, UNC), null);
  assert.strictEqual(serverLink.projectFolderRel({ server_link: '\\\\OTHER\\x\\Hero' }, UNC), null,
    'and a link that stopped matching the prefix resolves to nothing rather than to something wrong');
});

test('the upload path is project, discipline, person — in that order', () => {
  const project = { id: 'p1', server_link: `${UNC}\\Hero Quest` };
  const discipline = { folders: { art: 'Artist', animation: 'Animator' }, fallback: 'Work' };
  const out = serverLink.uploadPathFor({
    project, prefix: UNC, disciplineId: 'art', userFolder: 'Ana Artist', discipline,
  });
  assert.ok(out.ok, out.error);
  assert.strictEqual(out.relative, 'Hero Quest/Artist/Ana Artist');
  assert.strictEqual(out.existingPrefix, 'Hero Quest',
    'the project folder must already exist, so it is named separately from what may be created');
  assert.strictEqual(out.createBelow, 'Artist/Ana Artist');

  /* THE DISCIPLINE IS PASSED IN, worked out by src/asset-discipline.js from the
     asset's type — the same rule the Dashboard's sub-tabs use. This function
     only names the folder, and a discipline with no name falls back. */
  assert.strictEqual(serverLink.uploadPathFor({ project, prefix: UNC, disciplineId: 'animation', userFolder: 'Ana', discipline }).relative,
    'Hero Quest/Animator/Ana');
  assert.strictEqual(serverLink.uploadPathFor({ project, prefix: UNC, disciplineId: 'art', userFolder: 'Ana', discipline: { folders: {}, fallback: 'Work' } }).relative,
    'Hero Quest/Work/Ana', 'a discipline whose name was cleared uses the fallback');
  assert.strictEqual(serverLink.uploadPathFor({ project, prefix: UNC, disciplineId: null, userFolder: 'Ana', discipline }).relative,
    'Hero Quest/Work/Ana', 'and a caller that passes no discipline still has somewhere to go');

  // A dragged subfolder is kept, cleaned.
  assert.strictEqual(serverLink.uploadPathFor({ project, prefix: UNC, disciplineId: 'art', userFolder: 'Ana', discipline, subPath: 'scenes/act1' }).relative,
    'Hero Quest/Artist/Ana/scenes/act1');
  // And a subpath that tries to climb is refused, not cleaned into something.
  for (const subPath of ['../..', '/etc', 'a/../../b', 'C:\\x']) {
    const bad = serverLink.uploadPathFor({ project, prefix: UNC, disciplineId: 'art', userFolder: 'Ana', discipline, subPath });
    assert.strictEqual(bad.ok, false, `${subPath} must be refused`);
  }
  // Two projects never share a folder, which is the point of computing it.
  const other = { id: 'p2', server_link: `${UNC}\\Second Project` };
  assert.strictEqual(serverLink.uploadPathFor({ project: other, prefix: UNC, disciplineId: 'art', userFolder: 'Ana', discipline }).relative,
    'Second Project/Artist/Ana');
  // A project with no link cannot be uploaded to at all.
  assert.strictEqual(serverLink.uploadPathFor({ project: { id: 'p3' }, prefix: UNC, disciplineId: 'art', userFolder: 'Ana', discipline }).ok, false);
  assert.strictEqual(serverLink.uploadPathFor({ project, prefix: UNC, disciplineId: 'art', userFolder: null, discipline }).ok, false);
});

test('a person\'s folder is their name, made safe, and stable across renames', () => {
  assert.strictEqual(serverLink.userFolderName('Ana Artist', 'abcd1234'), 'Ana Artist');
  assert.strictEqual(serverLink.userFolderName('Ana  Artist!', 'abcd1234'), 'Ana Artist');
  assert.strictEqual(serverLink.userFolderName('Zoë Müller', 'abcd1234'), 'Zoe Muller');
  /* The letters decomposition cannot help with. "Søren Ødegård" became
     "S ren degard" before these were handled — which would have been that
     person's folder for the rest of their time at the studio. */
  assert.strictEqual(serverLink.userFolderName('Søren Ødegård', 'abcd1234'), 'Soren Odegard');
  assert.strictEqual(serverLink.userFolderName('Łukasz Nowak', 'abcd1234'), 'Lukasz Nowak');
  assert.strictEqual(serverLink.userFolderName('Weiß Müller', 'abcd1234'), 'Weiss Muller');
  assert.strictEqual(serverLink.userFolderName('Ægir Þórsson', 'abcd1234'), 'AEgir Thorsson');
  assert.strictEqual(serverLink.userFolderName('O\u2019Brien, Sam', 'abcd1234'), 'O Brien Sam');
  assert.strictEqual(serverLink.userFolderName('NUL', 'abcd1234'), 'user-abcd1234',
    'a name that is a device name falls back rather than being refused');
  assert.strictEqual(serverLink.userFolderName('   ', 'abcd1234'), 'user-abcd1234');
  assert.strictEqual(serverLink.userFolderName('Trailing dot.', 'abcd1234'), 'Trailing dot');
  // The collision suffix is derived from the id, so it is stable rather than a counter.
  const a = serverLink.withSuffix('Alex Kim', 'aaaa1111');
  const b = serverLink.withSuffix('Alex Kim', 'bbbb2222');
  assert.notStrictEqual(a, b);
  assert.strictEqual(a, serverLink.withSuffix('Alex Kim', 'aaaa1111'), 'and the same id always gives the same folder');
  assert.ok(serverPaths.cleanName(a).ok, 'and the suffixed name is still a legal folder name');
});

test('overlap warnings name the consequence and never refuse', () => {
  const others = [
    { name: 'Alpha', relative: 'Alpha' },
    { name: 'Alpha Scenes', relative: 'Alpha/Scenes' },
    { name: 'Beta', relative: 'Beta' },
  ];
  assert.deepStrictEqual(serverLink.overlapWarnings('Alpha', others).map((w) => w.kind).sort(),
    ['contains', 'duplicate']);
  assert.deepStrictEqual(serverLink.overlapWarnings('Alpha/Scenes/Act1', others).map((w) => w.kind).sort(),
    ['inside', 'inside']);
  assert.deepStrictEqual(serverLink.overlapWarnings('Gamma', others), []);
  // Case-insensitively, because the share may be.
  assert.ok(serverLink.overlapWarnings('alpha', others).some((w) => w.kind === 'duplicate'));
});

test('the composed link passes the studio\'s own submission validator', () => {
  /* THE ASSERTION THAT MATTERS MOST for Part C: the link the server fills into
     the submit form has to pass src/submission-link.js UNCHANGED — the same
     validator everything pasted by hand goes through. A link this feature
     composed that the submit endpoint then refused would leave an artist
     holding a form that rejects itself. */
  const submissionLink = require('../src/submission-link');
  for (const [prefix, relative] of [
    [UNC, 'Hero Quest/Artist/Ana Artist/walk-cycle.psd'],
    [UNC, 'Hero Quest/Artist/Ana Artist'],
    [POSIX, 'Hero/Animator/Sam/shot.aep'],
    [POSIX, 'Hero'],
    ['\\\\SERVER\\Projects', 'A/B/C/D/E/f.psd'],
  ]) {
    const link = serverLink.linkFor(prefix, relative);
    const out = submissionLink.validate(link);
    assert.ok(out.ok, `${link} was refused by the submission validator: ${out.error}`);
    assert.ok(['unc', 'posix'].includes(out.kind), `${link} classified as ${out.kind}`);
    assert.strictEqual(out.link, link, 'and stored exactly as composed');
  }
});
