export interface SyncEnv {
  DRY_RUN?: string;
  LOCALIP?: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDFLARE_LIST_ID: string;
  CLOUDFLARE_API_TOKEN?: string;
  IP_SYNC_STATE?: {
    get(key: string): Promise<string | null>;
    put(key: string, value: string): Promise<void>;
  };
}
export type ProviderSpec = { id: string; url: string; fields: string[]; minimum: number };
export type SyncConfiguration = { sources: ProviderSpec[]; maxEntries: number; minimumRetentionFraction: number };
type Envelope<T> = { success: boolean; result: T; errors?: Array<{message:string}>; result_info?: { cursors?: {after?:string} } };
type Fetcher = typeof fetch;

export function canonicalCidr(input: string): string {
  const parts = input.trim().split('/');
  if (parts.length > 2 || !parts[0]) throw Error('Invalid CIDR');
  const ip = parts[0];
  const octets = ip.split('.');
  if (octets.length === 4 && octets.every(x => /^(0|[1-9][0-9]{0,2})$/.test(x) && +x <= 255)) {
    const n = parts.length === 2 ? +parts[1] : 32;
    if ((parts.length === 2 && !/^\d+$/.test(parts[1])) || !Number.isInteger(n) || n < 8 || n > 32) throw Error('Invalid/overly broad IPv4 CIDR');
    return ip + '/' + n;
  }
  if (!ip.includes(':') || !/^[0-9a-fA-F:.]+$/.test(ip)) throw Error('Invalid IP');
  let parsed: string;
  try { parsed = new URL('http://[' + ip + ']/').hostname.slice(1, -1); }
  catch { throw Error('Invalid IPv6 address'); }
  const n = parts.length === 2 ? +parts[1] : 128;
  if ((parts.length === 2 && !/^\d+$/.test(parts[1])) || !Number.isInteger(n) || n < 24 || n > 128) throw Error('Invalid/overly broad IPv6 CIDR');
  return parsed.toLowerCase() + '/' + n;
}

export function localIps(raw?: string): string[] {
  if (!raw?.trim()) throw Error('LOCALIP missing');
  const value = raw.trim();
  const wrapped = (value.startsWith('{') && value.endsWith('}')) || (value.startsWith('[') && value.endsWith(']'));
  if (!wrapped && /[{}\[\]]/.test(value)) throw Error('LOCALIP unmatched delimiters');
  const inner = wrapped ? value.slice(1, -1) : value;
  const parts = inner.split(/[,\r\n]+/).map(x => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  if (!parts.length) throw Error('LOCALIP empty');
  return [...new Set(parts.map(canonicalCidr))].sort();
}

function extract(data: unknown, field: string): string[] {
  if (!data || typeof data !== 'object') return [];
  const obj = data as Record<string, unknown>;
  if (field.includes('[].')) {
    const [key, member] = field.split('[].');
    return Array.isArray(obj[key]) ? obj[key].map(v => (v as Record<string,unknown>)?.[member]).filter((v):v is string => typeof v === 'string') : [];
  }
  return Array.isArray(obj[field]) ? obj[field].filter((v):v is string => typeof v === 'string') : [];
}
export async function readProviders(sources: ProviderSpec[], fetcher: Fetcher = fetch) {
  return Promise.all(sources.map(async source => {
    const response = await fetcher(source.url, {headers:{Accept:'application/json','User-Agent':'REVREBEL-IP-Sync/1.0'},signal:AbortSignal.timeout(15000)});
    if (!response.ok) throw Error('Provider ' + source.id + ' HTTP ' + response.status);
    const payload = await response.json();
    const values = source.fields.flatMap(field => extract(payload,field));
    if (values.length < source.minimum) throw Error('Provider ' + source.id + ' returned too few IPs');
    const entries = [...new Set(values.map(canonicalCidr))].sort();
    if (entries.length < source.minimum) throw Error('Provider ' + source.id + ' has too few unique IPs');
    return {name:source.id,entries};
  }));
}

function accountBase(env:SyncEnv) {
  if (!/^[a-f0-9]{32}$/.test(env.CLOUDFLARE_ACCOUNT_ID) || !/^[a-f0-9]{32}$/.test(env.CLOUDFLARE_LIST_ID)) throw Error('Invalid Cloudflare identifiers');
  return 'https://api.cloudflare.com/client/v4/accounts/' + env.CLOUDFLARE_ACCOUNT_ID;
}
async function api<T>(env:SyncEnv, path:string, fetcher:Fetcher, method='GET', body?:unknown):Promise<Envelope<T>> {
  if (!env.CLOUDFLARE_API_TOKEN) throw Error('CLOUDFLARE_API_TOKEN secret missing');
  const response = await fetcher(accountBase(env)+path,{method,
    headers:{Authorization:'Bearer '+env.CLOUDFLARE_API_TOKEN,Accept:'application/json',...(body===undefined?{}:{'Content-Type':'application/json'})},
    ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(30000)});
  let result:Envelope<T>;
  try { result = await response.json() as Envelope<T>; } catch { throw Error('Cloudflare returned invalid JSON'); }
  if (!response.ok || !result.success) throw Error('Cloudflare API HTTP '+response.status+': '+(result.errors||[]).map(x=>x.message).join('; '));
  return result;
}
export async function readList(env:SyncEnv,fetcher:Fetcher=fetch):Promise<string[]> {
  const list = new Set<string>();
  let cursor:string|undefined;
  do {
    const query = '/rules/lists/'+env.CLOUDFLARE_LIST_ID+'/items?per_page=500'+(cursor?'&cursor='+encodeURIComponent(cursor):'');
    const result = await api<Array<{ip:string}>>(env,query,fetcher);
    result.result.forEach(row=>list.add(canonicalCidr(row.ip)));
    const next=result.result_info?.cursors?.after;
    if (next && next===cursor) throw Error('Repeated pagination cursor');
    cursor=next;
    if(list.size>15000) throw Error('Oversized list');
  } while(cursor);
  return [...list].sort();
}
export async function assertNoWafReferences(env:SyncEnv,fetcher:Fetcher=fetch):Promise<void> {
  const list=await api<Array<{id:string;name:string;kind:string}>>(env,'/rules/lists',fetcher);
  const target=list.result.find(x=>x.id===env.CLOUDFLARE_LIST_ID);
  if(!target||target.kind!=='ip') throw Error('Target IP list not found');
  const headers={Authorization:'Bearer '+env.CLOUDFLARE_API_TOKEN,Accept:'application/json'};
  for(let page=1;page<=20;page++){
    const response=await fetcher('https://api.cloudflare.com/client/v4/zones?account.id='+env.CLOUDFLARE_ACCOUNT_ID+'&per_page=50&page='+page,{headers});
    if(!response.ok) throw Error('Cannot enumerate zones: '+response.status);
    const data=await response.json() as Envelope<Array<{id:string;name:string}>>;
    if(!data.success) throw Error('Cannot enumerate zones');
    for(const zone of data.result){
      const r=await fetcher('https://api.cloudflare.com/client/v4/zones/'+zone.id+'/rulesets/phases/http_request_firewall_custom/entrypoint',{headers});
      if(r.status===404) continue;
      if(!r.ok) throw Error('Cannot verify WAF rules on '+zone.name);
      const waf=await r.json() as Envelope<{rules?:Array<{enabled?:boolean;expression:string}>}>;
      if(!waf.success) throw Error('Unable to verify WAF on '+zone.name);
      if(waf.result.rules?.some(rule=>rule.enabled!==false&&rule.expression.includes('$'+target.name)))
        throw Error('Active WAF rule on '+zone.name+' still references $'+target.name+'; migrate provider-specific rule first');
    }
    if(data.result.length<50) return;
  }
  throw Error('Too many zones to verify');
}
async function replace(env:SyncEnv,ips:string[],fetcher:Fetcher) {
  const r=await api<{operation_id:string}>(env,'/rules/lists/'+env.CLOUDFLARE_LIST_ID+'/items',fetcher,'PUT',ips.map(ip=>({ip})));
  const id=r.result.operation_id;
  if(!/^[a-f0-9]{32}$/.test(id)) throw Error('Missing Cloudflare operation id');
  for(let attempt=0;attempt<30;attempt++){
    const status=await api<{status:string;error?:string}>(env,'/rules/lists/bulk_operations/'+id,fetcher);
    if(status.result.status==='completed') return id;
    if(status.result.status==='failed') throw Error('List update failed: '+status.result.error);
    if(!['pending','running'].includes(status.result.status)) throw Error('Unknown list operation state');
    await new Promise(resolve=>setTimeout(resolve,2000));
  }
  throw Error('List operation '+id+' still running: check before retrying');
}
export async function syncIpList(env:SyncEnv,config:SyncConfiguration,fetcher:Fetcher=fetch){
  const local=localIps(env.LOCALIP);
  const providers=await readProviders(config.sources,fetcher);
  const entries=[...new Set([...local,...providers.flatMap(p=>p.entries)])].sort();
  if(entries.length>config.maxEntries||entries.length<config.sources.reduce((n,p)=>n+p.minimum,0)) throw Error('Merged list outside safe limits');
  const previous=env.IP_SYNC_STATE?await env.IP_SYNC_STATE.get('last-good'):null;
  if(previous){
    const counts=(JSON.parse(previous) as {counts:Record<string,number>}).counts;
    for(const provider of providers) if(counts[provider.name]&&provider.entries.length<counts[provider.name]*config.minimumRetentionFraction)
      throw Error('Provider '+provider.name+' lost too many entries');
  }
  console.log(JSON.stringify({event:'ip-sync-verification',localIpPresent:local.every(x=>entries.includes(x)),localIpCount:local.length,duplicatesRemaining:0,
    count:entries.length,providers:providers.map(p=>({name:p.name,count:p.entries.length})),dryRun:env.DRY_RUN!=='false'}));
  if(env.DRY_RUN!=='false') return {status:'dry-run',count:entries.length};
  if(!env.IP_SYNC_STATE) throw Error('IP_SYNC_STATE KV binding required');
  const old=await readList(env,fetcher);
  const current=new Set(old),future=new Set(entries);
  const additions=entries.filter(x=>!current.has(x)).length;
  const removals=old.filter(x=>!future.has(x)).length;
  if(old.length && removals/old.length>0.2) throw Error('More than 20% of current IPs would be removed');
  const lastGood=JSON.stringify({counts:Object.fromEntries(providers.map(p=>[p.name,p.entries.length])),timestamp:new Date().toISOString()});
  if(additions===0&&removals===0){
    await env.IP_SYNC_STATE.put('last-good',lastGood);
    console.log(JSON.stringify({event:'ip-sync-unchanged',count:entries.length}));
    return {status:'unchanged',count:entries.length};
  }
  await assertNoWafReferences(env,fetcher);
  const backup='backup:'+new Date().toISOString();
  await env.IP_SYNC_STATE.put(backup,JSON.stringify({entries:old}));
  console.log(JSON.stringify({event:'ip-sync-backup',key:backup,count:old.length}));
  const operation=await replace(env,entries,fetcher);
  const verified=await readList(env,fetcher);
  if(verified.length!==entries.length||verified.some((ip,i)=>ip!==entries[i])){
    console.error(JSON.stringify({event:'ip-sync-mismatch',backup,operation}));
    throw Error('Read-back verification failed, preserved backup '+backup);
  }
  await env.IP_SYNC_STATE.put('last-good',lastGood);
  console.log(JSON.stringify({event:'ip-sync-published',count:entries.length,additions,removals,operation,backup}));
  return {status:'published',count:entries.length,additions,removals};
}
