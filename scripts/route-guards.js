#!/usr/bin/env node
/* EVERY API ROUTE IN FORGE, AND WHAT GUARDS IT — read out of the source.
 *
 * ===========================================================================
 * WHY A PARSER AND NOT A LIST SOMEBODY MAINTAINS. A hand-written list of routes
 * is wrong the first week: the question this answers — "is there a route
 * anywhere that changes something and asks nobody's permission?" — is only
 * worth asking if the answer comes from the code. So this reads the routers.
 *
 * WHAT IT READS. src/server.js for the mounts (app.use('/api/x', xRoutes)) and
 * each src/routes/*.js for its router-level middleware (router.use(...)) and
 * its per-route middleware (router.get('/p', requirePermission('k'), ...)).
 *
 * WHAT IT CANNOT READ, and says so rather than guessing: a guard applied inside
 * a handler — `if (!can(req, 'x')) return res.status(403)`, or a membership
 * check like chat's mine() — is reported as `inline` with the names it found,
 * because a static reader cannot know whether an `if` on line 40 covers the
 * write on line 90. The manifest in src/route-manifest.js is where each of
 * those is stated deliberately, and tests/route-manifest.test.js compares the
 * two so a new route cannot ship unlisted.
 *
 * Run it: node scripts/route-guards.js [--json]
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const ROUTES_DIR = path.join(ROOT, 'src', 'routes');

const MUTATING = new Set(['post', 'put', 'patch', 'delete']);

/* The guard helpers this application uses, and what each one means. Anything
   else that appears in a middleware position is reported verbatim. */
const GUARD_PATTERNS = [
  /* A KEY IS OFTEN A CONSTANT, not a literal: src/routes/holidays.js says
     requirePermission(MANAGE). The first version of this matched literals only
     and reported eight guarded routes as unguarded — including a DELETE — which
     is exactly the kind of false alarm that makes an audit worthless. Local
     `const NAME = 'key'` declarations are resolved by constantsIn() below. */
  [/requirePermission\(\s*([A-Za-z_$][\w$.]*|'[^']+')\s*\)/g, (m, consts) => {
    const raw = m[1];
    const key = raw.startsWith("'") ? raw.slice(1, -1) : (consts[raw] || `?${raw}`);
    return `permission:${key}`;
  }],
  [/requireAnyPermission\(\s*([^)]*)\)/g, (m, consts) => {
    const parts = m[1].split(',').map((x) => x.trim()).filter(Boolean)
      .map((x) => (x.startsWith("'") ? x.slice(1, -1) : (consts[x] || `?${x}`)));
    return `permission-any:${parts.join('|')}`;
  }],
  [/requireSuperAdmin/g, () => 'super-admin'],
  /* A NAMED LOCAL MIDDLEWARE IS A GUARD, and several routers have one:
     src/routes/pnl.js writes `router.put('/role-rates/:roleKey', mayWrite, …)`.
     Reported by name rather than resolved — what it checks is the manifest's
     business — because "there is a middleware here called mayWrite" and "there
     is nothing here" are different findings and an audit that confused them
     reported five guarded writes as unguarded. */
  [/,\s*([a-z][\w$]*(?:\.[\w$]+)?)\s*(?=,)/g, (m) => {
    const name = m[1];
    if (['authenticate', 'requireSuperAdmin', 'serviceAuth', 'db', 'res', 'req', 'next'].includes(name)) return null;
    return `middleware:${name}`;
  }],
  [/serviceAuth/g, () => 'service-credential'],
  [/authenticate/g, () => 'authenticated'],
];

/* `const MANAGE = 'settings.holidays'` and friends, so a guard written with a
   constant reads as the key it is — and `roleGroups.MANAGE_KEY`, which is a
   property of a required module and is resolved by requiring it. Both forms are
   in the tree, and a reader that understood neither reported a DELETE and four
   PUTs as unguarded when every one of them is behind a permission. */
function constantsIn(text) {
  const out = {};
  const re = /const\s+([A-Z][A-Z0-9_]*)\s*=\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(text))) out[m[1]] = m[2];

  /* A DOTTED GUARD — roleGroups.MANAGE_KEY — is resolved by READING the module
     it comes from, never by requiring it: requiring src/db.js (which several
     modules pull in) prints a configuration error and exits the process, so a
     script that audits guards would be a script that cannot run outside a
     configured deployment. Static text, no execution. */
  const req = /const\s+(?:\{\s*([^}]*)\s*\}|(\w+))\s*=\s*require\('([^']+)'\)/g;
  while ((m = req.exec(text))) {
    const [, destructured, variable, from] = m;
    if (!from.startsWith('.')) continue;
    const file = path.join(ROUTES_DIR, `${from}.js`);
    let modText = null;
    try { modText = fs.readFileSync(file, 'utf8'); } catch { modText = null; }
    if (!modText) continue;
    const literals = {};
    for (const re of [/const\s+([A-Za-z_$][\w$]*)\s*=\s*'([^']+)'/g, /^\s*([A-Za-z_$][\w$]*):\s*'([^']+)',/gm]) {
      re.lastIndex = 0;
      let x;
      while ((x = re.exec(modText))) literals[x[1]] = x[2];
    }
    if (variable) {
      for (const [k, v] of Object.entries(literals)) out[`${variable}.${k}`] = v;
    } else if (destructured) {
      for (const name of destructured.split(',').map((y) => y.trim().split(':')[0]).filter(Boolean)) {
        if (literals[name]) out[name] = literals[name];
      }
    }
  }
  return out;
}

function guardsIn(text, consts = {}) {
  const found = [];
  for (const [re, label] of GUARD_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      const got = label(m, consts);
      if (got) found.push(got);
    }
  }
  return [...new Set(found)];
}

/* Where each router is mounted. Several routers are mounted more than once (the
   chat settings router answers on two paths, and mis-access on two), which is
   why this is a list per file rather than one string. */
function mounts() {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'server.js'), 'utf8');
  const names = new Map();                       // variable name -> routes file
  const re = /const\s+(\w+)\s*=\s*require\('\.\/routes\/([\w-]+)'\)/g;
  let m;
  while ((m = re.exec(src))) names.set(m[1], m[2]);

  const out = new Map();                         // file -> [{prefix, property}]
  /* MULTI-LINE MOUNTS COUNT. The integration API is mounted as
     app.use('/api/integration/v1',\n  ipGate,\n  limiter,\n  serviceAuth,\n
     integrationRoutes); — the first version of this matched one line and
     reported every integration route as "not mounted". The arguments are read
     up to the closing paren, and any router variable among them is a mount. */
  const useRe = /app\.use\(\s*'([^']+)'\s*,([\s\S]*?)\);\n/g;
  while ((m = useRe.exec(src))) {
    const prefix = m[1];
    const args = m[2] || '';
    const mountGuards = guardsIn(args, {});
    for (const [variable, file] of names) {
      const re = new RegExp(`\\b${variable}(\\.(\\w+))?\\b`);
      const hit = args.match(re);
      if (!hit) continue;
      if (!out.has(file)) out.set(file, []);
      out.get(file).push({ prefix, property: hit[2] || null, mountGuards });
    }
  }
  return out;
}

function routesOf(file) {
  const text = fs.readFileSync(path.join(ROUTES_DIR, file), 'utf8');
  const lines = text.split('\n');

  /* ROUTER-LEVEL MIDDLEWARE, in order. `router.use(authenticate)` before any
     route guards every route below it; a second router in the same file (the
     chat settings file has two) keeps its own. */
  const routerGuards = new Map();                // router variable -> [guards]
  const declared = [...text.matchAll(/const\s+(\w+)\s*=\s*asyncRouter\(\)/g)].map((x) => x[1]);
  for (const name of declared) routerGuards.set(name, []);

  const consts = constantsIn(text);
  const routes = [];
  lines.forEach((line, i) => {
    const use = line.match(/^\s*(\w+)\.use\((.*)$/);
    if (use && routerGuards.has(use[1])) {
      routerGuards.get(use[1]).push(...guardsIn(use[2], consts));
      return;
    }
    const route = line.match(/^\s*(\w+)\.(get|post|put|patch|delete)\(\s*(\[[^\]]*\]|'[^']*')\s*(,.*)?$/);
    if (!route) return;
    const [, variable, method, rawPath, rest] = route;
    if (!routerGuards.has(variable)) return;
    /* THE MIDDLEWARE ARGUMENTS ONLY, never the handler body — but across LINES,
       because a route with two guards wraps:
         router.post('/x',
           requirePermission('k'),
           async (req, res) => {
       Everything from the path to the first `async (` or `(req` is a middleware
       position, wherever the newlines fall. */
    const fromHere = lines.slice(i, i + 12).join('\n');
    const afterPath = fromHere.slice(fromHere.indexOf(rawPath) + rawPath.length);
    const middleware = afterPath.split(/async\s*\(|\(\s*req\b/)[0];
    const paths = rawPath.startsWith('[')
      ? [...rawPath.matchAll(/'([^']*)'/g)].map((x) => x[1])
      : [rawPath.slice(1, -1)];
    for (const p of paths) {
      routes.push({
        router: variable,
        method: method.toUpperCase(),
        routePath: p,
        line: i + 1,
        routeGuards: guardsIn(middleware, consts),
        routerGuards: [...routerGuards.get(variable)],
      });
    }
  });
  return { routes, text };
}

/* Does the handler check anything itself? Reported, never trusted — see the
   note at the top. The window is the lines from this route to the next one. */
function inlineGuards(text, fromLine, toLine) {
  const body = text.split('\n').slice(fromLine - 1, (toLine || fromLine + 200) - 1).join('\n');
  const found = [];
  for (const [re, label] of [
    [/can\(req,\s*'([^']+)'/g, (m) => `inline-can:${m[1]}`],
    [/\bmine\(req/g, () => 'inline-membership'],
    [/visibleProjects\(/g, () => 'inline-project-scope'],
    [/req\.user\.id/g, () => 'inline-self'],
    [/requireSuperAdmin|isSuperAdmin/g, () => 'inline-super-admin'],
    [/\btier\b|capabilities\./g, () => 'inline-tier'],
    /* THE HANDLER-LEVEL PREDICATES THIS APPLICATION ACTUALLY USES. assets.js
       decides a delete with canDeleteAsset(req.user, asset) — a function of the
       person AND the row, which no middleware could express — and several
       screens answer 403 from inside a helper. Reported by name so the manifest
       can state which rule each route really leans on. */
    [/can[A-Z]\w*\(/g, (m) => `inline-predicate:${m[0].slice(0, -1)}`],
    [/mayEdit|mayWriteTo|requireOwn|assertSelf/g, (m) => `inline-predicate:${m[0]}`],
    /* THE ASSET WORKFLOW DECIDES ITS OWN TRANSITIONS. assets.js routes call
       workflow.evaluate('deliver', ctx) and refuse on the verdict — the rule is
       a table in src/asset-workflow.js keyed by stage and permission, which no
       middleware could express. */
    [/workflow\.evaluate\(/g, () => 'inline-workflow'],
    /* A HELPER THAT TAKES (req, res) AND MAY ANSWER. assets.js opens several
       routes with `const asset = await thumbnailGuard(req, res); if (!asset)
       return;` — the refusal is inside the helper. Catching the shape rather
       than each name: a reader that needs a new pattern per helper is a reader
       that will be out of date by the next prompt. */
    [/\b([a-z]\w*)\(req,\s*res[,)]/g, (m) => `inline-gate:${m[1]}`],
    [/applyTransition\(/g, () => 'inline-workflow'],
  ]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(body))) found.push(label(m));
  }
  return [...new Set(found)];
}

function collect() {
  const mounted = mounts();
  const out = [];
  for (const file of fs.readdirSync(ROUTES_DIR).filter((f) => f.endsWith('.js'))) {
    const key = file.replace(/\.js$/, '');
    const where = mounted.get(key) || [];
    const { routes, text } = routesOf(file);
    routes.forEach((r, idx) => {
      const next = routes[idx + 1];
      const inline = inlineGuards(text, r.line, next ? next.line : null);
      /* A file mounted at two prefixes produces a row per prefix: the same
         handler reached by two paths is two routes as far as a guard audit is
         concerned. A router exported as a property (chatSettings.policy) is
         matched by name. */
      const places = where.length ? where : [{ prefix: `(not mounted: ${key})`, property: null }];
      for (const place of places) {
        if (place.property && place.property !== r.router) continue;
        if (!place.property && r.router !== 'router' && where.some((w) => w.property === r.router)) continue;
        out.push({
          id: `${r.method} ${place.prefix}${r.routePath === '/' ? '' : r.routePath}`,
          method: r.method,
          path: `${place.prefix}${r.routePath === '/' ? '' : r.routePath}`,
          file: `src/routes/${file}`,
          line: r.line,
          mutating: MUTATING.has(r.method.toLowerCase()),
          guards: [...new Set([...(place.mountGuards || []), ...r.routerGuards, ...r.routeGuards])],
          inline,
        });
      }
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/* THE REPORT RUNS ONLY WHEN THIS FILE IS THE PROGRAM. Without the guard,
   requiring it — which scripts/permission-snapshot.js and the manifest test
   both do — printed a hundred-line audit into their output. */
const rows = require.main === module ? collect() : [];
if (require.main !== module) {
  // required as a module: nothing is printed
} else if (process.argv.includes('--json')) {
  process.stdout.write(`${JSON.stringify(rows, null, 1)}\n`);
} else {
  const permissionOf = (r) => r.guards.filter((g) => g.startsWith('permission')).join(' ');
  const unguarded = rows.filter((r) => !permissionOf(r) && !r.guards.includes('super-admin'));
  console.log(`${rows.length} routes in ${new Set(rows.map((r) => r.file)).size} routers`);
  console.log(`${rows.filter((r) => r.mutating).length} mutating`);
  console.log(`${unguarded.length} with no permission or super-admin guard in a middleware position:`);
  for (const r of unguarded) {
    console.log(`  ${r.mutating ? 'WRITE' : 'read '} ${r.id}  [${r.inline.join(', ') || 'nothing found inline'}]`);
  }
}
module.exports = { collect };
