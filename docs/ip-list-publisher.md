# IP list publisher: deployment and recovery

## What it does

On its twice-weekly cron, `revrebel-ip-sync` downloads and validates GitHub, Linear, ChatGPT Connector, and Codex cloud-agent source feeds and merges them with the Worker secret `LOCALIP`. If `DRY_RUN` is `false`, it compares with the existing account IP list, stores a backup of the original list in the `IP_SYNC_STATE` KV namespace, replaces the list via the asynchronous Cloudflare bulk API, waits for completion, and reads the list back to verify the complete result. Runs are idempotent.

The Worker has no public HTTP endpoint, with both `workers_dev` and `preview_urls` disabled.

## Required account permissions

Create a **scoped Cloudflare API token** for `CLOUDFLARE_API_TOKEN` with:
- Account: **Account Filter Lists Edit** (read/write account IP lists).
- Zone: **Zone Read**, and **WAF Read** / **Rulesets Read** for all zones in the account (needed to ensure no WAF rule still references the list before repurposing it).

Use the narrowest possible account and zone scopes. Do not check the token into Git.

```sh
cd apps/ip-sync-worker
npx wrangler secret put CLOUDFLARE_API_TOKEN
npx wrangler secret put LOCALIP
```

`IP_SYNC_STATE` uses dedicated KV namespace `revrebel-ip-sync-state` (ID declared in `wrangler.jsonc`). This stores last-good feed counts and immutable `backup:<UTC timestamp>` snapshots for rollback.

## IMPORTANT: legacy WAF migration

The old account list is named `linear_webhooks` and was used to limit Linear `/webhook` traffic to the 15 official Linear webhook IPs. Adding GitHub/OpenAI IPs to that list **without first migrating the WAF expression would broaden who may post to those routes**.

The Worker deliberately checks every zone's enabled custom WAF rules before publishing. If any still reference `$linear_webhooks`, it fails with a clear error instead of updating the list. Migrate provider-specific rules to retain their existing source restrictions as inline CIDR sets first. Then verify provider webhook delivery. Other rules that should allow all trusted sources can continue to reference the consolidated list after migration.

The list name `linear_webhooks` is retained because Cloudflare's free account already uses its one custom list. Renaming the list can be considered after migration; changing its name requires updating rules.

## Enable and verify

1. Merge the publisher PR, pull `main`, run `npm install && npm run check && npm run test --workspace @revrebel/ip-sync-worker`.
2. Ensure `LOCALIP` and `CLOUDFLARE_API_TOKEN` secrets exist.
3. Deploy with `DRY_RUN=true` first and verify `ip-sync-verification` in `wrangler tail revrebel-ip-sync`.
4. After confirming the legacy WAF migration, change the **`DRY_RUN` config variable** to `"false"` and redeploy.
5. Confirm an `ip-sync-published` event (including operation ID), then query the account list through the API. Expect approximately 3,200 entries, with counts subject to feed changes.
6. Confirm webhook requests still obey their provider-specific restrictions.

The scheduled Worker runs Monday/Thursday at 12:00 UTC. Do not assume deploying triggers the scheduled sync immediately.

## Failure and recovery

- Missing/broken provider feed, drastic provider shrinkage, missing `LOCALIP`, missing KV/token, or blocked WAF migration: abort **before** changing the list.
- Bulk operation failure or timeout: inspect the operation status before retrying.
- Read-back mismatch: an immutable `backup:<timestamp>` snapshot exists in KV, but the Worker deliberately does **not** attempt a second blind destructive PUT. Stop further publishing (set `DRY_RUN=true`), inspect the list, and restore from the snapshot using the Cloudflare bulk API after determining the failure cause.
- All API and cron logs omit secret values and detailed IP lists.

This system synchronizes an account-level list. Zone WAF policies remain separate and must not broadly permit all listed providers to access every webhook.
