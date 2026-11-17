#!/usr/bin/env node
/**
 * Deploy the IP-sync Worker using a local .env without committing credentials.
 * Requires Node.js >=20.12 and Wrangler from the npm workspace.
 *
 * Public runtime vars: DOMAIN, CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_ZONE_ID,
 *                      CLOUDFLARE_LIST_ID, DRY_RUN.
 * Encrypted Worker secrets: CLOUDFLARE_API_TOKEN, LOCALIP.
 */
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { spawnSync } from 'node:child_process';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const worker = join(repo, 'apps', 'ip-sync-worker');
const configPath = join(worker, 'wrangler.jsonc');
const localPath = join(worker, '.env');
const rootPath = join(repo, '.env');

function fail(message) { throw new Error(message); }

let values = {};
for (const file of [rootPath, localPath]) {
  if (existsSync(file)) values = { ...values, ...parseEnv(readFileSync(file, 'utf8')) };
}
if (!existsSync(rootPath) && !existsSync(localPath)) {
  fail('Missing .env. Copy apps/ip-sync-worker/.env.example to apps/ip-sync-worker/.env');
}
// Environment already set in the process wins, for CI/noninteractive deployments.
values = { ...values, ...Object.fromEntries(
  ['DOMAIN', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID',
   'CLOUDFLARE_ZONE_ID', 'CLOUDFLARE_LIST_ID', 'LOCALIP', 'DRY_RUN']
    .filter(key => process.env[key] !== undefined)
    .map(key => [key, process.env[key]])
) };

for (const key of ['DOMAIN', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID',
                   'CLOUDFLARE_ZONE_ID', 'LOCALIP', 'DRY_RUN']) {
  if (!values[key]?.trim()) fail('Missing required environment variable: ' + key);
}
if (!/^[0-9a-f]{32}$/i.test(values.CLOUDFLARE_ACCOUNT_ID)) fail('CLOUDFLARE_ACCOUNT_ID must be 32 hexadecimal characters');
if (!/^[0-9a-f]{32}$/i.test(values.CLOUDFLARE_ZONE_ID)) fail('CLOUDFLARE_ZONE_ID must be 32 hexadecimal characters');
if (values.CLOUDFLARE_LIST_ID && !/^[0-9a-f]{32}$/i.test(values.CLOUDFLARE_LIST_ID)) fail('Invalid CLOUDFLARE_LIST_ID');
if (!/^(true|false)$/.test(values.DRY_RUN)) fail('DRY_RUN must be exactly true or false');
if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(values.DOMAIN)) fail('DOMAIN must be a DNS name, without https:// or a path');
if (!/^[\s{}[\],0-9a-fA-F:./"'\r\n-]+$/.test(values.LOCALIP)) fail('LOCALIP contains unsupported characters');

const config = JSON.parse(readFileSync(configPath, 'utf8'));
config.vars = {
  ...config.vars,
  DOMAIN: values.DOMAIN,
  CLOUDFLARE_ACCOUNT_ID: values.CLOUDFLARE_ACCOUNT_ID,
  CLOUDFLARE_ZONE_ID: values.CLOUDFLARE_ZONE_ID,
  DRY_RUN: values.DRY_RUN,
};
if (values.CLOUDFLARE_LIST_ID) config.vars.CLOUDFLARE_LIST_ID = values.CLOUDFLARE_LIST_ID;

let directory;
let temporaryConfig;
try {
  directory = mkdtempSync(join(tmpdir(), 'revrebel-ip-sync-'));
  // Wrangler resolves the script entry relative to its config, so keep a
  // short-lived config in the Worker directory. It contains no credentials.
  temporaryConfig = join(worker, '.wrangler-deploy-' + process.pid + '.jsonc');
  writeFileSync(temporaryConfig, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });

  const secrets = join(directory, 'worker-secrets.json');
  writeFileSync(secrets, JSON.stringify({
    CLOUDFLARE_API_TOKEN: values.CLOUDFLARE_API_TOKEN,
    LOCALIP: values.LOCALIP,
  }), { mode: 0o600 });

  console.log('Deploying ' + config.name + ' for ' + values.DOMAIN +
    ' (DRY_RUN=' + values.DRY_RUN + ', secrets provided automatically).');

  // Run the workspace-installed Wrangler. The token is passed as an
  // environment variable, never on the command line or in Git.
  const result = spawnSync('npm',
    ['exec', '--', 'wrangler', 'deploy', '--config', temporaryConfig,
     '--secrets-file', secrets], {
      cwd: worker,
      env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: values.CLOUDFLARE_ACCOUNT_ID,
             CLOUDFLARE_API_TOKEN: values.CLOUDFLARE_API_TOKEN },
      stdio: 'inherit',
    });
  if (result.error) throw result.error;
  if (result.status !== 0) fail('Wrangler deployment failed (exit ' + result.status + ')');
  console.log('Deployment complete. Secrets were uploaded alongside Worker code.');
} finally {
  if (temporaryConfig) rmSync(temporaryConfig, { force: true });
  if (directory) rmSync(directory, { recursive: true, force: true });
}
