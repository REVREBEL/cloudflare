import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, chmodSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const source = join(dirname(fileURLToPath(import.meta.url)), '../../../scripts/deploy-ip-sync.mjs');

function fixture(missing = '') {
  const folder = mkdtempSync(join(tmpdir(), 'ip-sync-deploy-test-'));
  const app = join(folder, 'apps/ip-sync-worker');
  const scripts = join(folder, 'scripts');
  const bin = join(folder, 'bin');
  mkdirSync(app, {recursive:true});
  mkdirSync(scripts);
  mkdirSync(bin);
  copyFileSync(source, join(scripts, 'deploy-ip-sync.mjs'));
  writeFileSync(join(app, 'wrangler.jsonc'), JSON.stringify({
    name:'revrebel-ip-sync', main:'src/index.ts', vars:{CLOUDFLARE_LIST_ID:'c'.repeat(32)},
    triggers:{crons:['0 12 * * 1,4']}
  }));
  const vals = {
    DOMAIN:'revrebel.io', CLOUDFLARE_API_TOKEN:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    CLOUDFLARE_ACCOUNT_ID:'a'.repeat(32), CLOUDFLARE_ZONE_ID:'b'.repeat(32),
    LOCALIP:'{192.0.2.10,192.0.2.10}', DRY_RUN:'true',
  };
  delete vals[missing];
  writeFileSync(join(app, '.env'), Object.entries(vals).map(([k,v])=>k+'="'+v+'"').join('\n')+'\n');
  const capture = join(folder, 'captured.json');
  const fake = join(bin, 'npm');
  writeFileSync(fake, [
    '#!/usr/bin/env node',
    "const fs=require('node:fs');",
    'const args=process.argv.slice(2);',
    "const config=args[args.indexOf('--config')+1];",
    "const secret=args[args.indexOf('--secrets-file')+1];",
    'fs.writeFileSync(process.env.CAPTURE,JSON.stringify({args,',
    "vars:JSON.parse(fs.readFileSync(config,'utf8')).vars,",
    "secrets:JSON.parse(fs.readFileSync(secret,'utf8')),",
    "tokenAvailable:process.env.CLOUDFLARE_API_TOKEN==='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'}));"
  ].join('\n')+'\n');
  chmodSync(fake,0o700);
  return {
    folder,capture,run(){
      const env={...process.env, PATH:bin+delimiter+process.env.PATH, CAPTURE:capture};
      for(const k of ['DOMAIN','CLOUDFLARE_API_TOKEN','CLOUDFLARE_ACCOUNT_ID','CLOUDFLARE_ZONE_ID','LOCALIP','DRY_RUN']) delete env[k];
      return spawnSync(process.execPath,[join(scripts,'deploy-ip-sync.mjs')],{env,encoding:'utf8'});
    },
    cleanup(){rmSync(folder,{recursive:true,force:true})},
  };
}
test('deploy reads .env, injects runtime bindings and uploads only selected secrets',()=>{
  const f=fixture();
  try{
    const r=f.run();
    assert.equal(r.status,0,r.stderr);
    const result=JSON.parse(readFileSync(f.capture,'utf8'));
    assert.equal(result.vars.DRY_RUN,'true');
    assert.equal(result.vars.DOMAIN,'revrebel.io');
    assert.equal(result.vars.CLOUDFLARE_ZONE_ID,'b'.repeat(32));
    assert.equal(result.secrets.LOCALIP,'{192.0.2.10,192.0.2.10}');
    assert.equal(result.secrets.CLOUDFLARE_API_TOKEN,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    assert.deepEqual(Object.keys(result.secrets).sort(),['CLOUDFLARE_API_TOKEN','LOCALIP']);
    assert.ok(result.tokenAvailable);
    assert.ok(result.args.includes('--secrets-file'));
    assert.ok(!r.stdout.includes('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'));
    assert.ok(!r.stdout.includes('192.0.2.10'));
  }finally{f.cleanup()}
});
test('Bearer prefix is stripped without revealing the credential',()=>{
  const f=fixture();
  try {
    const envPath=join(f.folder,'apps/ip-sync-worker/.env');
    const current=readFileSync(envPath,'utf8');
    writeFileSync(envPath,current.replace('CLOUDFLARE_API_TOKEN="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"','CLOUDFLARE_API_TOKEN="Bearer aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"'));
    const r=f.run();
    assert.equal(r.status,0,r.stderr);
    assert.equal(JSON.parse(readFileSync(f.capture,'utf8')).secrets.CLOUDFLARE_API_TOKEN,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    assert.ok(!r.stdout.includes('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'));
  } finally {f.cleanup()}
});
test('malformed token fails before invoking Wrangler',()=>{
  const f=fixture();
  try {
    const envPath=join(f.folder,'apps/ip-sync-worker/.env');
    writeFileSync(envPath,readFileSync(envPath,'utf8').replace('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','https://invalid/token'));
    const r=f.run();
    assert.notEqual(r.status,0);
    assert.match(r.stderr,/not a validly formatted API token/);
  } finally {f.cleanup()}
});
test('missing required env blocks deployment before invoking Wrangler',()=>{
  const f=fixture('LOCALIP');
  try{
    const r=f.run();
    assert.notEqual(r.status,0);
    assert.match(r.stderr,/LOCALIP/);
  }finally{f.cleanup()}
});
