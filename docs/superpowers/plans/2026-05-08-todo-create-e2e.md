# Todo Create E2E Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a real Playwright E2E test that verifies a user can create a todo through the quadtodo web UI using an isolated local backend/database.

**Architecture:** Playwright owns the browser flow and starts the built quadtodo server through `webServer`. A fixture manifest documents the isolated runtime requirements for the ai-coding-e2e-harness CLI. The test uses a per-run `QUADTODO_ROOT_DIR`/`--cwd` temp directory so `/api/todos` writes to an isolated SQLite database instead of the user's normal data.

**Tech Stack:** Node 20 ESM, Express, React/Ant Design, Vitest, Playwright, ai-coding-e2e-harness CLI.

---

## File Structure

- Create `playwright.config.ts`: minimal Playwright config, web server startup, trace/screenshot policy, and E2E env defaults.
- Create `test/e2e/todo-create.spec.ts`: browser test for creating one todo through the UI and confirming backend persistence.
- Create `test/e2e/fixtures/todo-create.fixture.json`: harness fixture manifest with base URL, isolated temp/root directory, backend command, and explicit non-required auth/business ID entries.
- Create `test/e2e/artifacts/.gitkeep`: stable artifact directory for snapshot/report outputs.
- Modify `package.json`: add `test:e2e`, `test:e2e:ui`, and Playwright dev dependency.
- Modify `package-lock.json`: dependency lockfile update from `npm install --save-dev @playwright/test`.
- Existing product files should not change unless a valid product RED proves the flow is broken.

## Task 1: Install Playwright and add scripts

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Install the test dependency**

Run:

```bash
npm install --save-dev @playwright/test
```

Expected: `package.json` gains `@playwright/test` under `devDependencies`, and `package-lock.json` updates.

- [ ] **Step 2: Add E2E scripts**

Edit `package.json` so the `scripts` block includes these entries after `test:watch`:

```json
"test:e2e": "playwright test",
"test:e2e:ui": "playwright test --ui"
```

The resulting scripts block should keep existing scripts and include:

```json
{
  "start": "node src/cli.js start",
  "start:expose": "node src/cli.js start --expose",
  "stop": "node src/cli.js stop",
  "status": "node src/cli.js status",
  "doctor": "node src/cli.js doctor",
  "config": "node src/cli.js config",
  "mira:proxy": "cd mira-proxy && node server.js",
  "claude:mira": "./claude-mira.sh",
  "test": "vitest run",
  "test:watch": "vitest",
  "test:e2e": "playwright test",
  "test:e2e:ui": "playwright test --ui",
  "telegram:setup-menu": "node scripts/setup-telegram-commands.js",
  "telegram:clear-menu": "node scripts/setup-telegram-commands.js --clear",
  "build": "npm run build:web",
  "build:web": "cd web && npm run build",
  "prepack": "npm run build"
}
```

- [ ] **Step 3: Verify package scripts are valid JSON**

Run:

```bash
node -e "JSON.parse(require('node:fs').readFileSync('package.json','utf8')); console.log('package json ok')"
```

Expected: prints `package json ok`.

## Task 2: Add fixture manifest and artifact directory

**Files:**
- Create: `test/e2e/fixtures/todo-create.fixture.json`
- Create: `test/e2e/artifacts/.gitkeep`

- [ ] **Step 1: Create the fixture manifest**

Create `test/e2e/fixtures/todo-create.fixture.json` with exactly:

```json
{
  "targetRepo": "/Users/bytedance/Desktop/code/quadtodo",
  "requirements": [
    {
      "key": "baseUrl",
      "required": true,
      "source": "env",
      "envName": "E2E_BASE_URL",
      "description": "Local quadtodo URL opened by Playwright. Use http://127.0.0.1:5678 for the default E2E run."
    },
    {
      "key": "tempDataDir",
      "required": true,
      "source": "env",
      "envName": "QUADTODO_E2E_CWD",
      "description": "Isolated temporary run directory used as the CLI --cwd value for the E2E backend."
    },
    {
      "key": "rootDir",
      "required": true,
      "source": "env",
      "envName": "QUADTODO_ROOT_DIR",
      "description": "Isolated quadtodo root directory for config, logs, pid file, and data.db during the E2E run."
    },
    {
      "key": "backendCommand",
      "required": true,
      "source": "literal",
      "value": "QUADTODO_ROOT_DIR=$QUADTODO_ROOT_DIR node src/cli.js start --no-open --port 5678 --cwd $QUADTODO_E2E_CWD",
      "description": "Starts the real local quadtodo backend and built web UI with isolated data."
    },
    {
      "key": "authState",
      "required": false,
      "source": "none",
      "description": "Not needed: the current local quadtodo web app has no login flow, and POST /api/todos is mounted without auth middleware."
    },
    {
      "key": "businessLineId",
      "required": false,
      "source": "none",
      "description": "Not needed: todo creation has no business line or tenant input in the UI, API client, or /api/todos route."
    }
  ]
}
```

- [ ] **Step 2: Create the artifact directory marker**

Create `test/e2e/artifacts/.gitkeep` as an empty file.

- [ ] **Step 3: Validate fixtures with the harness CLI**

Run with explicit environment values:

```bash
E2E_BASE_URL=http://127.0.0.1:5678 QUADTODO_E2E_CWD=/tmp/quadtodo-e2e-fixture QUADTODO_ROOT_DIR=/tmp/quadtodo-e2e-fixture npm --prefix /Users/bytedance/Desktop/code/ai-coding-e2e-harness run dev -- validate-fixtures --manifest test/e2e/fixtures/todo-create.fixture.json
```

Expected: exit code 0 and fixture validation passes. If it fails because the harness CLI is unavailable or rejects the manifest shape, stop and report the exact CLI output.

## Task 3: Add Playwright config

**Files:**
- Create: `playwright.config.ts`

- [ ] **Step 1: Write the config**

Create `playwright.config.ts` with:

```ts
import { defineConfig, devices } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const e2eRoot = process.env.QUADTODO_ROOT_DIR || resolve('tmp/e2e/todo-create-playwright')
const e2eCwd = process.env.QUADTODO_E2E_CWD || e2eRoot
const port = Number(process.env.E2E_PORT || 5678)
const baseURL = process.env.E2E_BASE_URL || `http://127.0.0.1:${port}`

mkdirSync(e2eRoot, { recursive: true })
mkdirSync(e2eCwd, { recursive: true })

export default defineConfig({
  testDir: './test/e2e',
  timeout: 30_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['html', { outputFolder: 'test/e2e/artifacts/playwright-report', open: 'never' }]],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  webServer: {
    command: `node src/cli.js start --no-open --port ${port} --cwd "${e2eCwd}"`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      ...process.env,
      QUADTODO_ROOT_DIR: e2eRoot,
    },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
})
```

- [ ] **Step 2: Verify Playwright sees the test directory**

Run:

```bash
npx playwright test --list
```

Expected before the spec exists: command succeeds and reports no tests, or reports the test directory has no tests. If Playwright errors on config syntax, fix the config before continuing.

## Task 4: Generate harness Playwright commands and collect a runtime snapshot

**Files:**
- Create or update: `test/e2e/artifacts/todo-create.snapshot.json`

- [ ] **Step 1: Generate commands with ai-e2e-harness**

Run:

```bash
npm --prefix /Users/bytedance/Desktop/code/ai-coding-e2e-harness run dev -- playwright-commands --base-url http://127.0.0.1:5678 --route / --snapshot-file test/e2e/artifacts/todo-create.snapshot.json --test-file test/e2e/todo-create.spec.ts
```

Expected: exit code 0 and output that includes snapshot, RED, and GREEN commands. Copy the exact commands into the final report notes.

- [ ] **Step 2: Build the web app before snapshot**

Run:

```bash
npm run build:web
```

Expected: exit code 0. This is required because `src/cli.js start` serves `dist-web`.

- [ ] **Step 3: Run the generated snapshot command**

Use the snapshot command from Step 1. Ensure these environment values are present if the generated command does not set them:

```bash
E2E_BASE_URL=http://127.0.0.1:5678 QUADTODO_ROOT_DIR=/tmp/quadtodo-e2e-snapshot QUADTODO_E2E_CWD=/tmp/quadtodo-e2e-snapshot
```

Expected: snapshot command exits 0 and writes `test/e2e/artifacts/todo-create.snapshot.json` or another harness-named snapshot artifact. The snapshot must show enough runtime facts to identify the create button, title input, save button, and resulting todo text.

## Task 5: Write the E2E test and run RED

**Files:**
- Create: `test/e2e/todo-create.spec.ts`

- [ ] **Step 1: Write the test**

Create `test/e2e/todo-create.spec.ts` with:

```ts
import { expect, test } from '@playwright/test'
import { existsSync, rmSync } from 'node:fs'

const e2eRoot = process.env.QUADTODO_ROOT_DIR

const uniqueTitle = () => `E2E 新增待办 ${Date.now()}`

test.afterAll(() => {
  if (process.env.QUADTODO_KEEP_E2E_DATA === '1') return
  if (!e2eRoot || !e2eRoot.includes('quadtodo-e2e')) return
  if (existsSync(e2eRoot)) rmSync(e2eRoot, { recursive: true, force: true })
})

test('user can create a todo', async ({ page, request }) => {
  const title = uniqueTitle()

  await page.goto('/')

  await page.getByRole('button', { name: /新建/ }).click()
  await page.getByLabel('标题').fill(title)
  await page.getByRole('button', { name: '保存' }).click()

  await expect(page.getByText(title)).toBeVisible()

  const response = await request.get('/api/todos')
  expect(response.ok()).toBe(true)
  const body = await response.json()
  expect(body.ok).toBe(true)
  expect(body.todos.some((todo: { title: string }) => todo.title === title)).toBe(true)
})
```

- [ ] **Step 2: Run RED using the generated RED command**

Use the RED command emitted by the harness CLI in Task 4. If it is equivalent to `npx playwright test test/e2e/todo-create.spec.ts --project=chromium`, run it with an isolated root:

```bash
E2E_BASE_URL=http://127.0.0.1:5678 QUADTODO_ROOT_DIR=/tmp/quadtodo-e2e-red QUADTODO_E2E_CWD=/tmp/quadtodo-e2e-red npx playwright test test/e2e/todo-create.spec.ts --project=chromium
```

Expected for a valid product RED: FAIL because the todo creation acceptance criterion is not met. Valid failure examples are: the create drawer cannot be opened, the title cannot be saved, the saved todo does not appear, or `/api/todos` does not contain the created title.

Invalid RED failures: service cannot start, `dist-web` is missing, fixture env is missing, browser is not installed, or selectors contradict the runtime snapshot. Fix invalid failures as environment/test setup before counting RED.

If the command passes because the existing product already satisfies todo creation, record that a product RED is not available without intentionally breaking working behavior. Do not weaken the test or modify product code to fake RED; ask the user whether to accept test-infrastructure validation for an already-working flow.

## Task 6: Run GREEN and supporting verification

**Files:**
- No new files unless Task 5 found a valid product bug requiring a minimal product fix.

- [ ] **Step 1: If RED exposed a product bug, make the minimal fix**

Only edit the file directly responsible for the failure. Examples:

- If the create button is missing, restore the existing header button in `web/src/TodoManage.tsx`:

```tsx
<Button type="primary" icon={<PlusOutlined />} size="small" onClick={handleCreate}>
  新建
</Button>
```

- If save does not call create, ensure the create branch in `handleSave` calls `createTodo(data)` and then `fetchTodos()`.

Do not add unrelated refactors.

- [ ] **Step 2: Rebuild the web app**

Run:

```bash
npm run build:web
```

Expected: exit code 0.

- [ ] **Step 3: Run GREEN using the generated GREEN command**

Use the GREEN command emitted by the harness CLI in Task 4. If it is equivalent to `npx playwright test test/e2e/todo-create.spec.ts --project=chromium`, run:

```bash
E2E_BASE_URL=http://127.0.0.1:5678 QUADTODO_ROOT_DIR=/tmp/quadtodo-e2e-green QUADTODO_E2E_CWD=/tmp/quadtodo-e2e-green npx playwright test test/e2e/todo-create.spec.ts --project=chromium
```

Expected: PASS, 1 test passed, and temporary E2E data directory removed unless `QUADTODO_KEEP_E2E_DATA=1` is set.

- [ ] **Step 4: Run existing regression tests**

Run:

```bash
npm test -- test/todos.route.test.js
```

Expected: PASS. This confirms existing API route coverage still works.

## Task 7: Render final harness report and summarize

**Files:**
- Create or update: `test/e2e/artifacts/todo-create-report.json`
- Create or update: `test/e2e/artifacts/todo-create-report.md` if the harness render command emits markdown to a file.

- [ ] **Step 1: Create the report input JSON**

Create `test/e2e/artifacts/todo-create-report.json` with the actual command outputs summarized after running Tasks 2-6. Use this shape:

```json
{
  "scenario": "User can create a todo through the quadtodo web UI",
  "fixtureManifest": "test/e2e/fixtures/todo-create.fixture.json",
  "fixtureValues": {
    "baseUrl": "env:E2E_BASE_URL=http://127.0.0.1:5678",
    "tempDataDir": "env:QUADTODO_E2E_CWD=/tmp/quadtodo-e2e-*",
    "rootDir": "env:QUADTODO_ROOT_DIR=/tmp/quadtodo-e2e-*",
    "authState": "not required: no login flow or auth middleware for /api/todos",
    "businessLineId": "not required: todo creation has no business line/tenant input"
  },
  "mockBacked": false,
  "commands": {
    "validateFixtures": "E2E_BASE_URL=http://127.0.0.1:5678 QUADTODO_E2E_CWD=/tmp/quadtodo-e2e-fixture QUADTODO_ROOT_DIR=/tmp/quadtodo-e2e-fixture npm --prefix /Users/bytedance/Desktop/code/ai-coding-e2e-harness run dev -- validate-fixtures --manifest test/e2e/fixtures/todo-create.fixture.json",
    "playwrightCommands": "npm --prefix /Users/bytedance/Desktop/code/ai-coding-e2e-harness run dev -- playwright-commands --base-url http://127.0.0.1:5678 --route / --snapshot-file test/e2e/artifacts/todo-create.snapshot.json --test-file test/e2e/todo-create.spec.ts",
    "snapshot": "<exact generated snapshot command>",
    "red": "<exact RED command>",
    "green": "<exact GREEN command>",
    "regression": "npm test -- test/todos.route.test.js"
  },
  "results": {
    "red": "<failed/passed-with-existing-behavior and reason>",
    "green": "<passed/failed and test count>",
    "repairs": 0,
    "cleanup": "temporary QUADTODO_ROOT_DIR removed on success"
  },
  "uncoveredPaths": [
    "No login or business-line path covered because this app flow does not require either.",
    "Mock-backed E2E not used."
  ]
}
```

Replace every angle-bracket value with the actual observed command/result text before rendering.

- [ ] **Step 2: Render the report with the harness CLI**

Run:

```bash
npm --prefix /Users/bytedance/Desktop/code/ai-coding-e2e-harness run dev -- render-report --input test/e2e/artifacts/todo-create-report.json
```

Expected: exit code 0 and a rendered report. If the CLI is unavailable or fails, report that explicitly and include the JSON evidence instead.

- [ ] **Step 3: Final verification-before-completion gate**

Before claiming completion, use `superpowers:verification-before-completion` and verify these command results are fresh:

```bash
npm run build:web
E2E_BASE_URL=http://127.0.0.1:5678 QUADTODO_ROOT_DIR=/tmp/quadtodo-e2e-final QUADTODO_E2E_CWD=/tmp/quadtodo-e2e-final npm run test:e2e -- test/e2e/todo-create.spec.ts --project=chromium
npm test -- test/todos.route.test.js
```

Expected: build passes, E2E passes with 1 test, route test passes.

- [ ] **Step 4: Report to the user**

Include:

- Change summary.
- Tests generated/updated.
- Fixture manifest path and values by source without secrets.
- Harness `validate-fixtures` command and result.
- Harness `playwright-commands` command and generated command summary.
- RED command and whether it produced a valid product RED; if not, state that existing behavior already passed and no fake RED was created.
- GREEN command and pass/fail count.
- Mock-backed scope: `none; real local backend was used`.
- Repair attempts count, maximum 2.
- Cleanup result for temp data.
- Uncovered paths and any decisions still needed from the user.

## Self-Review

- Spec coverage: the plan covers fixture manifest path and requirements, fixture validation CLI, harness command generation, runtime snapshot, RED/GREEN constraints, isolated database via `QUADTODO_ROOT_DIR`, no auth/business ID rationale, mock-backed labeling, two-repair policy, and final report evidence.
- Placeholder scan: no `TBD`, `TODO`, or unspecified implementation steps remain; the report JSON step intentionally requires replacing angle-bracket values with observed command evidence.
- Type consistency: file names, env names, route names, and commands match the approved spec and current repo code. One spec correction was made: `QUADTODO_ROOT_DIR` is required because `src/cli.js` stores `data.db` under `DEFAULT_ROOT_DIR`, while `--cwd` only controls the AI terminal default cwd.
