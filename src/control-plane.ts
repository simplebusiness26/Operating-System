import { generateDailyBrief, runPipeline } from './agents';
import { ensureProject, insertEvent, searchEverything } from './db';
import type { RuntimeEnv } from './env';
import type { EventInput, Json, TimelineEvent } from './types';
import { normalizeText, nowIso, safeJson, uid } from './utils';

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type ExecutionStatus = 'queued' | 'running' | 'waiting_approval' | 'blocked' | 'complete' | 'cancelled';
export type AttentionLane = 'now' | 'next' | 'waiting' | 'ignore';

export interface CreateExecutionJobInput {
  title?: string;
  objective: string;
  projectId?: string | null;
  projectName?: string | null;
  assignedSystem?: string;
  actionType?: string;
  priority?: number;
  confidence?: number;
  sourceRef?: string | null;
  plan?: Array<{ title: string; system?: string }>;
}

interface ExecutionJobRow {
  id: string;
  title: string;
  objective: string;
  project_id: string | null;
  status: ExecutionStatus;
  lane: AttentionLane;
  priority: number;
  confidence: number;
  assigned_system: string;
  action_type: string;
  risk_level: RiskLevel;
  source_ref: string | null;
  plan_json: string;
  result_json: string;
  current_step: number;
  blocked_reason: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
}

interface ApprovalRow {
  id: string;
  title: string;
  detail: string;
  project_id: string | null;
  job_id: string | null;
  status: string;
  risk_level: RiskLevel;
  action_type: string;
  action_payload_json: string;
  source_ref: string | null;
  created_at: string;
  resolved_at: string | null;
  resolution_note: string;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}

export function classifyActionRisk(text: string, actionType = ''): RiskLevel {
  const value = `${actionType} ${text}`.toLowerCase();
  if (/\b(delete account|delete database|drop table|credential|secret|password|payment|purchase|spend|charge|refund|transfer money)\b/.test(value)) return 'critical';
  if (/\b(deploy|publish|post publicly|send email|send message|merge|release|production|external write|delete|archive repo)\b/.test(value)) return 'high';
  if (/\b(build|implement|change code|edit|create issue|create pr|branch|prototype|run test|experiment)\b/.test(value)) return 'medium';
  return 'low';
}

export function chooseExecutionSystem(text: string): string {
  const value = text.toLowerCase();
  if (/\b(design|ui|ux|interface|layout|prototype)\b/.test(value)) return 'designlab';
  if (/\b(post|thread|content|ghostwriter|write about|document)\b/.test(value)) return 'ghostwriter';
  if (/\b(opportunity|market|signal|radar|validate demand)\b/.test(value)) return 'opportunity-radar';
  if (/\b(revenue|make money|sales|lead|client|customer acquisition)\b/.test(value)) return 'revenue-hunter';
  if (/\b(build|code|implement|fix|feature|app|software|ship)\b/.test(value)) return 'ai-factory';
  return 'operating-system';
}

export function attentionLane(priority: number, status: string, risk?: string): AttentionLane {
  if (status === 'waiting_approval' || risk === 'critical') return 'now';
  if (status === 'running' || status === 'blocked') return 'waiting';
  if (priority >= 80) return 'now';
  if (priority >= 45) return 'next';
  return 'ignore';
}

function autoExecutionRank(level: string | undefined): number {
  return ({ none: 0, low: 1, medium: 2, high: 3 } as Record<string, number>)[(level || 'low').toLowerCase()] ?? 1;
}

function riskRank(level: RiskLevel): number {
  return ({ low: 1, medium: 2, high: 3, critical: 4 } as Record<RiskLevel, number>)[level];
}

async function projectIdFromInput(db: D1Database, input: CreateExecutionJobInput): Promise<string | null> {
  if (input.projectId) return input.projectId;
  if (input.projectName?.trim()) return ensureProject(db, input.projectName.trim());
  return null;
}

async function createNotification(
  db: D1Database,
  input: { type: string; severity?: string; title: string; body?: string; projectId?: string | null; actionRef?: string | null; dedupeKey?: string | null },
) {
  const id = uid('notification');
  const dedupe = input.dedupeKey || null;
  if (dedupe) {
    const existing = await db.prepare("SELECT id FROM notifications WHERE dedupe_key = ? AND status = 'unread' LIMIT 1").bind(dedupe).first<{ id: string }>();
    if (existing?.id) return existing.id;
  }
  await db.prepare(`INSERT INTO notifications
    (id, type, severity, title, body, project_id, action_ref, dedupe_key, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'unread', ?)`)
    .bind(id, input.type, input.severity ?? 'info', input.title, input.body ?? '', input.projectId ?? null, input.actionRef ?? null, dedupe, nowIso()).run();
  return id;
}

async function createApprovalForJob(db: D1Database, job: ExecutionJobRow): Promise<string> {
  const existing = await db.prepare("SELECT id FROM approvals WHERE job_id = ? AND status = 'pending' LIMIT 1").bind(job.id).first<{ id: string }>();
  if (existing?.id) return existing.id;
  const id = uid('approval');
  await db.prepare(`INSERT INTO approvals
    (id, title, detail, project_id, job_id, status, risk_level, action_type, action_payload_json, source_ref, created_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`)
    .bind(
      id,
      `Approve: ${job.title}`,
      job.objective,
      job.project_id,
      job.id,
      job.risk_level,
      job.action_type,
      JSON.stringify({ assignedSystem: job.assigned_system, objective: job.objective }),
      job.source_ref,
      nowIso(),
    ).run();
  await createNotification(db, {
    type: 'approval-required',
    severity: job.risk_level === 'critical' ? 'critical' : 'warning',
    title: 'Your approval is needed',
    body: job.title,
    projectId: job.project_id,
    actionRef: id,
    dedupeKey: `approval:${job.id}`,
  });
  return id;
}

function defaultPlan(input: CreateExecutionJobInput, system: string): Array<{ title: string; system: string }> {
  if (input.plan?.length) return input.plan.map((step) => ({ title: step.title, system: step.system || system }));
  const objective = input.objective.trim();
  if (system === 'designlab') return [
    { title: 'Inspect current product context and constraints', system: 'designlab' },
    { title: 'Generate and evaluate design direction', system: 'designlab' },
    { title: 'Prepare implementation-ready handoff', system: 'designlab' },
  ];
  if (system === 'ghostwriter') return [
    { title: 'Collect source evidence', system: 'ghostwriter' },
    { title: 'Draft evidence-grounded content', system: 'ghostwriter' },
    { title: 'Queue for review/publishing', system: 'ghostwriter' },
  ];
  if (system === 'opportunity-radar') return [
    { title: 'Gather external and internal evidence', system: 'opportunity-radar' },
    { title: 'Score the opportunity independently', system: 'opportunity-radar' },
    { title: 'Return validation recommendation', system: 'opportunity-radar' },
  ];
  if (system === 'revenue-hunter') return [
    { title: 'Find near-term revenue route', system: 'revenue-hunter' },
    { title: 'Rank by speed, confidence and effort', system: 'revenue-hunter' },
    { title: 'Prepare executable revenue action', system: 'revenue-hunter' },
  ];
  if (system === 'ai-factory') return [
    { title: 'Translate objective into implementation contract', system: 'ai-factory' },
    { title: 'Build in an isolated implementation path', system: 'ai-factory' },
    { title: 'Test and verify functionality', system: 'ai-factory' },
    { title: 'Return completion evidence', system: 'ai-factory' },
  ];
  return [{ title: objective || 'Process objective', system: 'operating-system' }];
}

export async function createExecutionJob(db: D1Database, env: RuntimeEnv, input: CreateExecutionJobInput) {
  const objective = normalizeText(input.objective);
  if (!objective) throw new Error('objective is required');
  const projectId = await projectIdFromInput(db, input);
  const system = normalizeText(input.assignedSystem) || chooseExecutionSystem(objective);
  const actionType = normalizeText(input.actionType) || (system === 'operating-system' ? 'analysis' : 'delegate');
  const risk = classifyActionRisk(objective, actionType);
  const priority = clampNumber(input.priority ?? (/urgent|critical|blocked|today/i.test(objective) ? 85 : 65), 1, 100);
  const title = normalizeText(input.title) || objective.slice(0, 96);
  const plan = defaultPlan(input, system);
  const autoLevel = autoExecutionRank(env.AUTO_EXECUTION_LEVEL);
  const needsApproval = riskRank(risk) > autoLevel || riskRank(risk) >= riskRank('high');
  const status: ExecutionStatus = needsApproval ? 'waiting_approval' : 'queued';
  const lane = attentionLane(priority, status, risk);
  const id = uid('job');
  const now = nowIso();
  await db.prepare(`INSERT INTO execution_jobs
    (id, title, objective, project_id, status, lane, priority, confidence, assigned_system, action_type, risk_level, source_ref, plan_json, result_json, current_step, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', 0, ?, ?)`)
    .bind(
      id, title, objective, projectId, status, lane, priority, clampNumber(input.confidence ?? 0.72, 0, 1),
      system, actionType, risk, input.sourceRef ?? null, JSON.stringify(plan), now, now,
    ).run();
  for (let i = 0; i < plan.length; i += 1) {
    const step = plan[i]!;
    await db.prepare(`INSERT INTO execution_steps
      (id, job_id, step_index, title, system, status, input_json, output_json)
      VALUES (?, ?, ?, ?, ?, 'pending', '{}', '{}')`)
      .bind(uid('step'), id, i, step.title, step.system).run();
  }
  const job = await getExecutionJob(db, id);
  if (job && needsApproval) await createApprovalForJob(db, job);
  return job;
}

export async function getExecutionJob(db: D1Database, id: string): Promise<ExecutionJobRow | null> {
  return await db.prepare('SELECT * FROM execution_jobs WHERE id = ?').bind(id).first<ExecutionJobRow>();
}

export async function listExecutionJobs(db: D1Database, status?: string | null) {
  const rows = status
    ? await db.prepare('SELECT * FROM execution_jobs WHERE status = ? ORDER BY priority DESC, updated_at DESC LIMIT 100').bind(status).all<ExecutionJobRow>()
    : await db.prepare('SELECT * FROM execution_jobs ORDER BY CASE status WHEN \'waiting_approval\' THEN 0 WHEN \'running\' THEN 1 WHEN \'blocked\' THEN 2 WHEN \'queued\' THEN 3 ELSE 4 END, priority DESC, updated_at DESC LIMIT 150').all<ExecutionJobRow>();
  const jobs = rows.results ?? [];
  if (!jobs.length) return [];
  const ids = jobs.map((x) => x.id);
  const placeholders = ids.map(() => '?').join(',');
  const stepRows = await db.prepare(`SELECT * FROM execution_steps WHERE job_id IN (${placeholders}) ORDER BY job_id, step_index`).bind(...ids).all<Record<string, unknown>>();
  const steps = stepRows.results ?? [];
  return jobs.map((job) => ({
    ...job,
    plan: safeJson(job.plan_json, []),
    result: safeJson(job.result_json, {}),
    steps: steps.filter((step) => step.job_id === job.id),
  }));
}

function integrationTarget(env: RuntimeEnv, system: string): { url?: string; token?: string; repository?: string } {
  const map: Record<string, { url?: string; token?: string; repository?: string }> = {
    'ai-factory': { url: env.AI_FACTORY_DISPATCH_URL, token: env.AI_FACTORY_TOKEN, repository: 'simplebusiness26/AI-Factory' },
    designlab: { url: env.DESIGNLAB_DISPATCH_URL, token: env.DESIGNLAB_TOKEN, repository: 'simplebusiness26/DesignLabV2' },
    ghostwriter: { url: env.GHOSTWRITER_DISPATCH_URL, token: env.GHOSTWRITER_TOKEN, repository: 'simplebusiness26/TheGhostWriter' },
    'revenue-hunter': { url: env.REVENUE_HUNTER_DISPATCH_URL, token: env.REVENUE_HUNTER_TOKEN },
    'opportunity-radar': { url: env.RADAR_DISPATCH_URL, token: env.RADAR_SYNC_TOKEN, repository: 'simplebusiness26/The-Opportunity-Radar' },
  };
  return map[system] ?? {};
}

async function markJobBlocked(db: D1Database, job: ExecutionJobRow, reason: string) {
  await db.prepare("UPDATE execution_jobs SET status = 'blocked', lane = 'waiting', blocked_reason = ?, updated_at = ? WHERE id = ?")
    .bind(reason.slice(0, 700), nowIso(), job.id).run();
  await createNotification(db, {
    type: 'execution-blocked',
    severity: 'warning',
    title: `Blocked: ${job.title}`,
    body: reason,
    projectId: job.project_id,
    actionRef: job.id,
    dedupeKey: `job-blocked:${job.id}:${reason.slice(0, 80)}`,
  });
}

async function completeJob(db: D1Database, job: ExecutionJobRow, result: Record<string, Json>) {
  const now = nowIso();
  const completedSteps = safeJson<Array<unknown>>(job.plan_json, []).length;
  await db.prepare("UPDATE execution_jobs SET status = 'complete', lane = 'ignore', result_json = ?, current_step = ?, blocked_reason = NULL, updated_at = ?, completed_at = ? WHERE id = ?")
    .bind(JSON.stringify(result), completedSteps, now, now, job.id).run();
  await db.prepare("UPDATE execution_steps SET status = 'complete', completed_at = COALESCE(completed_at, ?) WHERE job_id = ? AND status != 'complete'")
    .bind(now, job.id).run();
  await createNotification(db, {
    type: 'execution-complete',
    severity: 'success',
    title: `Complete: ${job.title}`,
    body: 'The execution job finished and evidence is available in the Operating System.',
    projectId: job.project_id,
    actionRef: job.id,
    dedupeKey: `job-complete:${job.id}`,
  });
}

async function dispatchExternalJob(db: D1Database, env: RuntimeEnv, job: ExecutionJobRow) {
  const target = integrationTarget(env, job.assigned_system);
  if (!target.url) {
    await markJobBlocked(db, job, `${job.assigned_system} has no dispatch endpoint configured. The job is preserved and will resume when that connector is added.`);
    return;
  }
  await db.prepare("UPDATE execution_jobs SET status = 'running', lane = 'waiting', started_at = COALESCE(started_at, ?), updated_at = ?, blocked_reason = NULL WHERE id = ?")
    .bind(nowIso(), nowIso(), job.id).run();
  const headers = new Headers({ 'content-type': 'application/json', 'user-agent': 'Operating-System-Control-Plane/1.0' });
  if (target.token) headers.set('authorization', `Bearer ${target.token}`);
  const response = await fetch(target.url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      version: 1,
      source: 'operating-system',
      job: {
        id: job.id,
        title: job.title,
        objective: job.objective,
        projectId: job.project_id,
        priority: job.priority,
        riskLevel: job.risk_level,
        plan: safeJson(job.plan_json, []),
        callbackUrl: env.OS_CALLBACK_URL || null,
      },
    }),
  });
  const text = (await response.text()).slice(0, 6000);
  if (!response.ok) {
    await markJobBlocked(db, job, `${job.assigned_system} rejected the dispatch with HTTP ${response.status}${text ? `: ${text.slice(0, 400)}` : ''}`);
    return;
  }
  let result: Record<string, Json> = { accepted: true, system: job.assigned_system, response: text };
  try { result = { accepted: true, system: job.assigned_system, ...(JSON.parse(text) as Record<string, Json>) }; } catch { /* text is retained */ }
  const remoteStatus = typeof result.status === 'string' ? result.status : '';
  if (['complete', 'completed', 'done', 'success'].includes(remoteStatus.toLowerCase())) {
    await completeJob(db, job, result);
  } else {
    await db.prepare("UPDATE execution_jobs SET status = 'running', lane = 'waiting', result_json = ?, updated_at = ? WHERE id = ?")
      .bind(JSON.stringify(result), nowIso(), job.id).run();
  }
}

async function executeInternalJob(db: D1Database, env: RuntimeEnv, job: ExecutionJobRow) {
  await db.prepare("UPDATE execution_jobs SET status = 'running', lane = 'waiting', started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ?")
    .bind(nowIso(), nowIso(), job.id).run();
  if (job.action_type === 'refresh-brief' || /brief|priorit/i.test(job.objective)) {
    const brief = await generateDailyBrief(db);
    await completeJob(db, job, { kind: 'daily-brief', headline: brief.headline, focusCount: brief.focus.length });
    return;
  }
  if (job.action_type === 'search' || /find|search|what|show|analyse|analyze|review/i.test(job.objective)) {
    const results = await searchEverything(db, job.objective);
    await completeJob(db, job, { kind: 'analysis', matches: results.slice(0, 12) as unknown as Json });
    return;
  }
  await completeJob(db, job, { kind: 'control-plane', message: 'Objective recorded, planned and incorporated into the operating picture.' });
}

export async function processExecutionJob(db: D1Database, env: RuntimeEnv, id: string) {
  const job = await getExecutionJob(db, id);
  if (!job) throw new Error('Execution job not found');
  if (job.status === 'waiting_approval') return job;
  if (job.status === 'complete' || job.status === 'cancelled') return job;
  if (riskRank(job.risk_level) >= riskRank('high')) {
    await db.prepare("UPDATE execution_jobs SET status = 'waiting_approval', lane = 'now', updated_at = ? WHERE id = ?").bind(nowIso(), job.id).run();
    const refreshed = await getExecutionJob(db, job.id);
    if (refreshed) await createApprovalForJob(db, refreshed);
    return refreshed;
  }
  if (job.assigned_system === 'operating-system') await executeInternalJob(db, env, job);
  else await dispatchExternalJob(db, env, job);
  return getExecutionJob(db, id);
}

export async function processQueuedJobs(db: D1Database, env: RuntimeEnv, limit = 5) {
  const rows = await db.prepare("SELECT id FROM execution_jobs WHERE status = 'queued' ORDER BY priority DESC, created_at ASC LIMIT ?").bind(Math.max(1, Math.min(limit, 20))).all<{ id: string }>();
  const results = [];
  for (const row of rows.results ?? []) {
    try { results.push(await processExecutionJob(db, env, row.id)); }
    catch (error) { results.push({ id: row.id, error: error instanceof Error ? error.message : String(error) }); }
  }
  return results;
}

export async function listApprovals(db: D1Database, status = 'pending') {
  const result = status === 'all'
    ? await db.prepare('SELECT * FROM approvals ORDER BY created_at DESC LIMIT 100').all<ApprovalRow>()
    : await db.prepare('SELECT * FROM approvals WHERE status = ? ORDER BY CASE risk_level WHEN \'critical\' THEN 0 WHEN \'high\' THEN 1 ELSE 2 END, created_at DESC LIMIT 100').bind(status).all<ApprovalRow>();
  return (result.results ?? []).map((row) => ({ ...row, actionPayload: safeJson(row.action_payload_json, {}) }));
}

export async function resolveApproval(db: D1Database, env: RuntimeEnv, id: string, decision: 'approved' | 'rejected', note = '') {
  const approval = await db.prepare('SELECT * FROM approvals WHERE id = ?').bind(id).first<ApprovalRow>();
  if (!approval) throw new Error('Approval not found');
  if (approval.status !== 'pending') return approval;
  const now = nowIso();
  await db.prepare('UPDATE approvals SET status = ?, resolved_at = ?, resolution_note = ? WHERE id = ?')
    .bind(decision, now, note.slice(0, 1000), id).run();
  if (approval.job_id) {
    if (decision === 'approved') {
      await db.prepare("UPDATE execution_jobs SET status = 'queued', lane = 'next', updated_at = ? WHERE id = ?").bind(now, approval.job_id).run();
      await processExecutionJob(db, env, approval.job_id);
    } else {
      await db.prepare("UPDATE execution_jobs SET status = 'cancelled', lane = 'ignore', blocked_reason = 'Rejected by owner', updated_at = ?, completed_at = ? WHERE id = ?")
        .bind(now, now, approval.job_id).run();
    }
  }
  await db.prepare("UPDATE notifications SET status = 'read', read_at = ? WHERE action_ref = ? AND status = 'unread'").bind(now, id).run();
  return db.prepare('SELECT * FROM approvals WHERE id = ?').bind(id).first();
}

export async function getProjectIntelligence(db: D1Database) {
  const projects = await db.prepare(`
    SELECT p.*,
      (SELECT COUNT(*) FROM events e WHERE e.project_id = p.id) AS event_count,
      (SELECT MAX(e.occurred_at) FROM events e WHERE e.project_id = p.id) AS last_activity,
      (SELECT COUNT(*) FROM open_loops o WHERE o.project_id = p.id AND o.status = 'open') AS open_loop_count,
      (SELECT MAX(o.priority) FROM open_loops o WHERE o.project_id = p.id AND o.status = 'open') AS highest_loop_priority,
      (SELECT COUNT(*) FROM events e WHERE e.project_id = p.id AND e.type = 'problem' AND e.occurred_at >= datetime('now','-14 days')) AS recent_problems,
      (SELECT COUNT(*) FROM events e WHERE e.project_id = p.id AND e.type = 'milestone' AND e.occurred_at >= datetime('now','-14 days')) AS recent_wins,
      (SELECT COUNT(*) FROM execution_jobs j WHERE j.project_id = p.id AND j.status IN ('queued','running','waiting_approval','blocked')) AS active_jobs,
      (SELECT COUNT(*) FROM approvals a WHERE a.project_id = p.id AND a.status = 'pending') AS pending_approvals,
      (SELECT title FROM open_loops o WHERE o.project_id = p.id AND o.status = 'open' ORDER BY o.priority DESC, o.created_at ASC LIMIT 1) AS next_loop,
      (SELECT title FROM execution_jobs j WHERE j.project_id = p.id AND j.status IN ('running','queued','waiting_approval','blocked') ORDER BY j.priority DESC, j.created_at ASC LIMIT 1) AS next_job
    FROM projects p
    WHERE p.status != 'archived'
    ORDER BY COALESCE(last_activity, p.updated_at) DESC
  `).all<Record<string, unknown>>();
  return (projects.results ?? []).map((p) => {
    const eventCount = Number(p.event_count ?? 0);
    const loops = Number(p.open_loop_count ?? 0);
    const problems = Number(p.recent_problems ?? 0);
    const wins = Number(p.recent_wins ?? 0);
    const jobs = Number(p.active_jobs ?? 0);
    const approvals = Number(p.pending_approvals ?? 0);
    const lastActivity = String(p.last_activity ?? p.updated_at ?? '');
    const ageHours = lastActivity ? Math.max(0, (Date.now() - Date.parse(lastActivity)) / 3_600_000) : 9999;
    const recency = ageHours < 24 ? 15 : ageHours < 168 ? 8 : ageHours < 720 ? 0 : -12;
    const healthScore = clampNumber(68 + recency + wins * 5 - problems * 7 - Math.min(25, loops * 3) - approvals * 4, 0, 100);
    const confidence = clampNumber(0.3 + Math.min(0.45, eventCount * 0.025) + (ageHours < 168 ? 0.15 : 0), 0.2, 0.95);
    const priority = Math.max(Number(p.highest_loop_priority ?? 0), approvals ? 95 : 0, jobs ? 65 : 0);
    return {
      ...p,
      healthScore,
      confidence,
      attentionLane: attentionLane(priority || 40, approvals ? 'waiting_approval' : jobs ? 'running' : 'idle'),
      nextAction: p.next_loop || p.next_job || (String(p.goal || '').trim() ? `Advance goal: ${p.goal}` : 'Define the next concrete action'),
    };
  });
}

export async function getAttentionBoard(db: D1Database) {
  const [approvals, loops, jobs, experiments, reviews] = await Promise.all([
    db.prepare("SELECT id, title, detail, risk_level, project_id, created_at FROM approvals WHERE status = 'pending' ORDER BY created_at ASC LIMIT 30").all<Record<string, unknown>>(),
    db.prepare("SELECT id, title, detail, priority, project_id, created_at, due_at FROM open_loops WHERE status = 'open' ORDER BY priority DESC, created_at ASC LIMIT 60").all<Record<string, unknown>>(),
    db.prepare("SELECT id, title, objective AS detail, priority, project_id, status, risk_level, assigned_system, created_at FROM execution_jobs WHERE status IN ('queued','running','waiting_approval','blocked') ORDER BY priority DESC, created_at ASC LIMIT 60").all<Record<string, unknown>>(),
    db.prepare("SELECT id, title, hypothesis AS detail, priority, project_id, status, created_at FROM experiments WHERE status IN ('proposed','running') ORDER BY priority DESC, created_at ASC LIMIT 30").all<Record<string, unknown>>(),
    db.prepare("SELECT dr.id, d.title, d.decision AS detail, d.project_id, dr.review_at, dr.status FROM decision_reviews dr JOIN decisions d ON d.id = dr.decision_id WHERE dr.status = 'pending' AND dr.review_at <= datetime('now') ORDER BY dr.review_at ASC LIMIT 30").all<Record<string, unknown>>(),
  ]);
  const items: Array<Record<string, unknown> & { lane: AttentionLane; score: number; kind: string }> = [];
  for (const item of approvals.results ?? []) items.push({ ...item, kind: 'approval', score: item.risk_level === 'critical' ? 100 : 95, lane: 'now' });
  for (const item of reviews.results ?? []) items.push({ ...item, kind: 'decision-review', score: 82, lane: 'now' });
  for (const item of loops.results ?? []) {
    const score = Number(item.priority ?? 50);
    items.push({ ...item, kind: 'open-loop', score, lane: attentionLane(score, 'open') });
  }
  for (const item of jobs.results ?? []) {
    const score = Number(item.priority ?? 60);
    items.push({ ...item, kind: 'execution', score, lane: attentionLane(score, String(item.status ?? ''), String(item.risk_level ?? '')) });
  }
  for (const item of experiments.results ?? []) {
    const score = Number(item.priority ?? 55);
    items.push({ ...item, kind: 'experiment', score, lane: item.status === 'running' ? 'waiting' : 'next' });
  }
  for (const item of items) {
    if (item.kind === 'open-loop' && item.lane === 'next') {
      const created = Date.parse(String(item.created_at ?? ''));
      if (Number.isFinite(created) && Date.now() - created > 45 * 86_400_000 && Number(item.score) < 55) item.lane = 'ignore';
    }
  }
  const sorted = items.sort((a, b) => b.score - a.score);
  return {
    now: sorted.filter((x) => x.lane === 'now'),
    next: sorted.filter((x) => x.lane === 'next'),
    waiting: sorted.filter((x) => x.lane === 'waiting'),
    ignore: sorted.filter((x) => x.lane === 'ignore'),
  };
}

export async function listExperiments(db: D1Database, status?: string | null) {
  const result = status
    ? await db.prepare('SELECT * FROM experiments WHERE status = ? ORDER BY priority DESC, created_at DESC LIMIT 100').bind(status).all<Record<string, unknown>>()
    : await db.prepare('SELECT * FROM experiments ORDER BY CASE status WHEN \'running\' THEN 0 WHEN \'proposed\' THEN 1 ELSE 2 END, priority DESC, created_at DESC LIMIT 100').all<Record<string, unknown>>();
  return result.results ?? [];
}

export async function createExperiment(db: D1Database, input: { title?: string; projectId?: string | null; projectName?: string | null; hypothesis: string; test: string; successCriteria: string; priority?: number; sourceRef?: string | null }) {
  const projectId = input.projectId || (input.projectName ? await ensureProject(db, input.projectName) : null);
  const id = uid('experiment');
  const now = nowIso();
  await db.prepare(`INSERT INTO experiments
    (id, title, project_id, hypothesis, test, success_criteria, status, priority, confidence, source_ref, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'proposed', ?, 0.5, ?, ?, ?)`)
    .bind(id, input.title || input.hypothesis.slice(0, 100), projectId, input.hypothesis, input.test, input.successCriteria, clampNumber(input.priority ?? 60, 1, 100), input.sourceRef ?? null, now, now).run();
  return db.prepare('SELECT * FROM experiments WHERE id = ?').bind(id).first();
}

export async function updateExperiment(db: D1Database, id: string, input: { status?: string; result?: string; learning?: string; confidence?: number }) {
  const allowed = new Set(['proposed', 'running', 'passed', 'failed', 'inconclusive', 'cancelled']);
  if (input.status && !allowed.has(input.status)) throw new Error('Invalid experiment status');
  const current = await db.prepare('SELECT * FROM experiments WHERE id = ?').bind(id).first<Record<string, unknown>>();
  if (!current) throw new Error('Experiment not found');
  const status = input.status || String(current.status);
  const completed = ['passed', 'failed', 'inconclusive', 'cancelled'].includes(status) ? nowIso() : current.completed_at;
  await db.prepare('UPDATE experiments SET status = ?, result = ?, learning = ?, confidence = ?, updated_at = ?, completed_at = ? WHERE id = ?')
    .bind(status, input.result ?? current.result ?? '', input.learning ?? current.learning ?? '', clampNumber(input.confidence ?? Number(current.confidence ?? 0.5), 0, 1), nowIso(), completed ?? null, id).run();
  if (['passed', 'failed', 'inconclusive'].includes(status)) {
    await createNotification(db, { type: 'experiment-result', severity: status === 'passed' ? 'success' : 'info', title: `Experiment ${status}: ${current.title}`, body: input.learning || input.result || '', projectId: current.project_id as string | null, actionRef: id, dedupeKey: `experiment:${id}:${status}` });
  }
  return db.prepare('SELECT * FROM experiments WHERE id = ?').bind(id).first();
}

export async function proposeExperimentsFromOpportunities(db: D1Database) {
  const insights = await db.prepare("SELECT id, title, body, project_id, score FROM insights WHERE type = 'opportunity' AND score >= 70 ORDER BY score DESC, created_at DESC LIMIT 30").all<{ id: string; title: string; body: string; project_id: string | null; score: number }>();
  let created = 0;
  for (const insight of insights.results ?? []) {
    const exists = await db.prepare('SELECT id FROM experiments WHERE source_ref = ? LIMIT 1').bind(`insight:${insight.id}`).first<{ id: string }>();
    if (exists?.id) continue;
    const subject = insight.title.replace(/^Opportunity:\s*/i, '');
    await createExperiment(db, {
      title: `Validate: ${subject}`,
      projectId: insight.project_id,
      hypothesis: `There is a real, repeatable need behind “${subject}” that is strong enough to justify further build effort.`,
      test: 'Run the cheapest evidence-producing test first: identify a specific target user, present the concrete outcome, and collect an observable commitment rather than an opinion.',
      successCriteria: 'At least one strong behavioural signal (payment, booked call, data access, trial use, or repeated explicit demand) without building the full product.',
      priority: Math.min(95, insight.score),
      sourceRef: `insight:${insight.id}`,
    });
    created += 1;
  }
  return created;
}

export async function ensureDecisionReviews(db: D1Database) {
  const decisions = await db.prepare("SELECT id, title, created_at FROM decisions WHERE status = 'active' AND created_at <= datetime('now','-7 days') ORDER BY created_at ASC LIMIT 60").all<{ id: string; title: string; created_at: string }>();
  let created = 0;
  for (const decision of decisions.results ?? []) {
    const exists = await db.prepare('SELECT id FROM decision_reviews WHERE decision_id = ? LIMIT 1').bind(decision.id).first<{ id: string }>();
    if (exists?.id) continue;
    const id = uid('review');
    await db.prepare(`INSERT INTO decision_reviews
      (id, decision_id, expected_outcome, review_at, status, created_at, updated_at)
      VALUES (?, ?, '', datetime(?, '+7 days'), 'pending', ?, ?)`)
      .bind(id, decision.id, decision.created_at, nowIso(), nowIso()).run();
    created += 1;
  }
  return created;
}

export async function listDecisionReviews(db: D1Database, status = 'pending') {
  const result = await db.prepare(`SELECT dr.*, d.title, d.decision, d.rationale, d.project_id
    FROM decision_reviews dr JOIN decisions d ON d.id = dr.decision_id
    WHERE (? = 'all' OR dr.status = ?)
    ORDER BY CASE WHEN dr.status = 'pending' AND dr.review_at <= datetime('now') THEN 0 ELSE 1 END, dr.review_at ASC LIMIT 100`)
    .bind(status, status).all<Record<string, unknown>>();
  return result.results ?? [];
}

export async function reviewDecision(db: D1Database, id: string, input: { outcome: string; score: number; lesson?: string }) {
  const score = clampNumber(input.score, 0, 100);
  await db.prepare("UPDATE decision_reviews SET status = 'reviewed', outcome = ?, score = ?, lesson = ?, updated_at = ? WHERE id = ?")
    .bind(input.outcome, score, input.lesson ?? '', nowIso(), id).run();
  const row = await db.prepare(`SELECT dr.*, d.title, d.project_id FROM decision_reviews dr JOIN decisions d ON d.id = dr.decision_id WHERE dr.id = ?`).bind(id).first<Record<string, unknown>>();
  if (row) {
    const event = await insertEvent(db, {
      title: `Decision outcome: ${String(row.title)}`,
      body: `${input.outcome}${input.lesson ? ` Lesson: ${input.lesson}` : ''}`,
      type: 'learning', source: 'decision-review', projectId: row.project_id as string | null,
      importance: score >= 75 || score <= 30 ? 75 : 60,
      rawRef: `decision-review:${id}`,
      tags: ['decision', 'strategy'],
      metadata: { reviewId: id, score },
    });
    await runPipeline(db, event);
    await maintainMemoryGraphForEvent(db, event);
  }
  return row;
}

async function ensureEntity(db: D1Database, type: string, name: string) {
  const existing = await db.prepare('SELECT id FROM entities WHERE type = ? AND lower(name) = lower(?) LIMIT 1').bind(type, name).first<{ id: string }>();
  if (existing?.id) return existing.id;
  const id = uid('entity');
  const now = nowIso();
  await db.prepare('INSERT INTO entities (id, type, name, aliases_json, summary, created_at, updated_at) VALUES (?, ?, ?, \'[]\', \'\', ?, ?)')
    .bind(id, type, name, now, now).run();
  return id;
}

async function linkEntities(db: D1Database, a: string, b: string, relation: string) {
  const existing = await db.prepare('SELECT id, strength FROM entity_links WHERE entity_a_id = ? AND entity_b_id = ? AND relation = ? LIMIT 1').bind(a, b, relation).first<{ id: string; strength: number }>();
  if (existing?.id) {
    await db.prepare('UPDATE entity_links SET strength = ? WHERE id = ?').bind(Math.min(1, Number(existing.strength || 0.5) + 0.05), existing.id).run();
    return existing.id;
  }
  const id = uid('link');
  await db.prepare('INSERT INTO entity_links (id, entity_a_id, entity_b_id, relation, strength, created_at) VALUES (?, ?, ?, ?, 0.6, ?)')
    .bind(id, a, b, relation, nowIso()).run();
  return id;
}

export async function maintainMemoryGraphForEvent(db: D1Database, event: TimelineEvent) {
  if (!event.project_id) return 0;
  const project = await db.prepare('SELECT name FROM projects WHERE id = ?').bind(event.project_id).first<{ name: string }>();
  if (!project?.name) return 0;
  const projectEntity = await ensureEntity(db, 'project', project.name);
  const text = `${event.title} ${event.body} ${safeJson<string[]>(event.tags_json, []).join(' ')}`.toLowerCase();
  const tech = ['cloudflare','github','d1','maplibre','supabase','react','typescript','javascript','node','postgres','redis','sqlite','android','kotlin','wrangler','workers ai','openstreetmap','vercel','render'];
  const systems = ['ai factory','designlab','ghostwriter','opportunity radar','revenue hunter','operating system'];
  let links = 0;
  for (const item of tech) {
    if (!text.includes(item)) continue;
    const entity = await ensureEntity(db, 'technology', item.replace(/\b\w/g, (c) => c.toUpperCase()));
    await linkEntities(db, projectEntity, entity, 'uses');
    links += 1;
  }
  for (const item of systems) {
    if (!text.includes(item)) continue;
    const entity = await ensureEntity(db, 'system', item.replace(/\b\w/g, (c) => c.toUpperCase()));
    await linkEntities(db, projectEntity, entity, 'works-with');
    links += 1;
  }
  return links;
}

export async function getMemoryGraph(db: D1Database) {
  const [entities, links] = await Promise.all([
    db.prepare('SELECT * FROM entities ORDER BY updated_at DESC LIMIT 250').all<Record<string, unknown>>(),
    db.prepare('SELECT * FROM entity_links ORDER BY strength DESC, created_at DESC LIMIT 500').all<Record<string, unknown>>(),
  ]);
  return { entities: entities.results ?? [], links: links.results ?? [] };
}

export async function listNotifications(db: D1Database, status = 'unread') {
  const result = status === 'all'
    ? await db.prepare('SELECT * FROM notifications ORDER BY created_at DESC LIMIT 100').all<Record<string, unknown>>()
    : await db.prepare('SELECT * FROM notifications WHERE status = ? ORDER BY CASE severity WHEN \'critical\' THEN 0 WHEN \'warning\' THEN 1 WHEN \'success\' THEN 2 ELSE 3 END, created_at DESC LIMIT 100').bind(status).all<Record<string, unknown>>();
  return result.results ?? [];
}

export async function markNotification(db: D1Database, id: string, status: 'read' | 'dismissed') {
  await db.prepare('UPDATE notifications SET status = ?, read_at = ? WHERE id = ?').bind(status, nowIso(), id).run();
  return db.prepare('SELECT * FROM notifications WHERE id = ?').bind(id).first();
}

export async function recordSystemCheck(db: D1Database, subsystem: string, status: string, detail = '', recoveryAction = '') {
  const id = uid('check');
  await db.prepare('INSERT INTO system_checks (id, subsystem, status, detail, recovery_action, checked_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, subsystem, status, detail.slice(0, 1000), recoveryAction.slice(0, 500), nowIso()).run();
  if (status === 'degraded' || status === 'down') {
    await createNotification(db, {
      type: 'system-health', severity: status === 'down' ? 'critical' : 'warning',
      title: `${subsystem} is ${status}`,
      body: detail,
      actionRef: subsystem,
      dedupeKey: `health:${subsystem}:${status}`,
    });
  } else {
    await db.prepare("UPDATE notifications SET status = 'read', read_at = ? WHERE type = 'system-health' AND action_ref = ? AND status = 'unread'").bind(nowIso(), subsystem).run();
  }
  return id;
}

function endpointForHealth(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.pathname === '/' || parsed.pathname === '') parsed.pathname = '/api/health';
    return parsed.toString();
  } catch { return url; }
}

async function checkEndpoint(db: D1Database, subsystem: string, rawUrl?: string) {
  if (!rawUrl) {
    await recordSystemCheck(db, subsystem, 'not-configured', 'Connector endpoint is not configured.', 'Add the connector URL and token when this system is ready for autonomous dispatch.');
    return;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 7000);
  try {
    const response = await fetch(endpointForHealth(rawUrl), { method: 'GET', signal: controller.signal, headers: { 'user-agent': 'Operating-System-Health/1.0' } });
    await recordSystemCheck(db, subsystem, response.ok ? 'healthy' : 'degraded', `HTTP ${response.status} from ${endpointForHealth(rawUrl)}`, response.ok ? '' : 'Retry on next health cycle; check endpoint contract if degradation persists.');
  } catch (error) {
    await recordSystemCheck(db, subsystem, 'degraded', error instanceof Error ? error.message : String(error), 'Retry on next health cycle.');
  } finally { clearTimeout(timer); }
}

export async function syncIntegrationRegistry(db: D1Database, env: RuntimeEnv) {
  const integrations = [
    ['github', 'GitHub', env.GITHUB_OWNER ? 'connected' : 'disconnected', { owner: env.GITHUB_OWNER ?? '' }],
    ['opportunity-radar', 'Opportunity Radar', env.RADAR_URL && env.RADAR_SYNC_TOKEN ? 'connected' : env.RADAR_URL ? 'needs-token' : 'disconnected', { url: env.RADAR_URL ?? '' }],
    ['ai-factory', 'AI Factory', env.AI_FACTORY_DISPATCH_URL ? 'connected' : 'ready-to-connect', { url: env.AI_FACTORY_DISPATCH_URL ?? '' }],
    ['designlab', 'DesignLab', env.DESIGNLAB_DISPATCH_URL ? 'connected' : 'ready-to-connect', { url: env.DESIGNLAB_DISPATCH_URL ?? '' }],
    ['ghostwriter', 'GhostWriter', env.GHOSTWRITER_DISPATCH_URL ? 'connected' : 'ready-to-connect', { url: env.GHOSTWRITER_DISPATCH_URL ?? '' }],
    ['revenue-hunter', 'Revenue Hunter', env.REVENUE_HUNTER_DISPATCH_URL ? 'connected' : 'ready-to-connect', { url: env.REVENUE_HUNTER_DISPATCH_URL ?? '' }],
    ['calendar', 'Calendar', 'bridge-ready', {}],
    ['gmail', 'Gmail', 'bridge-ready', {}],
    ['drive', 'Drive / Docs', 'bridge-ready', {}],
    ['voice', 'Voice Capture', 'bridge-ready', {}],
  ] as const;
  const now = nowIso();
  for (const [type, name, status, config] of integrations) {
    const existing = await db.prepare('SELECT id FROM integrations WHERE type = ? AND name = ?').bind(type, name).first<{ id: string }>();
    if (existing?.id) {
      await db.prepare('UPDATE integrations SET status = ?, config_json = ?, updated_at = ? WHERE id = ?').bind(status, JSON.stringify(config), now, existing.id).run();
    } else {
      await db.prepare('INSERT INTO integrations (id, type, name, status, config_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(uid('integration'), type, name, status, JSON.stringify(config), now, now).run();
    }
  }
}

export async function runSystemHealthChecks(db: D1Database, env: RuntimeEnv) {
  await syncIntegrationRegistry(db, env);
  try {
    await db.prepare('SELECT 1 AS ok').first();
    await recordSystemCheck(db, 'database', 'healthy', 'D1 query succeeded.');
  } catch (error) {
    await recordSystemCheck(db, 'database', 'down', error instanceof Error ? error.message : String(error), 'Database access requires immediate attention.');
  }
  const latestGithub = await db.prepare("SELECT occurred_at FROM events WHERE source IN ('github','github-activity') ORDER BY occurred_at DESC LIMIT 1").first<{ occurred_at: string }>();
  if (env.GITHUB_OWNER) {
    const age = latestGithub?.occurred_at ? Date.now() - Date.parse(latestGithub.occurred_at) : Infinity;
    await recordSystemCheck(db, 'github-ingestion', age < 72 * 3_600_000 ? 'healthy' : 'degraded', latestGithub?.occurred_at ? `Latest captured GitHub activity: ${latestGithub.occurred_at}` : 'No GitHub activity has been captured yet.', 'Scheduled sync will retry automatically.');
  }
  await checkEndpoint(db, 'opportunity-radar', env.RADAR_URL);
  await checkEndpoint(db, 'ai-factory', env.AI_FACTORY_HEALTH_URL || env.AI_FACTORY_DISPATCH_URL);
  await checkEndpoint(db, 'designlab', env.DESIGNLAB_HEALTH_URL || env.DESIGNLAB_DISPATCH_URL);
  await checkEndpoint(db, 'ghostwriter', env.GHOSTWRITER_HEALTH_URL || env.GHOSTWRITER_DISPATCH_URL);
  return getSystemHealth(db, env);
}

export async function getSystemHealth(db: D1Database, env: RuntimeEnv) {
  const checks = await db.prepare(`SELECT s.* FROM system_checks s
    JOIN (SELECT subsystem, MAX(checked_at) checked_at FROM system_checks GROUP BY subsystem) latest
      ON latest.subsystem = s.subsystem AND latest.checked_at = s.checked_at
    ORDER BY CASE s.status WHEN 'down' THEN 0 WHEN 'degraded' THEN 1 WHEN 'not-configured' THEN 2 ELSE 3 END, s.subsystem`).all<Record<string, unknown>>();
  const integrations = await db.prepare('SELECT * FROM integrations ORDER BY name').all<Record<string, unknown>>();
  return {
    controlPlaneMode: env.CONTROL_PLANE_MODE || 'active',
    autoExecutionLevel: env.AUTO_EXECUTION_LEVEL || 'low',
    security: {
      requireAuth: env.REQUIRE_AUTH === 'true',
      accessTokenConfigured: Boolean(env.OS_ACCESS_TOKEN),
      publicDashboard: env.REQUIRE_AUTH !== 'true',
    },
    checks: checks.results ?? [],
    integrations: (integrations.results ?? []).map((x) => ({ ...x, config: safeJson(String(x.config_json ?? '{}'), {}) })),
  };
}

export async function ingestConnectorEvents(db: D1Database, connector: string, items: Array<{ externalId: string; title: string; body?: string; projectName?: string; occurredAt?: string; type?: string; tags?: string[]; importance?: number; metadata?: Record<string, Json> }>) {
  const allowed = new Set(['calendar','gmail','drive','docs','voice','file','slack','manual-bridge']);
  if (!allowed.has(connector)) throw new Error('Unsupported connector');
  const created: TimelineEvent[] = [];
  for (const item of items.slice(0, 100)) {
    if (!item.externalId || !normalizeText(item.title)) continue;
    const existing = await db.prepare('SELECT id FROM connector_receipts WHERE connector = ? AND external_id = ? LIMIT 1').bind(connector, item.externalId).first<{ id: string }>();
    if (existing?.id) continue;
    const event = await insertEvent(db, {
      title: item.title,
      body: item.body ?? '',
      type: item.type,
      source: connector,
      projectName: item.projectName ?? null,
      occurredAt: item.occurredAt,
      tags: item.tags,
      importance: item.importance,
      metadata: item.metadata,
      rawRef: `${connector}:${item.externalId}`,
    });
    await runPipeline(db, event);
    await maintainMemoryGraphForEvent(db, event);
    await db.prepare('INSERT INTO connector_receipts (id, connector, external_id, event_id, received_at) VALUES (?, ?, ?, ?, ?)')
      .bind(uid('receipt'), connector, item.externalId, event.id, nowIso()).run();
    created.push(event);
  }
  return { connector, received: items.length, created: created.length, events: created };
}

export async function getAutomationRules(db: D1Database) {
  const result = await db.prepare('SELECT * FROM automation_rules ORDER BY name').all<Record<string, unknown>>();
  return (result.results ?? []).map((row) => ({ ...row, config: safeJson(String(row.config_json ?? '{}'), {}) }));
}

export async function updateAutomationRule(db: D1Database, id: string, enabled: boolean) {
  await db.prepare('UPDATE automation_rules SET enabled = ?, updated_at = ? WHERE id = ?').bind(enabled ? 1 : 0, nowIso(), id).run();
  return db.prepare('SELECT * FROM automation_rules WHERE id = ?').bind(id).first();
}

export async function runControlPlaneMaintenance(db: D1Database, env: RuntimeEnv) {
  const recent = await db.prepare("SELECT * FROM events WHERE occurred_at >= datetime('now','-72 hours') ORDER BY occurred_at DESC LIMIT 120").all<TimelineEvent>();
  let graphLinks = 0;
  for (const event of recent.results ?? []) graphLinks += await maintainMemoryGraphForEvent(db, event);
  const [experiments, reviews] = await Promise.all([
    proposeExperimentsFromOpportunities(db),
    ensureDecisionReviews(db),
  ]);
  const jobs = await processQueuedJobs(db, env, 5);
  const health = await runSystemHealthChecks(db, env);
  return { graphLinks, experimentsProposed: experiments, decisionReviewsCreated: reviews, jobsProcessed: jobs.length, health };
}

export async function afterEvent(db: D1Database, env: RuntimeEnv, event: TimelineEvent) {
  const graphLinks = await maintainMemoryGraphForEvent(db, event);
  if (event.importance >= 80 && ['problem','decision'].includes(event.type)) {
    await createNotification(db, {
      type: 'high-signal-event', severity: event.type === 'problem' ? 'warning' : 'info',
      title: event.title, body: event.body, projectId: event.project_id, actionRef: event.id,
      dedupeKey: `event:${event.id}`,
    });
  }
  return { graphLinks };
}

export async function routeCommand(db: D1Database, env: RuntimeEnv, command: string) {
  const text = normalizeText(command);
  if (!text) throw new Error('command is required');
  const lower = text.toLowerCase();
  if (/what should i|what next|priorit|focus|work on/.test(lower)) {
    return { kind: 'attention', message: 'Here is the current attention board.', data: await getAttentionBoard(db) };
  }
  if (/what broke|broken|health|connections|system status|what failed/.test(lower)) {
    return { kind: 'health', message: 'Here is the latest system health picture.', data: await getSystemHealth(db, env) };
  }
  if (/waiting for me|needs me|needs you|approval|approve/.test(lower)) {
    return { kind: 'approvals', message: 'These items need human authority.', data: await listApprovals(db) };
  }
  if (/projects|project status|what is happening/.test(lower) && !/build|fix|implement/.test(lower)) {
    return { kind: 'projects', message: 'Here is the live project picture.', data: await getProjectIntelligence(db) };
  }
  if (/^(build|implement|fix|continue|start|run|create|design|write|ship|deploy|publish|research|validate|find|make)\b/.test(lower) || /\b(ai factory|designlab|ghostwriter|revenue hunter|opportunity radar)\b/.test(lower)) {
    const job = await createExecutionJob(db, env, { objective: text, assignedSystem: chooseExecutionSystem(text) });
    if (job?.status === 'queued') await processExecutionJob(db, env, job.id);
    const refreshed = job ? await getExecutionJob(db, job.id) : null;
    return { kind: 'execution', message: refreshed?.status === 'waiting_approval' ? 'I prepared the job and moved the risky action to Needs You.' : refreshed?.status === 'blocked' ? 'I prepared the job, but its specialist connector is not configured yet.' : 'The objective is now in the execution engine.', data: refreshed };
  }
  const results = await searchEverything(db, text);
  return { kind: 'answer', message: results.length ? `I found ${results.length} matching operating-system records.` : 'I do not have enough captured evidence for that yet.', data: results.slice(0, 12) };
}

export async function getControlPlaneSnapshot(db: D1Database, env: RuntimeEnv) {
  const [attention, approvals, projects, jobs, experiments, reviews, notifications, health, rules] = await Promise.all([
    getAttentionBoard(db),
    listApprovals(db),
    getProjectIntelligence(db),
    listExecutionJobs(db),
    listExperiments(db),
    listDecisionReviews(db),
    listNotifications(db),
    getSystemHealth(db, env),
    getAutomationRules(db),
  ]);
  return {
    generatedAt: nowIso(),
    attention,
    approvals,
    projects,
    jobs,
    experiments,
    decisionReviews: reviews,
    notifications,
    health,
    rules,
    counts: {
      needsYou: approvals.length + reviews.filter((x) => x.status === 'pending' && Date.parse(String(x.review_at)) <= Date.now()).length,
      activeJobs: jobs.filter((x) => ['queued','running','waiting_approval','blocked'].includes(String(x.status))).length,
      proposedExperiments: experiments.filter((x) => x.status === 'proposed').length,
      unreadNotifications: notifications.length,
    },
  };
}

export async function applyExecutionCallback(
  db: D1Database,
  jobId: string,
  input: { status: string; result?: Record<string, Json>; blockedReason?: string; currentStep?: number },
) {
  const job = await getExecutionJob(db, jobId);
  if (!job) throw new Error('Execution job not found');
  const status = input.status.toLowerCase();
  if (['complete','completed','done','success'].includes(status)) {
    await completeJob(db, job, input.result ?? { accepted: true, callback: true });
  } else if (['blocked','failed','error'].includes(status)) {
    await markJobBlocked(db, job, input.blockedReason || `Remote system reported ${status}.`);
    if (input.result) await db.prepare('UPDATE execution_jobs SET result_json = ?, updated_at = ? WHERE id = ?').bind(JSON.stringify(input.result), nowIso(), jobId).run();
  } else if (['running','accepted','queued'].includes(status)) {
    await db.prepare("UPDATE execution_jobs SET status = 'running', lane = 'waiting', result_json = ?, current_step = ?, started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ?")
      .bind(JSON.stringify(input.result ?? {}), Math.max(0, input.currentStep ?? job.current_step), nowIso(), nowIso(), jobId).run();
  } else {
    throw new Error('Unsupported callback status');
  }
  return getExecutionJob(db, jobId);
}
