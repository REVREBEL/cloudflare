# IP sync rollout

## Stage 1: read-only baseline

The scheduled Worker downloads GitHub Meta `hooks`, Linear `ips` and `codingSessionIps`, and OpenAI connector/agent `prefixes`. It validates and merges them with the administrative allowlist IP. It emits only counts to logs. **It does not update the Cloudflare IP list or WAF rules.** The HTTP handler intentionally does not expose a synchronization trigger.

## Stage 2: reviewed publisher (not yet implemented)

- Test against frozen JSON fixtures from each provider.
- Check Cloudflare account-list item quota and per-operation bulk limits.
- Keep a durable last-good snapshot per provider; refuse accidental large list removals.
- Back up current list contents, submit asynchronous bulk mutation, poll completion, and reconcile read-back before reporting success.
- Preserve source attribution in the repository, since a combined WAF list cannot distinguish GitHub, Linear and OpenAI clients.
- Model and verify zone-scoped rule changes before applying them, preserving webhook delivery and OAuth callbacks.
- Verify live authorized requests from GitHub/Linear/ChatGPT and the administrator before enabling a default-deny rule.

## Credentials

Use a Cloudflare Worker secret for any future token. Never put it in `wrangler.jsonc`, GitHub commits, or application logs. Keep `DRY_RUN=true` until a reviewed publisher has been released.
