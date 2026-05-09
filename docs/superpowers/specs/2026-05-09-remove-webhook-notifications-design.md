# Remove Webhook Notifications Design

## Context

quadtodo currently supports webhook notifications for AI terminal sessions. The webhook path detects pending-confirm prompts and keyword matches, then sends text messages to WeCom or Feishu robot webhook URLs. The configuration is exposed in the web settings drawer and persisted under the `webhook` section in the local config file.

The requested change is to remove webhook notification functionality because better notification channels now exist. Existing local configs may still contain a `webhook` section, so the removal should avoid breaking startup or unrelated config saves.

## Chosen Approach

Remove webhook sending and the settings UI, while preserving legacy config compatibility.

This means:

- No webhook HTTP POSTs should be sent.
- The web settings drawer should no longer show or save webhook notification fields.
- Pending-confirm state detection should remain because it drives core AI terminal behavior, not just webhook notifications.
- Old `webhook` fields in `.quadtodo/config.json` should remain tolerated by the backend.
- `/api/config` may continue returning the legacy `webhook` field for compatibility, but the frontend should not depend on it.

## Alternatives Considered

### Fully delete webhook config and API shape

This would remove all webhook fields from backend defaults, normalization, API responses, frontend types, UI, and tests.

Pros: cleanest final code shape and lowest long-term maintenance.

Cons: higher risk for existing local config files or external consumers that still expect the field.

### Hide only the UI

This would remove the settings drawer controls but keep backend webhook sending if old config enables it.

Pros: smallest code change.

Cons: does not satisfy the goal because old configurations could still send webhook notifications.

## Design Details

### Backend notification behavior

`createAiTerminal` should stop depending on webhook notification sending. When PTY output contains a confirm-like prompt, it should still:

- append output to session history,
- mark the session as `pending_confirm`,
- mark the todo as `ai_pending`,
- broadcast a `pending_confirm` message to attached browsers.

It should no longer:

- call webhook notification code,
- inspect user-configured keyword patterns for webhook fallback notifications,
- log webhook send failures.

Confirm-prompt detection should be kept in the simplest maintainable form. Since it is only needed by the AI terminal route after removing webhook sending, a small local helper in `src/routes/ai-terminal.js` is preferred over keeping a webhook-oriented notifier module.

### Configuration compatibility

The backend should continue to accept and normalize an existing `webhook` field in config. This prevents old local config files from becoming invalid and avoids unnecessary migration behavior.

The implementation should not actively delete users' existing `webhook` fields from disk. Saving unrelated settings should continue to work.

### Frontend settings

The settings drawer should remove the entire Webhook notification section:

- enable switch,
- provider radio group,
- URL input,
- pending-confirm notification switch,
- keyword notification switch,
- keyword textarea,
- cooldown input.

The save payload should stop sending a `webhook` patch. The load path should stop reading webhook values into form fields.

Frontend config typing should not require webhook fields for normal UI operation. Keeping an optional legacy type is acceptable if useful for API compatibility.

### Tests

Tests should focus on behavior after removal:

- confirm-like output still marks todo/session as pending,
- browser clients still receive `pending_confirm`,
- no webhook notification call is expected,
- legacy webhook config can still be loaded and normalized,
- frontend build succeeds without webhook form fields.

Existing tests that assert notifier calls should be rewritten or removed.

### Documentation

README references that describe relying on Feishu/WeCom webhook notifications should be updated or removed so the docs do not advertise a removed feature.

## Risks

- Pending-confirm behavior could regress if webhook removal accidentally deletes confirm detection.
- Frontend could still assume `config.webhook` exists and crash when loading settings.
- Existing tests may rely on injected notifier objects; those tests need to be updated to verify user-visible pending-confirm behavior instead.
- Leaving legacy config fields can look like dead code, so comments or test names should make the compatibility intent clear without adding broad new abstractions.

## Acceptance Criteria

- The settings drawer no longer displays any Webhook notification controls.
- Saving settings no longer sends a `webhook` patch from the frontend.
- AI terminal confirm prompts still transition the todo to `ai_pending` and the session to `pending_confirm`.
- Browser clients still receive `pending_confirm` events.
- Keyword matches no longer trigger external notification logic.
- No webhook HTTP requests are sent by the application.
- Existing config files containing a `webhook` section still load successfully.
- Relevant backend tests pass.
- Web build passes.
- If the UI is changed, the running app is checked in a browser to confirm the Webhook section is gone.
