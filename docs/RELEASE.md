# Release smoke test

Run before each `npm publish`.

## Prep

- [ ] On a clean branch, `git status` is clean
- [ ] `web/node_modules` exists (or trust prepack to install it via `ensure-web-deps`)

## Pack

- [ ] `npm pack`
- [ ] `tar tf agentquad-*.tgz | grep -E 'package/(src/cli\.js|dist-web/index\.html|package\.json)$'` → all 3 must hit
- [ ] tgz size sanity: `ls -lh agentquad-*.tgz` (baseline < 5MB before frontend; total ~hundreds of KB to a few MB)

## Install (do this in a clean dir, NOT the repo)

- [ ] `mkdir /tmp/aq-test && cd /tmp/aq-test`
- [ ] `npm i /path/to/agentquad-*.tgz` — completes without `gyp`/`make` lines (= prebuild used)
- [ ] Repeat once on Node 20 and once on Node 22 / 24 (use nvm)

## Run

- [ ] `agentquad doctor` — all 8 checks green (Node version, frontend assets, better-sqlite3, node-pty, claude, codex, cursor binary if configured, plus rootDir / config.json)
- [ ] `agentquad install-tools --all -y` — installs cleanly; final lines show `✓ claude → ...` and `✓ codex → ...`
- [ ] `agentquad doctor` again — claude / codex now green
- [ ] `agentquad start` — banner shows port; browser opens
- [ ] Create a todo → open AI terminal with claude → type `pwd` → see response
- [ ] Verify `quadtodo` legacy alias still works: `quadtodo doctor` should produce identical output to `agentquad doctor`

## Tool-missing UX (regression check)

- [ ] `agentquad config set tools.claude.bin /tmp/__no_such_bin`
- [ ] Restart, try to start a claude session → yellow card with `agentquad install-tools --claude` + Copy button
- [ ] `agentquad config set tools.claude.bin claude` (reset)

## Publish

- [ ] `npm publish --dry-run` — review file list one more time
- [ ] `npm publish`
- [ ] `npm view agentquad version` matches what we shipped
- [ ] In a clean dir: `npx agentquad@<new-version> doctor` — works end-to-end from registry

---

## 0.3.0 发版前清单（一键启动版）

- [ ] 仓库根目录无 `*.tgz`（删旧的 `quadtodo-*.tgz` / `agentquad-*.tgz`）
- [ ] `.gitignore` 已含 `*.tgz`
- [ ] `package.json` version = `0.3.0`
- [ ] `npm pack --dry-run` 列表确认：
  - 含 `src/cli.js` / `src/server.js` / `src/first-run-wizard.js`
  - 含 `dist-web/index.html`
  - **不**含 `node_modules/` / `web/node_modules/` / `tmp/` / `*.test.js` / `mira-proxy/`
  - tarball 体积 < 10 MB
- [ ] 干净目录 `npm i -g ./agentquad-0.3.0.tgz` 无 native 编译错
- [ ] `agentquad --version` = `0.3.0`
- [ ] **裸跑测试**：`mv ~/.agentquad ~/.agentquad.bak && agentquad`
  - 弹出首跑向导
  - 同意安装 claude/codex 后服务起来
  - 浏览器自动打开看板
- [ ] **二次跑**：`agentquad`，不再问向导，直接起服务
- [ ] **未知子命令**：`agentquad strat` 报错退出，不会静默起服务
- [ ] **端口重试**：`nc -l 127.0.0.1 5677 &` 占住 → `agentquad` 应自动用 5678
- [ ] **pid 文件 JSON**：`cat ~/.agentquad/agentquad.pid` 是 JSON，包含 `pid` / `port` / `host` / `startedAt`
- [ ] `agentquad stop` 正确停服 + 清理 pid 文件
- [ ] **break 说明已写入 README 故障排除**：0.3.0 起 pid 文件改 JSON，用户应使用 `agentquad stop` 而非手动 `kill $(cat pid)`
- [ ] `quadtodo` alias 行为与 `agentquad` 一致（同一份 cli.js 验证）
- [ ] `npm publish --dry-run` 列表最终确认
- [ ] `npm publish`
- [ ] `npm view agentquad version` = `0.3.0`
