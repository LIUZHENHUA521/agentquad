# Todo Create E2E Harness Design

## Goal

Add a minimal Playwright E2E validation for the user path “新增一条 todo” and run it through the ai-coding-e2e-harness workflow. The test must exercise the real browser UI and the real local quadtodo backend, without writing to the user's normal quadtodo data.

## Scope

This adds E2E test infrastructure and one critical user-path spec. Product code changes are out of scope unless a valid RED run proves the todo creation flow is missing or behaves incorrectly.

## Fixture Manifest

Create `test/e2e/fixtures/todo-create.fixture.json` with these requirements:

- `baseUrl`: required, source `env`, env name `E2E_BASE_URL`. This is the local app URL opened by Playwright.
- `tempDataDir`: required, source `env`, env name `QUADTODO_E2E_CWD`. This points to an isolated temporary run directory for the E2E run.
- `rootDir`: required, source `env`, env name `QUADTODO_ROOT_DIR`. This points to the isolated quadtodo config/database root. It may be the same path as `QUADTODO_E2E_CWD`, but it is listed separately because the CLI stores `data.db` under `QUADTODO_ROOT_DIR`, not under `--cwd`.
- `backendCommand`: required, source `literal`, value `QUADTODO_ROOT_DIR=<tempDataDir> node src/cli.js start --no-open --port <port> --cwd <tempDataDir>`. This records the real backend startup command; the harness manifest schema supports `env`, `storageState`, and `literal`, not a dedicated `command` source.
- `authState`: not required. quadtodo's current local web app has no login flow, and `POST /api/todos` is mounted without auth middleware.
- `businessLineId`: not required. todo creation does not accept or require a business line/tenant identifier in the UI, API client, or `/api/todos` route.

The first harness command is:

```bash
npm --prefix /Users/bytedance/Desktop/code/ai-coding-e2e-harness run dev -- validate-fixtures --manifest test/e2e/fixtures/todo-create.fixture.json
```

If fixture validation fails, stop and report the missing fixture instead of continuing to RED.

## Playwright and Harness Flow

Use the harness CLI to generate the mechanical Playwright commands:

```bash
npm --prefix /Users/bytedance/Desktop/code/ai-coding-e2e-harness run dev -- playwright-commands --base-url <baseUrl> --route / --snapshot-file test/e2e/artifacts/todo-create.snapshot.json --test-file test/e2e/todo-create.spec.ts
```

The generated snapshot command is used to collect runtime facts before the RED run. Locators must be based on the runtime page facts and semantic selectors where possible: the create button text `新建待办`, title input label/placeholder `标题` / `待办事项标题`, and save button text `保存`.

## E2E Test Behavior

The test starts from an isolated empty data directory, opens `/`, creates a todo with a unique title, saves it, and asserts the title appears on the board. It may also query `/api/todos` through the browser context to verify the persisted todo exists in the real backend.

The test is real E2E, not mock-backed. No network route mocking is used. If a future blocker forces mock-backed coverage, the report must label it as mock-backed and must not claim real E2E passed.

## RED and GREEN Requirements

RED must be run before any product implementation changes. A valid RED failure must come from the product not satisfying the acceptance criterion: the user cannot create a todo through the UI, the todo does not persist, or the saved todo is not visible. RED is invalid if failure is caused by missing fixtures, a dead server, an unavailable browser, or unverified selectors.

If the current product already satisfies the behavior, a true product RED may not be possible without intentionally changing product code. In that case, stop and report that the pre-existing behavior prevents a valid RED for a product bug; continue only if the user accepts test-infrastructure RED/GREEN evidence instead.

GREEN must be a fresh Playwright run after the E2E test and any required fixes are in place.

## Data Isolation and Cleanup

Each E2E run uses a unique temporary directory under `tmp/e2e/todo-create-<run-id>` or the OS temp directory. The backend receives that path through `QUADTODO_ROOT_DIR` for the SQLite database/config/logs and through `--cwd` for the AI terminal default cwd, so generated quadtodo files are isolated from the user's normal workspace data.

On success, remove the temporary data directory. On failure, keep Playwright traces/screenshots and either remove or explicitly report the retained data directory for debugging. The final report must state which cleanup path occurred.

## Repair Policy

Automatic repair is limited to two attempts. Repair is allowed only for clear product bugs or test bugs that do not weaken the acceptance criteria. Stop immediately for fixture bugs, environment bugs, unclear requirements, or after two failed repair attempts.

## Files Expected

- `playwright.config.ts` or equivalent minimal Playwright config.
- `test/e2e/todo-create.spec.ts`.
- `test/e2e/fixtures/todo-create.fixture.json`.
- Optional generated harness artifacts under `test/e2e/artifacts/`.
- `package.json` scripts and lockfile updates if Playwright dependencies/scripts are required.

## Final Report

The final report must include change summary, generated or updated tests, fixture values by source without secrets, RED command and failure reason, GREEN command and pass/fail count, mock-backed scope if any, repair attempts, cleanup result, uncovered paths, and decisions still needed from the user.
