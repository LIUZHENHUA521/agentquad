# AI Reply Hub Design

## Context

When many Claude Code sessions run concurrently, users cannot quickly tell which sessions have replied or need attention. The app already has live AI session state, a Dashboard, embedded terminal panels, and per-terminal `turn_done` reminders. The missing experience is a global, actionable list of sessions that need the user's next action.

## Goals

- Show a lightweight global count of AI sessions needing attention.
- Provide a list of pending sessions with enough context to identify them.
- Let the user click one item and jump directly to the relevant todo's Claude Code area.
- Allow the user to mark completed replies as seen so the list does not stay noisy.
- Reuse the current Dashboard, todo list, and terminal expansion behavior without changing the backend data model.

## Non-goals

- Persist notification state across browsers or devices.
- Replace browser/system notifications.
- Add a general-purpose notification center.
- Change terminal/xterm lifecycle, PTY sizing, or session execution semantics.

## Recommended approach

Implement a client-side AI Reply Hub:

1. Add a floating "待处理回复 N" entry point on the main todo page.
2. Clicking the entry opens the existing AI Dashboard and focuses a new "待处理 AI 会话" section.
3. The section lists both waiting-for-user-interaction sessions and completed replies awaiting review.
4. Each item supports "定位并展开" and "标记已看".
5. Seen completed replies are stored in `localStorage` by `sessionId`.

This gives the strongest UX improvement with low implementation risk and avoids database/API migrations.

## Attention item definition

The hub includes two item types:

### Waiting for interaction

A session is waiting for interaction when its live session status is `pending_confirm` or its todo status is `ai_pending`.

These items stay visible until the session is no longer pending. They are not removed by "标记已看" because they still require a real user action in the terminal.

### Reply completed and awaiting review

A session is awaiting review when it belongs to a todo in an AI-completed state and has not been marked as seen locally.

The implementation should derive this from the current `todos` data, using `todo.aiSessions`, `todo.aiSession`, and todo status. If multiple sessions on the same todo are completed, list them separately by `sessionId`.

## UI design

### Floating entry

- Location: bottom-right on desktop.
- Text: "待处理回复" with a numeric badge.
- Count: waiting-for-interaction items plus completed-awaiting-review items not marked seen.
- Hidden when the count is zero.
- On mobile, the entry should avoid covering core actions; it may sit above the bottom edge with compact text.

### Dashboard section

Add a top section to the existing AI Dashboard:

- Title: "待处理 AI 会话".
- Summary counts for "待验收" and "待交互".
- Filter chips or tabs: "全部", "待验收", "待交互".
- Empty state: "暂无待处理 AI 会话".

Each list item shows:

- todo title;
- tool name;
- quadrant/priority;
- status label: "待交互" or "待验收";
- latest relevant time from `lastOutputAt`, `completedAt`, or `startedAt`.

Actions:

- "定位并展开": jump to the target todo/session.
- "标记已看": only for completed-awaiting-review items.
- Optional batch action: "清空已完成", marking all completed-awaiting-review items seen while leaving waiting-for-interaction items untouched.

## Interaction flow

When the user clicks "定位并展开":

1. Close the Dashboard.
2. Switch to the todo list view if the current view cannot render todo cards.
3. Adjust filters so the target todo can be rendered. If the current search keyword or status filter hides the target, clear the keyword and use a visible status filter.
4. Clear the target todo's hidden-terminal state.
5. Set `expandedTerminal` to `{ todoId, sessionId }`.
6. Scroll the target card or terminal panel into view with smooth scrolling.
7. Apply a temporary highlight for 2-3 seconds so the user can identify the target.

If the todo no longer exists, omit the item from the hub. If the session exists in todo history but is not live, still allow navigation to the historical session panel.

## State model

Use local client state plus `localStorage`:

- `seenReplySessionIds: Set<string>` tracks completed sessions marked seen.
- Storage key: `quadtodo:seenAiReplies`.
- Values are session IDs with optional timestamps if convenient for cleanup.

Seen state only affects hub visibility. It must not mutate todo/session status or backend state.

## Component boundaries

- Add a small utility or hook to derive attention items from `todos`, live sessions, and seen session IDs.
- Keep item derivation separate from Dashboard rendering so the floating badge and Dashboard list use the same source of truth.
- Add Dashboard rendering for attention items without removing the existing live session list.
- Keep jump-to-session behavior in `TodoManage.tsx`, where `expandedTerminal`, filters, and view mode already live.

## Risks and mitigations

- **Target hidden by filters:** navigation should clear or adjust filters before scrolling.
- **Non-list view active:** navigation should switch back to a renderable todo-card view.
- **Terminal remount churn:** use existing `expandedTerminal` behavior instead of changing xterm internals.
- **Noisy completed items:** `标记已看` and `清空已完成` let the user suppress completed replies.
- **Local-only seen state:** acceptable for first version because this is a local productivity app and avoids backend migration.

## Acceptance criteria

- A floating "待处理回复 N" entry appears when there is at least one pending-confirm or un-seen completed AI session.
- The Dashboard shows a "待处理 AI 会话" section with visually distinct "待交互" and "待验收" items.
- Clicking "定位并展开" closes the Dashboard, makes the target todo visible, expands the correct session, scrolls to it, and highlights it briefly.
- Clicking "标记已看" removes a completed-awaiting-review item from the hub and the item stays hidden after page refresh.
- Waiting-for-interaction items remain visible until the session leaves `pending_confirm` / `ai_pending`.
- Existing AI Dashboard live sessions, terminal input, side-by-side sessions, and resume behavior continue to work.

## Validation plan

- Unit-test the attention item derivation for mixed live sessions, completed sessions, seen sessions, and deleted todos.
- Component-test or E2E-test the visible hub count, Dashboard list, mark-seen behavior, and jump-to-session behavior.
- Manually verify with multiple concurrent AI sessions that the correct item can be identified and opened.
