import test from 'node:test';
import assert from 'node:assert/strict';
import {canonicalCidr, localIps, readProviders, syncIpList} from '../src/publisher.ts';

const source={id:'github',url:'https://feed.example/github',fields:['hooks'],minimum:1};
const config={sources:[source],maxEntries:10000,minimumRetentionFraction:0.5};
const env={DRY_RUN:'true',LOCALIP:'{203.0.113.10,203.0.113.10}',CLOUDFLARE_ACCOUNT_ID:'a'.repeat(32),CLOUDFLARE_LIST_ID:'b'.repeat(32)};
const json=(result,status=200)=>new Response(JSON.stringify(result),{status,headers:{'Content-Type':'application/json'}});
const feed=()=>json({hooks:['192.0.2.1/32','192.0.2.2/32','192.0.2.1']});
const kv=()=>{const values=new Map();return {get:async key=>values.get(key)??null,put:async(key,value)=>{values.set(key,value)},values}};
function fixture({legacy=false}={}){
  let items=['192.0.2.1/32'];let writes=0;
  const fetcher=async(url,options={})=>{
    const path=new URL(url).pathname;
    if(url==='https://feed.example/github')return feed();
    if(path.endsWith('/rules/lists'))return json({success:true,result:[{name:'linear_webhooks',kind:'ip',id:'b'.repeat(32)}]});
    if(path.endsWith('/items')){
      if(options.method==='PUT'){writes++;items=JSON.parse(options.body).map(x=>x.ip);return json({success:true,result:{operation_id:'f'.repeat(32)}})}
      return json({success:true,result:items.map(ip=>({ip})),result_info:{cursors:{}}});
    }
    if(path.endsWith('/bulk_operations/'+'f'.repeat(32)))return json({success:true,result:{status:'completed'}});
    if(path==='/client/v4/zones')return json({success:true,result:[{id:'z'.repeat(32),name:'example.org'}]});
    if(path.endsWith('/entrypoint'))return json({success:true,result:{rules:legacy?[{enabled:true,expression:'ip.src in $linear_webhooks'}]:[]}});
    throw Error('Unexpected HTTP request '+url);
  };
  return {fetcher,get writes(){return writes},get items(){return items}};
}

test('normalizes IP hosts and rejects invalid and overly broad CIDRs',()=>{
  assert.equal(canonicalCidr('203.0.113.5'),'203.0.113.5/32');
  assert.equal(canonicalCidr('2001:db8::1'),'2001:db8::1/128');
  for(const v of ['256.1.2.3','1.2.3.4/0','1.2.3.4/33','1.2.3.4/-1','::/0','2001:bad::z'])assert.throws(()=>canonicalCidr(v));
});
test('LOCALIP supports duplicates and braces',()=>{
  assert.deepEqual(localIps('{67.168.139.148,67.168.139.148/32,67.168.139.149}'),['67.168.139.148/32','67.168.139.149/32']);
  assert.throws(()=>localIps(''),/LOCALIP/);
});
test('missing or invalid feeds fail before publication',async()=>{
  await assert.rejects(readProviders([source],async()=>json({hooks:[]})),/too few/);
  await assert.rejects(readProviders([source],async()=>json({hooks:['0.0.0.0\/0']})),/broad/);
});
test('dry run does not call Cloudflare API',async()=>{
  const result=await syncIpList(env,config,async url=>{assert.equal(url,'https://feed.example/github');return feed()});
  assert.deepEqual(result,{status:'dry-run',count:3});
});
test('publishing requires KV for durable backups',async()=>{
  await assert.rejects(syncIpList({...env,DRY_RUN:'false',CLOUDFLARE_API_TOKEN:'test'},config,async()=>feed()),/IP_SYNC_STATE/);
});
test('active legacy webhook list rule blocks publishing without mutations',async()=>{
  const f=fixture({legacy:true});
  await assert.rejects(syncIpList({...env,DRY_RUN:'false',CLOUDFLARE_API_TOKEN:'test',IP_SYNC_STATE:kv()},config,f.fetcher),/still references/);
  assert.equal(f.writes,0);
});
test('publisher backs up, replaces, polls, reads back and checkpoints',async()=>{
  const f=fixture();const state=kv();
  const result=await syncIpList({...env,DRY_RUN:'false',CLOUDFLARE_API_TOKEN:'test',IP_SYNC_STATE:state},config,f.fetcher);
  assert.equal(result.status,'published');
  assert.equal(f.writes,1);
  assert.deepEqual(f.items,['192.0.2.1/32','192.0.2.2/32','203.0.113.10/32']);
  assert.equal(JSON.parse(await state.get('last-good')).counts.github,2);
  assert.equal([...state.values.keys()].filter(x=>x.startsWith('backup:')).length,1);
});
