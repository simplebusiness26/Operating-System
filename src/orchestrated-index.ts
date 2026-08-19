import core from './index';
import { ensureProject, insertEvent } from './db';
import { generateDailyBrief, runPipeline } from './agents';
import type { RuntimeEnv } from './env';
import type { Json } from './types';
import { constantTimeSecretEquals, json, nowIso, uid } from './utils';

type OrchestrationEnv = RuntimeEnv & {
  RADAR_INGRESS_TOKEN?: string;
  FACTORY_URL?: string;
  FACTORY_WRITE_TOKEN?: string;
  FACTORY_RESULT_TOKEN?: string;
  RADAR_FEEDBACK_URL?: string;
  RADAR_FEEDBACK_TOKEN?: string;
};

type AnyRecord = Record<string, unknown>;

const stringValue = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const arrayOfStrings = (value: unknown): string[] => Array.isArray(value) ? value.map(stringValue).filter(Boolean).slice(0, 30) : [];

function nested(body: AnyRecord, path: string): unknown {
  let current: unknown = body;
  for (const key of path.split('.')) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = (current as AnyRecord)[key];
  }
  return current;
}

function firstString(body: AnyRecord, paths: string[]): string {
  for (const path of paths) {
    const value = stringValue(nested(body, path));
    if (value) return value;
  }
  return '';
}

function firstArray(body: AnyRecord, paths: string[]): string[] {
  for (const path of paths) {
    const value = arrayOfStrings(nested(body, path));
    if (value.length) return value;
  }
  return [];
}

async function sha256(text: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
}

async function secretAllowed(request: Request, expected: string | undefined, fallbackHeader: string): Promise<boolean> {
  if (!expected) return false;
  const auth = request.headers.get('authorization') ?? '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const supplied = bearer || request.headers.get(fallbackHeader) || '';
  return supplied ? constantTimeSecretEquals(supplied, expected) : false;
}

async function osAuthorized(request: Request, env: OrchestrationEnv): Promise<boolean> {
  if (env.REQUIRE_AUTH !== 'true') return true;
  return secretAllowed(request, env.OS_ACCESS_TOKEN, 'x-os-token');
}

function recommendationView(row: AnyRecord | null) {
  if (!row) return null;
  return {
    ...row,
    payload: safeParse(row.payload_json),
    payload_json: undefined
  };
}

function workOrderView(row: AnyRecord | null) {
  if (!row) return null;
  return {
    ...row,
    constraints: safeParse(row.constraints_json, []),
    acceptanceCriteria: safeParse(row.acceptance_criteria_json, []),
    authority: safeParse(row.authority_json, {}),
    source: safeParse(row.source_json, {}),
    constraints_json: undefined,
    acceptance_criteria_json: undefined,
    authority_json: undefined,
    source_json: undefined
  };
}

function safeParse(value: unknown, fallback: unknown = {}): unknown {
  if (typeof value !== 'string') return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

async function recordEvent(env: OrchestrationEnv, ctx: ExecutionContext, input: Parameters<typeof insertEvent>[1]) {
  const event = await insertEvent(env.DB, input);
  await runPipeline(env.DB, event);
  ctx.waitUntil(generateDailyBrief(env.DB));
  return event;
}

async function receiveRadarHandoff(request: Request, env: OrchestrationEnv, ctx: ExecutionContext): Promise<Response> {
  if (!(await secretAllowed(request, env.RADAR_INGRESS_TOKEN, 'x-radar-token'))) {
    return json({ error: env.RADAR_INGRESS_TOKEN ? 'Unauthorized' : 'RADAR_INGRESS_TOKEN is not configured' }, { status: env.RADAR_INGRESS_TOKEN ? 401 : 503 });
  }
  const raw = await request.text();
  if (!raw || raw.length > 500_000) return json({ error: 'Invalid or oversized payload' }, { status: 400 });
  let body: AnyRecord;
  try { body = JSON.parse(raw) as AnyRecord; } catch { return json({ error: 'Invalid JSON' }, { status: 400 }); }

  const externalId = firstString(body, ['handoffId', 'id', 'opportunityId', 'opportunity.id', 'executionBrief.id']);
  const projectName = firstString(body, ['projectName', 'project.name', 'target.projectName', 'opportunity.projectName']);
  const title = firstString(body, ['title', 'opportunity.title', 'recommendation.title', 'executionBrief.title']) || 'Opportunity Radar recommendation';
  const summary = firstString(body, ['summary', 'recommendation', 'opportunity.summary', 'executionBrief.summary', 'objective']);
  const scoreRaw = nested(body, 'score') ?? nested(body, 'opportunity.score') ?? nested(body, 'confidence');
  const score = typeof scoreRaw === 'number' && Number.isFinite(scoreRaw) ? scoreRaw : null;
  const dedupeKey = await sha256(`opportunity-radar:${externalId || raw}`);
  const now = nowIso();
  const id = uid('rec');
  const projectId = projectName ? await ensureProject(env.DB, projectName) : null;

  const inserted = await env.DB.prepare(`
    INSERT OR IGNORE INTO recommendations
    (id, source_system, external_id, dedupe_key, project_id, project_name, title, summary, score, status, payload_json, received_at, updated_at)
    VALUES (?, 'opportunity-radar', ?, ?, ?, ?, ?, ?, ?, 'received', ?, ?, ?)
  `).bind(id, externalId || null, dedupeKey, projectId, projectName, title, summary, score, raw, now, now).run();

  const row = await env.DB.prepare('SELECT * FROM recommendations WHERE dedupe_key = ?').bind(dedupeKey).first<AnyRecord>();
  if (inserted.meta.changes) {
    await recordEvent(env, ctx, {
      title: `Radar recommendation: ${title}`,
      body: summary || 'Opportunity Radar delivered a recommendation for OS review.',
      type: 'idea',
      source: 'opportunity-radar',
      projectId,
      importance: score === null ? 60 : Math.max(0, Math.min(100, Math.round(score))),
      metadata: { recommendationId: row?.id as string, externalId: externalId || null } as Record<string, Json>,
      rawRef: externalId || null
    });
  }
  return json({ accepted: true, duplicate: !inserted.meta.changes, recommendation: recommendationView(row ?? null) }, { status: inserted.meta.changes ? 201 : 200 });
}

function buildWorkOrder(recommendation: AnyRecord, payload: AnyRecord, overrides: AnyRecord) {
  const projectName = stringValue(overrides.projectName) || stringValue(recommendation.project_name) || firstString(payload, ['projectName', 'project.name']);
  const repository = stringValue(overrides.repository) || firstString(payload, ['repository', 'repo', 'project.repo', 'target.repository']);
  const objective = stringValue(overrides.objective) || firstString(payload, ['objective', 'executionBrief.objective', 'recommendation', 'summary']) || stringValue(recommendation.title);
  const constraints = arrayOfStrings(overrides.constraints).length ? arrayOfStrings(overrides.constraints) : firstArray(payload, ['constraints', 'executionBrief.constraints']);
  const acceptanceCriteria = arrayOfStrings(overrides.acceptanceCriteria).length ? arrayOfStrings(overrides.acceptanceCriteria) : firstArray(payload, ['acceptanceCriteria', 'successCriteria', 'executionBrief.acceptanceCriteria']);
  return {
    id: uid('work'),
    recommendationId: String(recommendation.id),
    projectId: recommendation.project_id ? String(recommendation.project_id) : null,
    projectName,
    repository,
    objective,
    constraints,
    acceptanceCriteria,
    authority: {
      mayCreateBranch: true,
      mayOpenPullRequest: true,
      mayMerge: false,
      mayDeployProduction: false
    },
    source: {
      system: 'opportunity-radar',
      externalId: recommendation.external_id ? String(recommendation.external_id) : String(recommendation.id)
    }
  };
}

async function dispatchWorkOrder(env: OrchestrationEnv, id: string): Promise<{ delivered: boolean; response?: unknown; error?: string }> {
  const row = await env.DB.prepare('SELECT * FROM work_orders WHERE id = ?').bind(id).first<AnyRecord>();
  if (!row) return { delivered: false, error: 'Work order not found' };
  if (!env.FACTORY_URL || !env.FACTORY_WRITE_TOKEN) return { delivered: false, error: 'Factory connection is not configured' };
  const payload = workOrderView(row);
  try {
    const response = await fetch(`${env.FACTORY_URL.replace(/\/$/, '')}/api/work-orders`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${env.FACTORY_WRITE_TOKEN}`
      },
      body: JSON.stringify(payload)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Factory returned ${response.status}: ${JSON.stringify(result)}`);
    const factoryJobId = typeof (result as AnyRecord).jobId === 'string' ? (result as AnyRecord).jobId : id;
    const now = nowIso();
    await env.DB.prepare("UPDATE work_orders SET status='dispatched', factory_job_id=?, dispatch_error=NULL, dispatched_at=?, updated_at=? WHERE id=?")
      .bind(factoryJobId, now, now, id).run();
    await env.DB.prepare("UPDATE recommendations SET status='dispatched', updated_at=? WHERE work_order_id=?").bind(now, id).run();
    return { delivered: true, response: result };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await env.DB.prepare("UPDATE work_orders SET status='approved', dispatch_error=?, updated_at=? WHERE id=?").bind(message.slice(0, 2000), nowIso(), id).run();
    return { delivered: false, error: message };
  }
}

async function approveRecommendation(request: Request, env: OrchestrationEnv, ctx: ExecutionContext, id: string): Promise<Response> {
  if (!(await osAuthorized(request, env))) return json({ error: 'Unauthorized' }, { status: 401 });
  const recommendation = await env.DB.prepare('SELECT * FROM recommendations WHERE id = ?').bind(id).first<AnyRecord>();
  if (!recommendation) return json({ error: 'Recommendation not found' }, { status: 404 });
  let overrides: AnyRecord = {};
  if ((request.headers.get('content-type') ?? '').includes('application/json')) {
    overrides = await request.json().catch(() => ({})) as AnyRecord;
  }
  const existing = await env.DB.prepare('SELECT * FROM work_orders WHERE recommendation_id = ?').bind(id).first<AnyRecord>();
  let workOrderId = existing?.id ? String(existing.id) : '';
  if (!workOrderId) {
    const payload = safeParse(recommendation.payload_json, {}) as AnyRecord;
    const workOrder = buildWorkOrder(recommendation, payload, overrides);
    const now = nowIso();
    await env.DB.prepare(`
      INSERT INTO work_orders
      (id, recommendation_id, project_id, project_name, repository, objective, constraints_json, acceptance_criteria_json, authority_json, source_json, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', ?, ?)
    `).bind(
      workOrder.id, workOrder.recommendationId, workOrder.projectId, workOrder.projectName, workOrder.repository, workOrder.objective,
      JSON.stringify(workOrder.constraints), JSON.stringify(workOrder.acceptanceCriteria), JSON.stringify(workOrder.authority), JSON.stringify(workOrder.source), now, now
    ).run();
    workOrderId = workOrder.id;
    await env.DB.prepare("UPDATE recommendations SET status='approved', work_order_id=?, decision_note=?, decided_at=?, updated_at=? WHERE id=?")
      .bind(workOrderId, stringValue(overrides.note), now, now, id).run();
    await recordEvent(env, ctx, {
      title: `Approved work order: ${workOrder.objective}`,
      body: `Operating System approved Radar recommendation ${id} and created work order ${workOrderId}.`,
      type: 'decision',
      source: 'operating-system',
      projectId: workOrder.projectId,
      importance: 80,
      metadata: { recommendationId: id, workOrderId } as Record<string, Json>
    });
  }
  const dispatch = await dispatchWorkOrder(env, workOrderId);
  const row = await env.DB.prepare('SELECT * FROM work_orders WHERE id = ?').bind(workOrderId).first<AnyRecord>();
  return json({ approved: true, workOrder: workOrderView(row ?? null), dispatch });
}

async function rejectRecommendation(request: Request, env: OrchestrationEnv, ctx: ExecutionContext, id: string): Promise<Response> {
  if (!(await osAuthorized(request, env))) return json({ error: 'Unauthorized' }, { status: 401 });
  let body: AnyRecord = {};
  if ((request.headers.get('content-type') ?? '').includes('application/json')) body = await request.json().catch(() => ({})) as AnyRecord;
  const existing = await env.DB.prepare('SELECT * FROM recommendations WHERE id=?').bind(id).first<AnyRecord>();
  if (!existing) return json({ error: 'Recommendation not found' }, { status: 404 });
  const now = nowIso();
  await env.DB.prepare("UPDATE recommendations SET status='rejected', decision_note=?, decided_at=?, updated_at=? WHERE id=?")
    .bind(stringValue(body.note), now, now, id).run();
  await recordEvent(env, ctx, {
    title: `Rejected Radar recommendation: ${String(existing.title)}`,
    body: stringValue(body.note) || 'Operating System rejected this recommendation.',
    type: 'decision',
    source: 'operating-system',
    projectId: existing.project_id ? String(existing.project_id) : null,
    importance: 65,
    metadata: { recommendationId: id, decision: 'rejected' } as Record<string, Json>
  });
  return json({ rejected: true, recommendation: recommendationView(await env.DB.prepare('SELECT * FROM recommendations WHERE id=?').bind(id).first<AnyRecord>()) });
}

async function receiveFactoryResult(request: Request, env: OrchestrationEnv, ctx: ExecutionContext): Promise<Response> {
  if (!(await secretAllowed(request, env.FACTORY_RESULT_TOKEN, 'x-factory-result-token'))) {
    return json({ error: env.FACTORY_RESULT_TOKEN ? 'Unauthorized' : 'FACTORY_RESULT_TOKEN is not configured' }, { status: env.FACTORY_RESULT_TOKEN ? 401 : 503 });
  }
  const body = await request.json().catch(() => null) as AnyRecord | null;
  if (!body) return json({ error: 'Invalid JSON' }, { status: 400 });
  const workOrderId = stringValue(body.workOrderId);
  const status = stringValue(body.status);
  if (!workOrderId || !['queued', 'running', 'completed', 'failed', 'blocked'].includes(status)) return json({ error: 'workOrderId and a valid status are required' }, { status: 400 });
  const workOrder = await env.DB.prepare('SELECT * FROM work_orders WHERE id=?').bind(workOrderId).first<AnyRecord>();
  if (!workOrder) return json({ error: 'Work order not found' }, { status: 404 });
  const summary = stringValue(body.summary);
  const resultId = uid('result');
  const now = nowIso();
  await env.DB.prepare('INSERT INTO execution_results (id, work_order_id, status, summary, payload_json, received_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(resultId, workOrderId, status, summary, JSON.stringify(body), now).run();
  await env.DB.prepare('UPDATE work_orders SET status=?, updated_at=? WHERE id=?').bind(status, now, workOrderId).run();
  await env.DB.prepare('UPDATE recommendations SET status=?, updated_at=? WHERE work_order_id=?').bind(status, now, workOrderId).run();
  await recordEvent(env, ctx, {
    title: `Factory ${status}: ${String(workOrder.objective)}`,
    body: summary || `AI Factory reported ${status} for work order ${workOrderId}.`,
    type: status === 'completed' ? 'milestone' : status === 'failed' ? 'problem' : 'note',
    source: 'ai-factory',
    projectId: workOrder.project_id ? String(workOrder.project_id) : null,
    importance: status === 'completed' ? 85 : status === 'failed' ? 90 : 60,
    metadata: { workOrderId, resultId, status } as Record<string, Json>
  });

  let radarFeedback: unknown = { sent: false, reason: 'not configured' };
  if (env.RADAR_FEEDBACK_URL && env.RADAR_FEEDBACK_TOKEN) {
    const recommendation = await env.DB.prepare('SELECT * FROM recommendations WHERE id=?').bind(String(workOrder.recommendation_id)).first<AnyRecord>();
    try {
      const feedbackResponse = await fetch(env.RADAR_FEEDBACK_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${env.RADAR_FEEDBACK_TOKEN}` },
        body: JSON.stringify({
          handoffId: recommendation?.external_id || recommendation?.id,
          status,
          outcome: status === 'completed' ? 'shipped_and_used' : status === 'failed' ? 'failed' : status,
          summary,
          metrics: body.metrics ?? {}
        })
      });
      radarFeedback = { sent: feedbackResponse.ok, status: feedbackResponse.status };
    } catch (error) {
      radarFeedback = { sent: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
  return json({ accepted: true, resultId, radarFeedback }, { status: 201 });
}

async function orchestrationApi(request: Request, env: OrchestrationEnv, ctx: ExecutionContext): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path === '/api/integrations/radar/handoffs' && request.method === 'POST') return receiveRadarHandoff(request, env, ctx);
  if (path === '/api/integrations/factory/results' && request.method === 'POST') return receiveFactoryResult(request, env, ctx);

  if (path === '/api/orchestration/status' && request.method === 'GET') {
    if (!(await osAuthorized(request, env))) return json({ error: 'Unauthorized' }, { status: 401 });
    const counts = await env.DB.prepare(`SELECT
      (SELECT COUNT(*) FROM recommendations WHERE status='received') AS recommendations_waiting,
      (SELECT COUNT(*) FROM work_orders WHERE status IN ('approved','dispatched','queued','running')) AS work_active,
      (SELECT COUNT(*) FROM work_orders WHERE status='completed') AS work_completed,
      (SELECT COUNT(*) FROM work_orders WHERE status='failed') AS work_failed`).first();
    return json({
      authority: 'operating-system',
      flow: 'radar -> os -> factory -> os -> radar',
      connections: {
        radarIngress: Boolean(env.RADAR_INGRESS_TOKEN),
        factoryDispatch: Boolean(env.FACTORY_URL && env.FACTORY_WRITE_TOKEN),
        factoryResults: Boolean(env.FACTORY_RESULT_TOKEN),
        radarFeedback: Boolean(env.RADAR_FEEDBACK_URL && env.RADAR_FEEDBACK_TOKEN)
      },
      counts: counts ?? {}
    });
  }

  if (path === '/api/recommendations' && request.method === 'GET') {
    if (!(await osAuthorized(request, env))) return json({ error: 'Unauthorized' }, { status: 401 });
    const status = url.searchParams.get('status');
    const result = status
      ? await env.DB.prepare('SELECT * FROM recommendations WHERE status=? ORDER BY received_at DESC LIMIT 100').bind(status).all<AnyRecord>()
      : await env.DB.prepare('SELECT * FROM recommendations ORDER BY received_at DESC LIMIT 100').all<AnyRecord>();
    return json((result.results ?? []).map(recommendationView));
  }

  const approve = path.match(/^\/api\/recommendations\/([^/]+)\/approve$/);
  if (approve && request.method === 'POST') return approveRecommendation(request, env, ctx, decodeURIComponent(approve[1]!));
  const reject = path.match(/^\/api\/recommendations\/([^/]+)\/reject$/);
  if (reject && request.method === 'POST') return rejectRecommendation(request, env, ctx, decodeURIComponent(reject[1]!));

  if (path === '/api/work-orders' && request.method === 'GET') {
    if (!(await osAuthorized(request, env))) return json({ error: 'Unauthorized' }, { status: 401 });
    const result = await env.DB.prepare('SELECT * FROM work_orders ORDER BY created_at DESC LIMIT 100').all<AnyRecord>();
    return json((result.results ?? []).map(workOrderView));
  }
  const dispatch = path.match(/^\/api\/work-orders\/([^/]+)\/dispatch$/);
  if (dispatch && request.method === 'POST') {
    if (!(await osAuthorized(request, env))) return json({ error: 'Unauthorized' }, { status: 401 });
    return json(await dispatchWorkOrder(env, decodeURIComponent(dispatch[1]!)));
  }
  return null;
}

export default {
  async fetch(request: Request, env: OrchestrationEnv, ctx: ExecutionContext): Promise<Response> {
    const handled = await orchestrationApi(request, env, ctx);
    if (handled) return handled;
    return core.fetch(request, env, ctx);
  },
  async scheduled(controller: ScheduledController, env: OrchestrationEnv, ctx: ExecutionContext): Promise<void> {
    if (core.scheduled) await core.scheduled(controller, env, ctx);
  }
} satisfies ExportedHandler<OrchestrationEnv>;
