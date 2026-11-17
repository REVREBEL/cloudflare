# Environment-driven deployment

The deployment reads `apps/ip-sync-worker/.env` (and optionally a root `.env`, with Worker values taking precedence). Existing process environment variables override file values for CI.

## Local environment

```sh
cp apps/ip-sync-worker/.env.example apps/ip-sync-worker/.env
```

The file must contain:

```dotenv
DOMAIN="revrebel.io"
CLOUDFLARE_API_TOKEN="<YOUR_SCOPED_TOKEN>"
CLOUDFLARE_ACCOUNT_ID="<YOUR_ACCOUNT_ID>"
CLOUDFLARE_ZONE_ID="<YOUR_ZONE_ID>"
LOCALIP="{192.0.2.10,192.0.2.11}"
DRY_RUN="true"
```

The IPs above are documentation placeholders. You can optionally supply `CLOUDFLARE_LIST_ID`; otherwise the existing list ID in `wrangler.jsonc` is retained.

## One deployment command

From the repository root:

```sh
npm run deploy:ip-sync
```

This command validates the input, passes `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` to Wrangler for CLI authentication, overrides the Worker's public runtime variables (`DOMAIN`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_ZONE_ID`, `DRY_RUN`), and uploads **only** `LOCALIP` and `CLOUDFLARE_API_TOKEN` as encrypted Worker secrets alongside the code using Wrangler's `--secrets-file` option. No manual `wrangler secret put` is required.

The deployment utility uses temporary files, restricts their permissions, and deletes them when the operation ends. The actual `.env` file remains excluded from Git. Never add credentials to `wrangler.jsonc` or `.env.example`.

You may also run `npm run deploy` inside `apps/ip-sync-worker`, which calls the same utility. Direct `npx wrangler deploy` bypasses the automatic environment provisioning and is **not** recommended.

The token must have both Worker deployment permissions (**Workers Scripts Edit**) and the runtime permissions required to read zones/rulesets and edit account IP lists. `DRY_RUN=true` produces only verification logs; `DRY_RUN=false` allows publishing on the **next scheduled execution**, assuming the token and safety checks pass. Deployment alone does not trigger the cron.

## Validation

```sh
npm ci
npm run check
npm run check:deploy
npm run test --workspace @revrebel/ip-sync-worker
```

Worker cron: Monday and Thursday, 12:00 UTC. `workers_dev` and `preview_urls` remain disabled.
