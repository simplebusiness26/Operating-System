import controlPlane from './control-entry';
import { orchestrationApi } from './orchestration';
import type { RuntimeEnv } from './env';
import { json } from './utils';

export default {
  async fetch(request: Request, env: RuntimeEnv, ctx: ExecutionContext): Promise<Response> {
    try {
      const handled = await orchestrationApi(request, env);
      if (handled) return handled;
      return controlPlane.fetch(request, env, ctx);
    } catch (error) {
      console.error(JSON.stringify({
        level: 'error',
        subsystem: 'orchestration-entry',
        message: error instanceof Error ? error.message : String(error),
      }));
      return json({ error: error instanceof Error ? error.message : 'Internal server error' }, { status: 500 });
    }
  },

  async scheduled(controller: ScheduledController, env: RuntimeEnv, ctx: ExecutionContext): Promise<void> {
    return controlPlane.scheduled(controller, env, ctx);
  },
} satisfies ExportedHandler<RuntimeEnv>;
