# [OPEN] telegram-fetch-failed

## Symptom
- Telegram bot 长轮询、自动建 topic、`setMyCommands` 全部报 `fetch failed`
- 现象为之前可用，现在失败

## Initial Hypotheses
- H1: 当前运行进程实际仍在使用旧的 Node 18 环境，导致 `fetch` 在 IPv6 路径超时
- H2: 当前启动方式没有继承 `NODE_OPTIONS=--dns-result-order=ipv4first`，导致 Node 解析顺序变化
- H3: Telegram 相关请求在不同代码路径使用了不同的 `fetch` / `undici` 实现，部分路径未命中之前有效的规避手段
- H4: 当前运行中的 `quadtodo` 不是最新启动的这一份，而是旧进程或旧软链指向的旧环境
- H5: 最近网络环境变化导致 IPv6/TLS/代理链路退化，`curl` 可通但 Node 运行时请求失败

## Evidence Plan
- 确认当前实际运行进程的 Node 版本与启动命令
- 确认项目启动日志与 `fetch failed` 的完整错误上下文
- 用最小复现脚本对比默认 `fetch` 与 `ipv4first` 行为
- 检查当前 shell / 进程环境中的 `NODE_OPTIONS`、代理变量、软链指向

## Status
- Session opened

## Evidence
- `ps` 显示实际运行进程为 `node /Users/bytedance/.nvm/versions/node/v20.20.2/bin/quadtodo start`
- 当前 shell 中 `quadtodo` 软链仍指向 `v18.20.3` 下的全局安装，存在命令环境与实际运行进程不一致
- `~/.quadtodo/logs/quadtodo.log` 显示：
  - `2026-05-03T12:03` 左右 Telegram API 还能返回业务错误：`chat is not a forum`、`not enough rights to create a topic`
  - `2026-05-03T12:53` 到 `13:23` 之间退化为统一的 `fetch failed`
  - `2026-05-03T13:24` 后恢复为业务错误，并在 `13:26` 连续成功 `auto-bound session -> topic`
- 运行中服务接口 `POST /api/config/telegram/test` 当前返回 `ok: true`，`getMe()` 成功
- 独立命令验证中，`curl -I https://api.telegram.org` 和 `Node v20 fetch('https://api.telegram.org')` 当前都成功

## Hypothesis Status
- H1 rejected: 当前主服务不是 Node 18，实际运行进程是 Node 20
- H2 inconclusive: 当前进程环境未见 `NODE_OPTIONS=--dns-result-order=ipv4first`，但现在 Node 20 直连已恢复
- H3 partially supported: 故障窗口内多个 Telegram API 路径同时报 `fetch failed`，说明是公共传输层问题，不是单个业务接口问题
- H4 supported: 当前 shell/全局软链与实际运行服务环境不一致，容易造成“看起来切了版本但命令还落旧环境”的错觉
- H5 supported: 故障具有明显时间窗口，前后都能访问 Telegram API，中间统一 `fetch failed`，更像网络/解析链路瞬时退化后恢复

## Interim Conclusion
- 本次现象的主因更像运行时网络/解析链路短时异常，而非 token 失效或业务代码永久损坏
- 另有一个独立问题：你的 shell 里 `quadtodo` 仍然指向 Node 18 的全局安装，和实际运行中的 Node 20 服务不一致，增加了排查噪音

## Hook / Telegram Follow-up
- `hook` 已确认安装：
  - `~/.claude/settings.json` 中存在 `Stop / Notification / SessionEnd` 的 quadtodo entry
  - `node src/cli.js openclaw hook-status` 返回 `hooks installed: true`
- `hook` 已确认触发：
  - 运行日志中多次出现 `[openclaw-hook] hook fired ...`
- 当前配置下 hook 推送会被 bridge 直接拒绝：
  - `~/.quadtodo/config.json` 里 `openclaw.enabled = false`
  - 直接调用运行中服务的 `POST /api/openclaw/hook` 返回 `{"ok":false,"reason":"disabled"}`
- 这说明“Claude hook 没装”不是主因；真实问题是：
  - hook 到了 quadtodo
  - 但 quadtodo 的 hook 推送链路依赖 `openclawBridge.postText()`
  - 而 `openclawBridge.postText()` 在 `openclaw.enabled=false` 时直接返回 `disabled`
- 另一个代码级风险点：
  - Telegram wizard 创建 session 时，`registerSessionRoute()` 传入的 route `channel` 仍是 `null`
  - 持久化到 DB 的 `telegramRoute.channel` 才是 `'telegram'`
  - 因此“刚创建完、尚未重启重注册”的 live session，hook 推送有机会走错 channel 解析路径

## Config Mismatch Evidence
- 用户修改的是仓库内文件：`/Users/bytedance/Desktop/code/quadtodo/.quadtodo/config.json`
- 当前运行中服务的实际配置来自：`/Users/bytedance/.quadtodo/config.json`
- 运行中 `GET /api/config` 返回 `openclaw.enabled = false`
- 运行进程环境中未发现 `QUADTODO_ROOT_DIR`，因此按默认逻辑会走 `~/.quadtodo`
- 结论：用户这次把 `openclaw.enabled` 改到了“项目内样例/本地文件”，没有改到当前 5670 服务实际生效的配置
