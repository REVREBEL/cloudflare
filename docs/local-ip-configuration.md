# Configuring trusted IP addresses

The Worker reads trusted administrative addresses from its `LOCALIP` environment binding. Addresses are no longer stored in `config/sources.json`.

## Local development

From the repository root:

```sh
cp apps/ip-sync-worker/.env.example apps/ip-sync-worker/.env
```

Edit `apps/ip-sync-worker/.env` and replace the documentation-only addresses. For example:

```dotenv
LOCALIP="{192.0.2.10,192.0.2.11,192.0.2.10}"
```

The braces are optional. Commas and newlines are supported *within the quoted value*. Bare IPv4 addresses become `/32`; bare IPv6 addresses become `/128`. Exact duplicates are removed. The Worker fails rather than continuing if `LOCALIP` is missing or contains invalid addresses. At least one address is required.

Keep `.env` in the same directory as `wrangler.jsonc`. Wrangler loads it for **local** development; `npm run dev:ip-sync` (or `cd apps/ip-sync-worker && npx wrangler dev --test-scheduled`) uses the Worker configuration. If a `.dev.vars` file exists, Wrangler uses it instead of `.env`, so remove it or also configure `LOCALIP` there.

Run a scheduled test:

```sh
cd apps/ip-sync-worker
npx wrangler dev --test-scheduled
# In another terminal:
curl -i http://localhost:8787/cdn-cgi/local/scheduled
```

Check for the `ip-sync-verification` event, including `localIpPresent: true`, `duplicatesRemaining: 0`, and the `ip-sync-plan` event with `dryRun: true`. Do not confuse exact duplicate removal with CIDR overlap elimination; overlapping networks are not yet collapsed.

## Cloudflare production configuration

**`.env` files are local only. They do not automatically publish into a deployed Worker.** Before a future deployment, set a production Worker secret explicitly:

```sh
cd apps/ip-sync-worker
npx wrangler secret put LOCALIP
```

Enter the comma-separated/braced list when prompted. Cloudflare stores the value as a Worker secret; it is not stored in Git. Do not set actual addresses in the public `wrangler.jsonc` or commit your `.env` file. The Worker remains read-only even if `DRY_RUN` is changed; production list publishing is not implemented yet.

## Log fields

`ip-sync-verification` reports `localIpPresent`, `localIpCount`, `localDuplicatesRemoved`, `providerEntries`, `uniqueEntries`, `duplicatesRemoved`, and `duplicatesRemaining`. It deliberately omits actual IP addresses.
