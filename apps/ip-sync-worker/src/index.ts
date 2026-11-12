import config from "../../../config/sources.json";

type Source = (typeof config.sources)[number];
interface Env {
  DRY_RUN: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDFLARE_LIST_ID: string;
  CLOUDFLARE_API_TOKEN?: string;
}
type Snapshot = { name: string; entries: string[] };

function readField(record: unknown, field: string): string[] {
  const object = record as Record<string, unknown>;
  if (field.includes("[].")) {
    const [arrayKey, member] = field.split("[].");
    const entries = object[arrayKey];
    if (!Array.isArray(entries)) return [];
    return entries.map(item => (item as Record<string, unknown>)?.[member]).filter((x): x is string => typeof x === "string");
  }
  const entries = object[field];
  return Array.isArray(entries) ? entries.filter((x): x is string => typeof x === "string") : [];
}

function ipv4Valid(ip: string): boolean {
  const octets = ip.split(".");
  return octets.length === 4 && octets.every(o => /^\d{1,3}$/.test(o) && Number(o) <= 255 && String(Number(o)) === o);
}
function validCidr(value: string): boolean {
  const [address, bits, extra] = value.split("/");
  if (!address || extra !== undefined) return false;
  if (address.includes(":")) {
    // Conservative syntax check: no zone identifiers or malformed characters.
    return /^[0-9a-fA-F:]+$/.test(address) && address.includes(":") &&
      (bits === undefined || (/^\d+$/.test(bits) && Number(bits) <= 128));
  }
  return ipv4Valid(address) && (bits === undefined || (/^\d+$/.test(bits) && Number(bits) <= 32));
}
function canonical(value: string): string {
  return value.includes("/") ? value : value + (value.includes(":") ? "/128" : "/32");
}

async function retrieve(source: Source): Promise<Snapshot> {
  const response = await fetch(source.url, { headers: { Accept: "application/json", "User-Agent": "REVREBEL-IP-Sync/1.0" }, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(source.id + " returned HTTP " + response.status);
  const payload: unknown = await response.json();
  if (!payload || typeof payload !== "object") throw new Error(source.id + " returned invalid JSON");
  const values = [...new Set(source.fields.flatMap(field => readField(payload, field)).map(canonical))];
  if (values.length < source.minimum || values.some(value => !validCidr(value))) throw new Error(source.id + " returned invalid or incomplete IP ranges");
  return { name: source.id, entries: values.sort() };
}

async function run(env: Env): Promise<void> {
  // Never partially publish an incomplete feed. Fail closed on any source error.
  const snapshots = await Promise.all(config.sources.map(retrieve));
  const entries = [...new Set([...snapshots.flatMap(s => s.entries), ...config.staticIps.map(canonical)])].sort();
  if (entries.some(ip => !validCidr(ip)) || entries.length > config.maxEntries) throw new Error("Merged list failed validation");
  console.log(JSON.stringify({ event: "ip-sync-plan", count: entries.length, providers: snapshots.map(s => ({ name: s.name, count: s.entries.length })), dryRun: env.DRY_RUN !== "false" }));
  // Intentional deployment gate: a separate reviewed implementation will update
  // Cloudflare only after list reconciliation, backup, and bulk-operation checks.
  if (env.DRY_RUN === "false") throw new Error("Publishing disabled until reviewed safe-apply implementation is merged");
}

export default {
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(run(env));
  },
  async fetch(): Promise<Response> {
    return new Response("Not found", { status: 404 });
  },
};
