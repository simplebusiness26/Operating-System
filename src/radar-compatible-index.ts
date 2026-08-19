import orchestrated from './orchestrated-index';
import type { RuntimeEnv } from './env';
import { json } from './utils';

type CompatEnv = RuntimeEnv & {
  RADAR_INGRESS_TOKEN?: string;
  FACTORY_URL?: string;
  FACTORY_WRITE_TOKEN?: string;
  FACTORY_RESULT_TOKEN?: string;
  RADAR_FEEDBACK_URL?: string;
  RADAR_FEEDBACK_TOKEN?: string;
};

type AnyRecord = Record<string, unknown>;

function object(value: unknown): AnyRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as AnyRecord : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function list(value: unknown): string[] {
  return Array.isArray(value) ? value.map(text).filter(Boolean) : [];
}

function nativeRadarEnvelope(body: AnyRecord): AnyRecord {
  const brief = object(body.brief);
  const input = object(brief.input);
  const readiness = object(brief.readiness);
  const validation = object(input.validation);

  const criticalUnknowns = list(input.criticalUnknowns);
  const assumptions = list(input.assumptions);
  const explicitConstraints = list(body.constraints);
  const readinessReason = text(readiness.reason);
  const successThreshold = text(validation.successThreshold);

  return {
    ...body,
    title: text(body.title) || text(brief.headline) || text(input.title),
    summary: text(body.summary) || text(input.thesis) || text(input.problemStatement),
    objective: text(body.objective) || text(brief.headline) || text(input.title),
    confidence: typeof input.confidence === 'number' ? input.confidence : body.confidence,
    constraints: [...explicitConstraints, ...criticalUnknowns, ...assumptions, ...(readinessReason ? [readinessReason] : [])].slice(0, 30),
    successCriteria: successThreshold ? [successThreshold] : list(body.successCriteria)
  };
}

async function handleRadar(request: Request, env: CompatEnv, ctx: ExecutionContext): Promise<Response> {
  const raw = await request.text();
  let parsed: AnyRecord;
  try { parsed = JSON.parse(raw) as AnyRecord; } catch { return json({ error: 'Invalid JSON' }, { status: 400 }); }

  const normalized = nativeRadarEnvelope(parsed);
  const forwarded = new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: JSON.stringify(normalized)
  });
  const response = await orchestrated.fetch(forwarded, env, ctx);
  if (!response.ok) return response;

  const payload = await response.json().catch(() => null) as AnyRecord | null;
  if (!payload) return response;
  const recommendation = object(payload.recommendation);
  const id = text(recommendation.id);
  return json({ ...payload, id: id || undefined, externalRef: id || undefined }, { status: response.status });
}

export default {
  async fetch(request: Request, env: CompatEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/api/integrations/radar/handoffs' && request.method === 'POST') {
      return handleRadar(request, env, ctx);
    }
    return orchestrated.fetch(request, env, ctx);
  },
  async scheduled(controller: ScheduledController, env: CompatEnv, ctx: ExecutionContext): Promise<void> {
    if (orchestrated.scheduled) await orchestrated.scheduled(controller, env, ctx);
  }
} satisfies ExportedHandler<CompatEnv>;
