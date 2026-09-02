# Documentation

Two deliverables, both built from a running instance rather than typed by hand.

| File | What it is |
| --- | --- |
| `ZVKY-FORGE-User-Manual.docx` | The full manual: every screen, as steps somebody can follow, with role-access notes and three appendices. 56 pages. |
| `ZVKY-FORGE-Overview.pptx` | The induction deck: roughly one slide per module. 27 slides. |

Open them in Word and PowerPoint. The manual's table of contents is a field that
Word refreshes when the document opens; if it ever looks blank, `Ctrl+A` then `F9`.

## Why it is generated

The two things in documentation that go stale fastest are the pictures and the
permission tables. Both are produced here from a live deployment on every build,
so a rebuild cannot leave last month's screenshot or last month's role behind.

- `build/shoot.js` signs in as each demo designation and drives the real buttons,
  writing 42 captures into `shots/`.
- `build/crop.js` trims each capture to its content, in place.
- `build/roles-table.js` reads the permission table out of a deployment and
  writes `build/roles-table.json`.
- `build/bands.js` groups the 58 permissions into the twelve distinct sets of
  holders the manual calls access bands, and fails loudly if the catalogue has
  changed shape.
- `build/content.js` is the manual's prose. It names screenshots and access
  bands; it never repeats a designation list.
- `build/build-docx.js` and `build/build-pptx.js` render the two files.

## Rebuilding

`docx` and `pptxgenjs` are devDependencies, so `npm install` is enough for the
last step. Re-taking the screenshots additionally needs Playwright and a demo
instance.

```bash
# 1. The permission tables, from a pristine deployment (what the software ships with).
#    Set DOCS_DB to describe a particular studio's configuration instead.
node docs/build/roles-table.js

# 2. The two files.
node docs/build/build-docx.js
node docs/build/build-pptx.js
```

To re-take the screenshots as well, stand up a demo instance on port 4415, run
the `build/seed*.js` scripts in order to populate it, then:

```bash
node docs/build/shoot.js     # 42 captures into docs/shots
node docs/build/crop.js      # trims each to its content, in place
```

`shoot.js` puts the demo state back before it starts, so it can be run twice.

## Keeping it current

Updating this documentation is part of shipping a feature, not a job afterwards.
When a feature ships, four things bring it up to date:

1. A section in the right chapter of `build/content.js`, written as steps.
2. A screenshot, added to `build/shoot.js` so it is re-taken on every build.
3. A role note naming the access band — the permission tables already know
   about the new permission, so this is one line.
4. A slide in `build/build-pptx.js`, if it is something a new joiner needs to
   know exists.

## The demo studio in the screenshots

Two clients, three projects, thirteen assets across every stage, seven people:
Priya Nair (Super Admin), Rahul Menon (Team Lead), Ananya Rao (Creative Art
Director), Vikram Shah (Producer), Meera Iyer and Arjun Das (Game Artists) and
Kavya Reddy (Game Animator). Nothing in either file is a mock-up.
