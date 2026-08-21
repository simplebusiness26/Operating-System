import { applyExecutionCallback, createExecutionJob, processExecutionJob } from './control-plane';
import type { RuntimeEnv } from './env';
import type { Json } from './types';
import { constantTimeSecretEquals, json, normalizeText, nowIso, safeJson, uid } from './utils';

function bearer(request: Request): string {
  const auth = request.headers.get('authorization') || '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : '';
}

async function tokenAuthorized(request: Request, expected?: string): Promise<boolean> {
  if (!expected) return false;
  const token = bearer(request) || request.headers.get('x-machine-token') || '';
  return Boolean(token) && constantTimeSecretEquals(token, expected);
}

async function ownerAuthorized(request: Request, env: RuntimeEnv): Promise<boolean> {
  if (!env.OS_ACCESS_TOKEN) return false;
  const token = bearer(request) || request.headers.get('x-os-token') || '';
  return Boolean(token) && constantTimeSecretEquals(token, env.OS_ACCESS_TOKEN);
}

async function readJson<T>(request: Request): Promise<T> {
  if (!(request.headers.get('content-type') || '').includes('application/json')) throw new Error('Expected application/json');
  return request.json() as Promise<T>;
}

function pickString(value: unknown, max = 4000): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function payloadObject(value: unknown): Record<string, Json> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, Json> : {};
}

function deriveRecommendation(sourceSystem: string, payload: Record<string, Json>) {
  const brief = payloadObject(payload.executionBrief || payload.brief || payload.recommendation || payload.opportunity || payload.prospect);
  const externalId = pickString(payload.id || brief.id || payload.externalId || brief.externalId, 300) || uid('external');
  const objective = pickString(
    brief.objective || payload.objective || brief.recommendation || payload.recommendation || brief.nextStep || payload.nextStep || brief.offer || payload.offer,
    5000,
  );
  const title = pickString(brief.title || payload.title || brief.name || payload.name, 300) || objective.slice(0, 120) || `${sourceSystem} recommendation`;
  const projectName = pickString(brief.projectName || payload.projectName, 250) || null;
  const repository = pickString(brief.repository || payload.repository, 500) || null;
  const confidenceRaw = Number(brief.confidence ?? payload.confidence ?? brief.score ?? payload.score);
  const confidence = Number.isFinite(confidenceRaw) ? Math.max(0, Math.min(1, confidenceRaw > 1 ? confidenceRaw / 100 : confidenceRaw)) : 0.5;
  const priorityRaw = Number(brief.priority ?? payload.priority ?? brief.score ?? payload.score);
  const priority = Number.isFinite(priorityRaw) ? Math.max(1, Math.min(100, priorityRaw)) : sourceSystem === 'revenue-hunter' ? 75 : 65;
  const acceptance = Array.isArray(brief.acceptanceCriteria) ? brief.acceptanceCriteria.map((x) => String(x)).slice(0, 30) : [];
  const constraints = Array.isArray(brief.constraints) ? brief.constraints.map((x) => String(x)).slice(0, 30) : [];
  return { externalId, title, objective, projectName, repository, confidence, priority, acceptance, constraints };
}

export async function ensureOrchestrationSchema(db: D1Database) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS recommendations (
      id TEXT PRIMARY KEY,source_system TEXT NOT NULL,external_id TEXT NOT NULL,title TEXT NOT NULL,objective TEXT NOT NULL DEFAULT '',
      project_name TEXT,repository TEXT,confidence REAL NOT NULL DEFAULT 0.5,priority INTEGER NOT NULL DEFAULT 60,status TEXT NOT NULL DEFAULT 'received',
      original_json TEXT NOT NULL,derived_json TEXT NOT NULL DEFAULT '{}',execution_job_id TEXT,rejection_reason TEXT,
      created_at TEXT NOT NULL,updated_at TEXT NOT NULL,approved_at TEXT,dispatched_at TEXT,completed_at TEXT,
      UNIQUE(source_system,external_id))`),
    db.prepare(`CREATE TABLE IF NOT EXISTS factory_results (
      id TEXT PRIMARY KEY,work_order_id TEXT NOT NULL,status TEXT NOT NULL,summary TEXT NOT NULL DEFAULT '',payload_json TEXT NOT NULL,
      received_at TEXT NOT NULL,UNIQUE(work_order_id,status,received_at))`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_recommendations_status ON recommendations(status,priority DESC,created_at DESC)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_recommendations_source ON recommendations(source_system,created_at DESC)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_factory_results_work ON factory_results(work_order_id,received_at DESC)`),
  ]);
}

async function ingestRecommendation(db: D1Database, sourceSystem: string, payload: Record<string, Json>) {
  await ensureOrchestrationSchema(db);
  const derived = deriveRecommendation(sourceSystem, payload);
  const existing = await db.prepare('SELECT * FROM recommendations WHERE source_system=? AND external_id=?')
    .bind(sourceSystem, derived.externalId).first<Record<string, unknown>>();
  if (existing) return { inserted: false, recommendation: { ...existing, original: safeJson(String(existing.original_json || '{}'), {}), derived: safeJson(String(existing.derived_json || '{}'), {}) } };
  const id = uid('rec');
  const now = nowIso();
  await db.prepare(`INSERT INTO recommendations
    (id,source_system,external_id,title,objective,project_name,repository,confidence,priority,status,original_json,derived_json,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,'received',?,?,?,?,?)`)
    .bind(id,sourceSystem,derived.externalId,derived.title,derived.objective,derived.projectName,derived.repository,derived.confidence,derived.priority,
      JSON.stringify(payload),JSON.stringify(derived),now,now).run();
  const recommendation = await db.prepare('SELECT * FROM recommendations WHERE id=?').bind(id).first<Record<string, unknown>>();
  return { inserted: true, recommendation };
}

async function listRecommendations(db: D1Database, status?: string | null) {
  await ensureOrchestrationSchema(db);
  const result = status
    ? await db.prepare('SELECT * FROM recommendations WHERE status=? ORDER BY priority DESC,created_at DESC LIMIT 200').bind(status).all<Record<string, unknown>>()
    : await db.prepare("SELECT * FROM recommendations ORDER BY CASE status WHEN 'received' THEN 0 WHEN 'approved' THEN 1 WHEN 'dispatched' THEN 2 ELSE 3 END,priority DESC,created_at DESC LIMIT 250").all<Record<string, unknown>>();
  return (result.results || []).map((row) => ({
    ...row,
    original: safeJson(String(row.original_json || '{}'), {}),
    derived: safeJson(String(row.derived_json || '{}'), {}),
  }));
}

async function approveRecommendation(db: D1Database, env: RuntimeEnv, id: string) {
  await ensureOrchestrationSchema(db);
  const row = await db.prepare('SELECT * FROM recommendations WHERE id=?').bind(id).first<Record<string, unknown>>();
  if (!row) throw new Error('Recommendation not found');
  if (['rejected','completed','failed'].includes(String(row.status))) return row;
  const derived = safeJson<Record<string, unknown>>(String(row.derived_json || '{}'), {});
  const objective = normalizeText(String(row.objective || ''));
  if (!objective) throw new Error('Recommendation has no executable objective');
  const now = nowIso();
  await db.prepare("UPDATE recommendations SET status='approved',approved_at=COALESCE(approved_at,?),updated_at=? WHERE id=?").bind(now,now,id).run();
  const job = await createExecutionJob(db,env,{
    title:String(row.title || objective.slice(0,96)),
    objective,
    projectName:row.project_name ? String(row.project_name) : null,
    assignedSystem:'ai-factory',
    actionType:'delegate',
    priority:Number(row.priority || 65),
    confidence:Number(row.confidence || 0.5),
    sourceRef:`recommendation:${id}`,
    plan:[
      { title:'Translate approved recommendation into a Factory work order', system:'ai-factory' },
      { title:'Execute through the minimum required Factory capability route', system:'ai-factory' },
      { title:'Verify acceptance criteria and return evidence to the Operating System', system:'ai-factory' },
    ],
  });
  if (!job) throw new Error('Failed to create execution job');
  const acceptance = Array.isArray(derived.acceptance) ? derived.acceptance : [];
  const constraints = Array.isArray(derived.constraints) ? derived.constraints : [];
  const workAuthority = { mayCreateBranch:true, mayOpenPullRequest:true, mayMerge:false, mayDeployProduction:false, maySpend:false, mayExternalWrite:false };
  const result = safeJson<Record<string, Json>>(String(job.result_json || '{}'), {});
  result.factoryContract = {
    recommendationId:id,
    repository:row.repository || null,
    projectName:row.project_name || null,
    acceptanceCriteria:acceptance as unknown as Json,
    constraints:constraints as unknown as Json,
    authority:workAuthority as unknown as Json,
  } as unknown as Json;
  await db.prepare('UPDATE execution_jobs SET result_json=?,updated_at=? WHERE id=?').bind(JSON.stringify(result),nowIso(),job.id).run();
  await db.prepare("UPDATE recommendations SET status='approved',execution_job_id=?,updated_at=? WHERE id=?").bind(job.id,nowIso(),id).run();
  const processed = await processExecutionJob(db,env,job.id);
  const nextStatus = processed?.status === 'complete' ? 'completed' : processed?.status === 'blocked' ? 'approved' : processed?.status === 'running' ? 'dispatched' : 'approved';
  await db.prepare('UPDATE recommendations SET status=?,dispatched_at=CASE WHEN ?=\'dispatched\' THEN COALESCE(dispatched_at,?) ELSE dispatched_at END,updated_at=? WHERE id=?')
    .bind(nextStatus,nextStatus,nowIso(),nowIso(),id).run();
  return { recommendation: await db.prepare('SELECT * FROM recommendations WHERE id=?').bind(id).first(), executionJob: processed };
}

async function rejectRecommendation(db: D1Database, id: string, reason = '') {
  await ensureOrchestrationSchema(db);
  const now = nowIso();
  await db.prepare("UPDATE recommendations SET status='rejected',rejection_reason=?,updated_at=? WHERE id=? AND status NOT IN ('completed','failed')")
    .bind(reason.slice(0,1500),now,id).run();
  return db.prepare('SELECT * FROM recommendations WHERE id=?').bind(id).first();
}

async function recordFactoryResult(db: D1Database, payload: Record<string, Json>) {
  await ensureOrchestrationSchema(db);
  const workOrderId = pickString(payload.workOrderId || payload.jobId, 200);
  const status = pickString(payload.status, 60);
  if (!workOrderId || !status) throw new Error('workOrderId and status are required');
  const callbackStatus = ['completed','complete','done','success'].includes(status.toLowerCase()) ? 'complete'
    : ['failed','error','blocked'].includes(status.toLowerCase()) ? 'blocked' : 'running';
  const result = {
    summary: payload.summary || '',
    branch: payload.branch || null,
    pullRequestUrl: payload.pullRequestUrl || null,
    artifacts: payload.artifacts || [],
    metrics: payload.metrics || {},
    evidence: payload.evidence || [],
    error: payload.error || null,
  } as Record<string, Json>;
  const job = await applyExecutionCallback(db,workOrderId,{
    status:callbackStatus,
    result,
    blockedReason:pickString(payload.error,1200) || undefined,
  });
  const now = nowIso();
  await db.prepare('INSERT INTO factory_results (id,work_order_id,status,summary,payload_json,received_at) VALUES (?,?,?,?,?,?)')
    .bind(uid('factory_result'),workOrderId,status,pickString(payload.summary,3000),JSON.stringify(payload),now).run();
  const recommendation = await db.prepare('SELECT id FROM recommendations WHERE execution_job_id=?').bind(workOrderId).first<{id:string}>();
  if (recommendation?.id) {
    const recStatus = callbackStatus === 'complete' ? 'completed' : callbackStatus === 'blocked' ? 'failed' : 'dispatched';
    await db.prepare('UPDATE recommendations SET status=?,completed_at=CASE WHEN ? IN (\'completed\',\'failed\') THEN ? ELSE completed_at END,updated_at=? WHERE id=?')
      .bind(recStatus,recStatus,now,now,recommendation.id).run();
  }
  return { ok:true,executionJob:job,recommendationId:recommendation?.id || null };
}

export async function orchestrationApi(request: Request, env: RuntimeEnv): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (!path.startsWith('/api/integrations/')) return null;
  await ensureOrchestrationSchema(env.DB);

  if (path === '/api/integrations/health' && request.method === 'GET') {
    return json({
      ok:true,
      recommendationInbox:true,
      radarIngressConfigured:Boolean(env.RADAR_INGRESS_TOKEN),
      revenueHunterIngressConfigured:Boolean(env.REVENUE_HUNTER_INGRESS_TOKEN || env.REVENUE_HUNTER_TOKEN),
      factoryDispatchConfigured:Boolean(env.AI_FACTORY_DISPATCH_URL && env.AI_FACTORY_TOKEN),
      factoryResultIngressConfigured:Boolean(env.FACTORY_RESULT_TOKEN || env.OS_CALLBACK_TOKEN),
    });
  }

  if (path === '/api/integrations/radar/handoffs' && request.method === 'POST') {
    if (!(await tokenAuthorized(request,env.RADAR_INGRESS_TOKEN || env.RADAR_SYNC_TOKEN))) return json({error:'Invalid Radar ingress authorization'},{status:401});
    return json(await ingestRecommendation(env.DB,'opportunity-radar',await readJson<Record<string,Json>>(request)),{status:201});
  }
  if (path === '/api/integrations/revenue-hunter/handoffs' && request.method === 'POST') {
    if (!(await tokenAuthorized(request,env.REVENUE_HUNTER_INGRESS_TOKEN || env.REVENUE_HUNTER_TOKEN))) return json({error:'Invalid Revenue Hunter ingress authorization'},{status:401});
    return json(await ingestRecommendation(env.DB,'revenue-hunter',await readJson<Record<string,Json>>(request)),{status:201});
  }
  if (path === '/api/integrations/factory/results' && request.method === 'POST') {
    if (!(await tokenAuthorized(request,env.FACTORY_RESULT_TOKEN || env.OS_CALLBACK_TOKEN))) return json({error:'Invalid Factory result authorization'},{status:401});
    return json(await recordFactoryResult(env.DB,await readJson<Record<string,Json>>(request)));
  }

  if (path === '/api/integrations/recommendations' && request.method === 'GET') {
    if (!(await ownerAuthorized(request,env))) return json({error:'Owner authorization required'},{status:401});
    return json({recommendations:await listRecommendations(env.DB,url.searchParams.get('status'))});
  }
  const approve = path.match(/^\/api\/integrations\/recommendations\/([^/]+)\/approve$/);
  if (approve && request.method === 'POST') {
    if (!(await ownerAuthorized(request,env))) return json({error:'Owner authorization required'},{status:401});
    return json(await approveRecommendation(env.DB,env,decodeURIComponent(approve[1])));
  }
  const reject = path.match(/^\/api\/integrations\/recommendations\/([^/]+)\/reject$/);
  if (reject && request.method === 'POST') {
    if (!(await ownerAuthorized(request,env))) return json({error:'Owner authorization required'},{status:401});
    const payload = await readJson<{reason?:string}>(request);
    return json(await rejectRecommendation(env.DB,decodeURIComponent(reject[1]),payload.reason || ''));
  }
  return json({error:'Integration route not found'},{status:404});
}
