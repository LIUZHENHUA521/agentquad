# Release smoke test

Run before each `npm publish`.

## Prep

- [ ] On a clean branch, `git status` is clean
- [ ] `web/node_modules` exists (or trust prepack to install it via `ensure-web-deps`)

## Pack

- [ ] `npm pack`
- [ ] `tar tf quadtodo-*.tgz | grep -E 'package/(src/cli\.js|dist-web/index\.html|package\.json)$'` → all 3 must hit
- [ ] tgz size sanity: `ls -lh quadtodo-*.tgz` (baseline < 5MB before frontend; total ~hundreds of KB to a few MB)

## Install (do this in a clean dir, NOT the repo)

- [ ] `mkdir /tmp/qt-test && cd /tmp/qt-test`
- [ ] `npm i /path/to/quadtodo-*.tgz` — completes without `gyp`/`make` lines (= prebuild used)
- [ ] Repeat once on Node 20 and once on Node 22 / 24 (use nvm)

## Run

- [ ] `quadtodo doctor` — all 8 checks green (Node version, frontend assets, better-sqlite3, node-pty, claude, codex, cursor binary if configured, plus rootDir / config.json)
- [ ] `quadtodo install-tools --all -y` — installs cleanly; final lines show `✓ claude → ...` and `✓ codex → ...`
- [ ] `quadtodo doctor` again — claude / codex now green
- [ ] `quadtodo start` — banner shows port; browser opens
- [ ] Create a todo → open AI terminal with claude → type `pwd` → see response

## Tool-missing UX (regression check)

- [ ] `quadtodo config set tools.claude.bin /tmp/__no_such_bin`
- [ ] Restart, try to start a claude session → yellow card with `quadtodo install-tools --claude` + Copy button
- [ ] `quadtodo config set tools.claude.bin claude` (reset)

## Publish

- [ ] `npm publish --dry-run` — review file list one more time
- [ ] `npm publish`
- [ ] `npm view quadtodo version` matches what we shipped
- [ ] In a clean dir: `npx quadtodo@<new-version> doctor` — works end-to-end from registry
