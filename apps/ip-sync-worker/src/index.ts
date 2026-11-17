import config from '../../../config/sources.json';
import { syncIpList, type SyncEnv } from './publisher';

export default {
  async scheduled(_event: ScheduledEvent, env: SyncEnv, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(syncIpList(env, config).then(result => {
      console.log(JSON.stringify({ event: 'ip-sync-result', ...result }));
    }));
  },
  async fetch(): Promise<Response> {
    return new Response('Not found', { status: 404 });
  },
};
