# Web 端 AI 终端"乱码"修复：CJK 字符宽度不一致 (AI Terminal CJK Width Mismatch Fix)

- 日期：2026-05-12
- 范围：`src/pty.js`（PTY 子进程 env 兜底）+ `web/src/AiTerminalMini.tsx`（xterm Unicode 11 升级）+ `web/package.json`（新增 `@xterm/addon-unicode11`）+ 文档：`README.md`/`docs/troubleshooting`（描述新 env 开关）
- 后端：仅一处改动（`src/pty.js` env 块）
- 前端：仅一处改动（AiTerminalMini 初始化）+ 1 个新依赖

## 1. 背景与问题

用户反馈：web 嵌入 AI 终端跑 claude 时，TUI 排版错乱——分隔线 `————` 长度不对、文字标签插到分隔线中间、底部状态栏被切碎覆盖到内容里。同一个 claude 在本地 Terminal.app 跑则完全正常。

### 1.1 真正的根因（不是 mojibake，是列宽测量不一致）

- `web/src/AiTerminalMini.tsx` 用 `@xterm/xterm@5.5.0`，**未加载** `@xterm/addon-unicode11`，默认走 **Unicode 6** 宽度表 → "东亚歧义宽度（East Asian Ambiguous）"字符（em-dash `—`、ellipsis `…`、部分框线字符等）按 **1 列** 渲染。
- `src/pty.js:482` 拉子进程时 env 块只显式设置了 `TERM=xterm-256color` 和 `TZ`，**没有显式注入 `LANG`/`LC_CTYPE`**，完全继承自 AgentQuad 主进程。如果 AgentQuad 是从 zh_CN.UTF-8 的 shell 启动，子进程 wcwidth 把上述字符算成 **2 列**。
- 两端不一致：Claude 画"满行 `—————`"以为占 N 列，xterm 实际只铺 N/2 列；后续绝对光标移动落在错误位置 → 标签插入分隔线、状态栏切碎覆盖。
- 本地 Terminal.app 没事，是因为 macOS Terminal 默认按 CJK locale 把歧义当宽，与 Claude 一致。

### 1.2 为什么前面用户的"乱码"描述误导了诊断

第一轮 brainstorm 我们以为是字节级 mojibake（字体回退缺失 / locale 缺失 / UTF-8 chunk 边界截断），实际截图显示**字形都正确**，只是**位置错位**。最终方向是"两端宽度对齐"。

## 2. 目标

- web 嵌入终端跑 claude/codex TUI 含中英文、em-dash 分隔线、box-drawing 表格的内容，排版与本地 Terminal.app 视觉一致（人工目测）。
- 修复对所有走 PTY 的子进程（claude、codex、cursor、open-terminal shell）一视同仁。
- 提供 env 逃生舱 `AGENTQUAD_KEEP_CJK_LOCALE=1`，允许用户保留旧的 zh_CN.UTF-8 PTY 行为（极端兼容场景）。
- 不引入感知到的输入/输出延迟回归。

### 2.1 非目标

- 不做"动态歧义宽度切换 UI"（极端少数场景才需要）。
- 不去 monkey-patch xterm.js 内部 `unicodeService` 强行让歧义=wide（脆弱，未来 xterm 升级易崩）。如果方案 γ 仍不解决某些 TUI（例如 Codex 用自带宽度表完全无视 locale），再单开 spec 评估深度修。
- 不做 i18n 切换 / web UI 暴露这个开关。
- 不重写 `outputHistory` 存储结构（当前 string 存储已足够）。

## 3. 验收标准

- [ ] 同一个 prompt（让 Claude 输出含 `——————` 分隔线 + 中英文混排表格的 markdown），在 web 终端里：
  - 横线长度不超出可视区右边缘
  - 文字标签不插入到横线中间
  - 表格列与本地 Terminal.app 视觉一致
- [ ] 跑 `claude` TUI，底部状态栏 `Claude bypass permissions on (shift+tab to cycle)` 完整显示在一行不被切碎
- [ ] 把浏览器窗口宽度从 1920px 收缩到 800px，分隔线随之截断/延长，不再发生重叠（resize 链路无回归）
- [ ] codex 长输出（含中文段落 + 表格 + emoji）通过 web replay 重连后排版正确
- [ ] 设置 `AGENTQUAD_KEEP_CJK_LOCALE=1` 后重启 AgentQuad，PTY 子进程拿到的 `LC_CTYPE` 与主进程一致（即不被 spec 注入覆盖）；可通过在子进程跑 `env | grep LC_` 验证
- [ ] `npm run -w web build` 通过
- [ ] `npm test` 通过；新增针对 `src/pty.js` env 注入的单元测试
- [ ] 没有新增 web bundle 体积 > 50KB（addon-unicode11 自身约 30KB minified）

## 4. 设计

### 4.1 后端：PTY env 注入（src/pty.js）

修改点：`src/pty.js:482-488` 的 env 构造块。

**当前**：

```js
const env = {
  ...process.env,
  TERM: 'xterm-256color',
  TZ: process.env.TZ || 'America/Los_Angeles',
  FORCE_COLOR: '1',
  ...(extraEnv && typeof extraEnv === 'object' ? extraEnv : {}),
}
```

**改后**：

```js
const env = {
  ...process.env,
  TERM: 'xterm-256color',
  TZ: process.env.TZ || 'America/Los_Angeles',
  FORCE_COLOR: '1',
  ...resolvePtyLocaleEnv(process.env),
  ...(extraEnv && typeof extraEnv === 'object' ? extraEnv : {}),
}
```

**新增辅助函数**（同文件顶部，导出便于测试）：

```js
/**
 * 返回 PTY 子进程的 locale env override。目的：把 wcwidth 对齐到 xterm.js
 * (Unicode 11, East Asian Ambiguous = narrow)，避免 Claude/Codex TUI 在
 * zh_CN.UTF-8 主进程下把 em-dash / 框线字符当 2 列画，造成 web 终端排版错位。
 *
 * 规则：
 * - 若 AGENTQUAD_KEEP_CJK_LOCALE=1，原样不动（用户主动保留旧行为）。
 * - 若主进程 LC_CTYPE/LANG 已是 non-CJK UTF-8（en_*、C.UTF-8 等），不覆盖。
 * - 否则把 LANG + LC_CTYPE 兜底为 en_US.UTF-8。LC_ALL 不设——避免覆盖用户
 *   有意识设置的 LC_TIME / LC_MESSAGES 等。
 */
export function resolvePtyLocaleEnv(procEnv = process.env) {
  if (procEnv.AGENTQUAD_KEEP_CJK_LOCALE === '1') return {}

  const isNonCjkUtf8 = (val) => {
    if (!val) return false
    if (!/utf-?8/i.test(val)) return false
    if (/^(zh|ja|ko)[_.-]/i.test(val)) return false
    return true
  }

  // 用户已经显式给了 non-CJK UTF-8 locale，尊重用户选择
  if (isNonCjkUtf8(procEnv.LC_CTYPE) && isNonCjkUtf8(procEnv.LANG)) return {}

  return {
    LANG: isNonCjkUtf8(procEnv.LANG) ? procEnv.LANG : 'en_US.UTF-8',
    LC_CTYPE: isNonCjkUtf8(procEnv.LC_CTYPE) ? procEnv.LC_CTYPE : 'en_US.UTF-8',
  }
}
```

**注意**：`...resolvePtyLocaleEnv(process.env)` 必须放在 `...process.env` **之后**、`...extraEnv` **之前**，确保：
- 能覆盖父进程继承的 CJK LANG；
- 不会覆盖调用方通过 `extraEnv` 显式指定的 locale（兼容 openclaw / orchestrator 的特殊场景）。

**同步改动**：`src/pty.js:721-727` 的 `startShell` 分支（本地 shell 命令）也用同一函数，保持一致。

### 4.2 前端：xterm Unicode 11 升级（web/src/AiTerminalMini.tsx）

**新增依赖**：`web/package.json` → `@xterm/addon-unicode11@^0.8.0`（与 `@xterm/xterm@5.5.0` 兼容）。

**改动位置**：`web/src/AiTerminalMini.tsx` 的 Terminal 初始化处（围绕现有 `CanvasAddon` / `FitAddon` 的加载位置）：

```ts
import { Unicode11Addon } from '@xterm/addon-unicode11'

// 在 term = new Terminal(...) 之后、loadAddon(fit/canvas) 之前/之后均可：
term.loadAddon(new Unicode11Addon())
term.unicode.activeVersion = '11'
```

**为什么这一步还是要做**：即使方案 α（locale 注入）解决了 90%+ 场景，仍可能遇到：
- 工具自带宽度表无视 locale（罕见但存在）
- 输出里出现 Unicode 11 才新增的码点（emoji 序列等）

升级 xterm 到 Unicode 11 是无副作用的基础升级，长期有益。

### 4.3 文档：README + troubleshooting

在 `README.md` 故障排查段（如不存在则新增）增加一节：

```markdown
### Web 终端排版错乱（横线/框线/中英文混排错位）

AgentQuad 默认会把 PTY 子进程的 LANG/LC_CTYPE 兜底为 `en_US.UTF-8`，
以避免 CJK locale 下 wcwidth 把歧义字符当 2 列、与 xterm.js 不一致。

如需保留原 CJK locale，设置环境变量：

  AGENTQUAD_KEEP_CJK_LOCALE=1 npm start

```

### 4.4 测试策略

**单元测试**（`test/pty-locale-env.test.js`，vitest）：

- `resolvePtyLocaleEnv({})` → `{ LANG: 'en_US.UTF-8', LC_CTYPE: 'en_US.UTF-8' }`
- `resolvePtyLocaleEnv({ LANG: 'zh_CN.UTF-8', LC_CTYPE: 'zh_CN.UTF-8' })` → 兜底为 en_US.UTF-8
- `resolvePtyLocaleEnv({ LANG: 'en_US.UTF-8', LC_CTYPE: 'en_US.UTF-8' })` → `{}`（不覆盖）
- `resolvePtyLocaleEnv({ LANG: 'ja_JP.UTF-8' })` → 兜底
- `resolvePtyLocaleEnv({ AGENTQUAD_KEEP_CJK_LOCALE: '1', LANG: 'zh_CN.UTF-8' })` → `{}`（逃生舱生效）
- `resolvePtyLocaleEnv({ LANG: 'POSIX' })` → 兜底（非 UTF-8 也兜底，避免 ?? 输出）

**手工冒烟**（PR 描述里列清单）：

- 用 zh_CN.UTF-8 启 AgentQuad，跑 claude 出含分隔线 + 表格的 markdown，对比修复前后截图。
- 用同一 prompt 比对本地 Terminal.app 与 web 终端。
- 设 `AGENTQUAD_KEEP_CJK_LOCALE=1`，验证 web 终端复现旧的错位现象（证明逃生舱有效）。
- 浏览器窗口 resize：分隔线长度跟随调整、无残留。

**E2E**（可选，不阻塞合并）：

如果有 playwright harness，加一个截图回归 case：在 web 终端写一段固定的 `printf` 输出含 `─────` + 中文，对比基线截图。

## 5. 风险与边界情况

### 5.1 主要风险

- **风险 R1**：claude/codex/cursor 自带宽度表，无视 `LC_CTYPE` → 方案 α 不生效，只剩 β（xterm 升级）能起部分作用。
  - **检验方法**：实施后先单独验证 α 是否生效（设 `LANG=en_US.UTF-8` 跑一遍，看排版是否变好）；如不变，挂"已知问题"标签，单开 spec 评估 monkey-patch 方案。
- **风险 R2**：用户的工作流确实依赖 CJK locale 在子进程里（比如他在 claude 里跑 `date` 拿中文日期）。
  - **缓解**：`AGENTQUAD_KEEP_CJK_LOCALE=1` 逃生舱。
- **风险 R3**：`en_US.UTF-8` 在某些 Linux 容器里没装。
  - **缓解**：方案 α 的副作用是"如果该 locale 未装，glibc 会回退到 C，输出可能损失颜色但不会更糟"。如果实施时发现严重，再加 `C.UTF-8` fallback 链。
- **风险 R4**：addon-unicode11 与现有 CanvasAddon 加载顺序敏感。
  - **缓解**：参考 xterm-addon-unicode11 README，确保在 Terminal 实例化后立刻 `loadAddon` 并切 `activeVersion`，再 loadAddon canvas/fit。

### 5.2 不影响范围

- IM 推送链路（lark / telegram）不读 PTY 字符宽度，与本改动无关。
- openclaw bridge / sidecar 是独立读 jsonl 拿数据的，不走 PTY，也无关。
- `outputHistory` 存的是 utf-8 解码后字符串，无需变更。

## 6. 实施步骤（粗粒度，详细任务由 plan 阶段拆）

1. 新增 `resolvePtyLocaleEnv()` + 单元测试（test 先红后绿，TDD）。
2. 接入 `src/pty.js` 的两处 env 构造（spawn + startShell）。
3. 装 `@xterm/addon-unicode11`，在 `AiTerminalMini.tsx` 加载并切版本。
4. 文档（README + troubleshooting 段）。
5. 手工冒烟（修复前后截图 + 逃生舱验证）。
6. 提 PR。

## 7. 未决问题（spec 评审时确认）

- [ ] 兜底 locale 值：`en_US.UTF-8`（默认） vs `C.UTF-8`？
- [ ] 逃生舱变量名：`AGENTQUAD_KEEP_CJK_LOCALE=1`（默认） vs `AGENTQUAD_PTY_LANG=<value>` 直接指定？
- [ ] 注入哪些变量：`LANG + LC_CTYPE`（默认） vs 也设 `LC_ALL`？
