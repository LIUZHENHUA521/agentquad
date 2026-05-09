# GPT Default Pricing Design

## Goal

Add GPT/OpenAI model families to the built-in default pricing table so Codex/OpenAI usage no longer falls back to Claude Sonnet default pricing when the model name is known.

## Context

quadtodo already parses Codex transcript usage and stores the primary model name, including values such as `gpt-5-codex`. Cost estimation uses `DEFAULT_PRICING.models` from `src/pricing.js`, where glob patterns are tested in insertion order before falling back to `pricing.default`.

The settings drawer reads the same pricing config through `/api/config`, so any new default model patterns added to `DEFAULT_PRICING.models` automatically appear in the UI after config normalization.

## Chosen Approach

Add a compact set of OpenAI/GPT glob patterns to `DEFAULT_PRICING.models`:

- `gpt-5*`
- `gpt-4.1*`
- `gpt-4o*`
- `gpt-4o-mini*`

This intentionally avoids a single broad `gpt-*` entry because GPT model prices differ materially by family. It also avoids enumerating every possible model variant because the existing glob matching is sufficient for common suffixes such as `gpt-5-codex`.

## Architecture

Only the default pricing source changes. No UI, API, database, transcript parser, or settings persistence changes are needed.

`src/pricing.js` remains the single source of built-in rates. `src/config.js` already merges default pricing model rows into existing user config, with user-provided same-key rows taking precedence.

## Data Flow

1. Codex transcript parsing extracts `primaryModel`, such as `gpt-5-codex`.
2. Stats/reporting calls `estimateCost(tokens, primaryModel, pricing)`.
3. `resolveRate()` iterates `pricing.models` and matches the first glob pattern.
4. GPT models match the new GPT family pattern.
5. Unknown models continue to use `pricing.default`.

## Pricing Values

Use USD per 1M tokens, matching the existing pricing table units. For GPT models, map OpenAI cached input pricing to `cacheRead`. Use the same value for `cacheWrite` because OpenAI pricing exposes cached input rather than Anthropic-style cache creation pricing in this app's current four-field model.

The exact numeric values should be entered in `DEFAULT_PRICING.models` during implementation and covered by tests. If official OpenAI pricing has changed at implementation time, prefer the current official values over stale assumptions.

## Error Handling

No new error handling is needed. If a model does not match a GPT or Claude pattern, the existing fallback to `pricing.default` remains unchanged.

## Testing

Update `test/pricing.test.js` with behavior tests that fail before implementation:

- `gpt-5-codex` should match `gpt-5*` instead of falling back to `pricing.default`.
- a representative GPT 4.1 model should match `gpt-4.1*`.
- an unknown non-GPT model should still fall back to `pricing.default`.

Run the targeted pricing test first, then the full test suite.

## Out of Scope

- Changing the settings drawer layout.
- Adding live price fetching.
- Adding provider-specific pricing schemas.
- Changing transcript parsing or database schema.
