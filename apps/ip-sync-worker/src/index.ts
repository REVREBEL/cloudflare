import config from "../../../config/sources.json";

type Source = (typeof config.sources)[number];
interface Env {
  DRY_RUN: string;
  LOCALIP?: string;
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

// Accept comma/newline-separated IPs, optionally wrapped in braces or JSON brackets.
// Examples: LOCALIP="{192.0.2.10, 192.0.2.11/32}" or LOCALIP='["192.0.2.10"]'.
function parseLocalIps(raw: string | undefined): { entries: string[]; supplied: number; duplicatesRemoved: number } {
  if (typeof raw !== "string" || !raw.trim()) throw new Error("LOCALIP must be configured with at least one trusted IP");
  let value = raw.trim();
  if ((value.startsWith("{") && value.endsWith("}")) || (value.startsWith("[") && value.endsWith("]"))) {
    value = value.slice(1, -1);
  } else if (value.startsWith("{") || value.endsWith("}") || value.startsWith("[") || value.endsWith("]")) {
    throw new Error("LOCALIP has unmatched delimiters");
  }
  const input = value.split(/[,\n\r]+/).map(x => x.trim().replace(/^["']|["']$/g, "").trim()).filter(Boolean);
  if (input.length === 0) throw new Error("LOCALIP must contain at least one IP address");
  // Reject malformed values rather than silently deleting one of the trusted addresses.
  const entries = input.map(canonical);
  if (entries.some(ip => !validCidr(ip))) throw new Error("LOCALIP includes an invalid IPv4/IPv6 CIDR");
  const unique = [...new Set(entries)].sort();
  return { entries: unique, supplied: input.length, duplicatesRemoved: input.length - unique.length };
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
  const local = parseLocalIps(env.LOCALIP);
  const snapshots = await Promise.all(config.sources.map(retrieve));
  const providerEntries = snapshots.flatMap(s => s.entries);
  const entries = [...new Set([...providerEntries, ...local.entries])].sort();
  const verification = {
    localIpPresent: local.entries.every(ip => entries.includes(ip)),
    localIpCount: local.entries.length,
    localDuplicatesRemoved: local.duplicatesRemoved,
    providerEntries: providerEntries.length,
    uniqueEntries: entries.length,
    duplicatesRemoved: providerEntries.length + local.supplied - entries.length,
    duplicatesRemaining: entries.length - new Set(entries).size,
  };
  console.log(JSON.stringify({ event: "ip-sync-verification", ...verification }));
  if (!verification.localIpPresent || verification.duplicatesRemaining !== 0) throw new Error("Merged IP list verification failed");
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
