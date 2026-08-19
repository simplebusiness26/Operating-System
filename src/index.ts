import { buildDocumentaryEpisode, buildWeeklyReflection, generateDailyBrief, runPipeline } from './agents';
import { enrichTextWithWorkersAI } from './ai';
import {
  closeOpenLoop,
  createProject,
  getAgentRuns,
  getContent,
  getDashboard,
  getOpenLoops,
  getProjects,
  getTimeline,
  insertEvent,
  searchEverything,
  updateContentStatus
} from './db';
import { githubPayloadToEvents, verifyGitHubSignature } from './github';
import { ingestGitHubRepositoryInventory, type GitHubRepoInput } from './github-inventory';
import { buildRadarSnapshot, syncRadar } from './radar';
import type { EventInput, Json } from './types';
import type { RuntimeEnv } from './env';
import { constantTimeSecretEquals, json, normalizeText } from './utils';

function bearerToken(request: Request): string {
  const auth = request.headers.get('authorization') ?? '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : '';
}

async function accessTokenAuthorized(request: Request, env: RuntimeEnv): Promise<boolean> {
  if (!env.OS_ACCESS_TOKEN) return false;
  const token = bearerToken(request) || request.headers.get('x-os-token') || '';
  return token ? constantTimeSecretEquals(token, env.OS_ACCESS_TOKEN) : false;
}

async function radarSyncTriggerAuthorized(request: Request, env: RuntimeEnv): Promise<boolean> {
  if (await accessTokenAuthorized(request, env)) return true;
  if (!env.RADAR_SYNC_TOKEN) return false;
  const token = bearerToken(request);
  return token ? constantTimeSecretEquals(token, env.RADAR_SYNC_TOKEN) : false;
}

async function authorized(request: Request, env: RuntimeEnv): Promise<boolean> {
  if (env.REQUIRE_AUTH !== 'true') return true;
  return accessTokenAuthorized(request, env);
}

async function readJson<T>(request: Request): Promise<T> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) throw new Error('Expected application/json');
  return await request.json() as T;
}

async function syncRadarSafely(env: RuntimeEnv): Promise<void> {
  try {
    await syncRadar(env);
  } catch (error) {
    console.error(JSON.stringify({
      level: 'error',
      subsystem: 'radar-sync',
      message: error instanceof Error ? error.message : String(error)
    }));
  }
}

async function api(request: Request, env: RuntimeEnv, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === '/api/health') {
    return json({
      ok: true,
      app: env.APP_NAME,
      aiMode: env.AI_MODE,
      githubInventoryConfigured: Boolean(env.GITHUB_OWNER),
      radarSyncConfigured: Boolean(env.RADAR_URL && env.RADAR_SYNC_TOKEN),
      time: new Date().toISOString()
    });
  }

  // Snapshot access exposes the owner's internal capability picture and always
  // requires the OS access token. Sync/import actions are write-only from the
  // caller's perspective, so the dedicated Radar bridge token may trigger them.
  if (path === '/api/radar/snapshot') {
    if (!(await accessTokenAuthorized(request, env))) return json({ error: 'Unauthorized' }, { status: 401 });
    if (request.method === 'GET') return json(await buildRadarSnapshot(env.DB));
    return json({ error: 'Method not allowed' }, { status: 405 });
  }

  if (path === '/api/radar/sync') {
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, { status: 405 });
    if (!(await radarSyncTriggerAuthorized(request, env))) return json({ error: 'Unauthorized' }, { status: 401 });
    return json(await syncRadar(env));
  }

  if (path === '/api/github/inventory') {
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, { status: 405 });
    if (!(await radarSyncTriggerAuthorized(request, env))) return json({ error: 'Unauthorized' }, { status: 401 });

    const body = await readJson<{ owner?: string; repositories?: GitHubRepoInput[] }>(request);
    const configuredOwner = normalizeText(env.GITHUB_OWNER);
    const suppliedOwner = normalizeText(body.owner);
    const owner = suppliedOwner || configuredOwner;
    if (!owner) return json({ error: 'GITHUB_OWNER is not configured' }, { status: 400 });
    if (configuredOwner && owner.toLowerCase() !== configuredOwner.toLowerCase()) {
      return json({ error: 'Inventory owner does not match configured GitHub owner' }, { status: 400 });
    }
    if (!Array.isArray(body.repositories)) return json({ error: 'repositories must be an array' }, { status: 400 });
    if (body.repositories.length > 300) return json({ error: 'Too many repositories in one inventory update' }, { status: 413 });

    const inventory = await ingestGitHubRepositoryInventory(env.DB, owner, body.repositories);
    const radar = await syncRadar(env);
    return json({ inventory, radar });
  }

  if (!(await authorized(request, env))) return json({ error: 'Unauthorized' }, { status: 401 });

  if (path === '/api/dashboard' && request.method === 'GET') return json(await getDashboard(env.DB));
  if (path === '/api/timeline' && request.method === 'GET') {
    return json(await getTimeline(env.DB, Number(url.searchParams.get('limit') ?? 60), url.searchParams.get('projectId')));
  }
  if (path === '/api/projects' && request.method === 'GET') return json(await getProjects(env.DB));
  if (path === '/api/open-loops' && request.method === 'GET') return json(await getOpenLoops(env.DB));
  if (path === '/api/content' && request.method === 'GET') return json(await getContent(env.DB, url.searchParams.get('status')));
  if (path === '/api/agents' && request.method === 'GET') return json(await getAgentRuns(env.DB));

  if (path === '/api/events' && request.method === 'POST') {
    const body = await readJson<EventInput>(request);
    if (!normalizeText(body.title)) return json({ error: 'title is required' }, { status: 400 });
    const event = await insertEvent(env.DB, body);
    const pipeline = await runPipeline(env.DB, event);
    ctx.waitUntil(generateDailyBrief(env.DB));
    ctx.waitUntil(syncRadarSafely(env));
    return json({ event, pipeline }, { status: 201 });
  }

  if (path === '/api/projects' && request.method === 'POST') {
    const body = await readJson<{ name: string; summary?: string; goal?: string }>(request);
    if (!normalizeText(body.name)) return json({ error: 'name is required' }, { status: 400 });
    const project = await createProject(env.DB, body);
    ctx.waitUntil(syncRadarSafely(env));
    return json(project, { status: 201 });
  }

  if (path === '/api/search' && request.method === 'GET') {
    const query = normalizeText(url.searchParams.get('q'));
    if (!query) return json([]);
    return json(await searchEverything(env.DB, query));
  }

  if (path === '/api/brief/generate' && request.method === 'POST') return json(await generateDailyBrief(env.DB));
  if (path === '/api/documentary' && request.method === 'GET') {
    return json(await buildDocumentaryEpisode(env.DB, Number(url.searchParams.get('days') ?? 30)));
  }

  if (path === '/api/reflection' && request.method === 'GET') {
    return json(await buildWeeklyReflection(env.DB, Number(url.searchParams.get('days') ?? 7)));
  }

  if (path === '/api/export' && request.method === 'GET') {
    const tables = ['projects','events','memories','entities','entity_links','decisions','open_loops','insights','content_items','documentary_beats','agent_runs','daily_briefs','integrations','settings'] as const;
    const output: Record<string, unknown[]> = {};
    for (const table of tables) {
      const rows = await env.DB.prepare(`SELECT * FROM ${table}`).all();
      output[table] = rows.results ?? [];
    }
    return json({ version: 1, exportedAt: new Date().toISOString(), data: output });
  }

  if (path.startsWith('/api/open-loops/') && request.method === 'PATCH') {
    const id = path.split('/').pop()!;
    const body = await readJson<{ status?: string }>(request);
    if (body.status !== 'closed') return json({ error: 'Only closing an open loop is supported here.' }, { status: 400 });
    return json(await closeOpenLoop(env.DB, id));
  }

  if (path.startsWith('/api/content/') && request.method === 'PATCH') {
    const id = path.split('/').pop()!;
    const body = await readJson<{ status?: string }>(request);
    const allowed = new Set(['idea', 'draft', 'ready', 'published', 'archived']);
    if (!body.status || !allowed.has(body.status)) return json({ error: 'Invalid content status.' }, { status: 400 });
    return json(await updateContentStatus(env.DB, id, body.status));
  }

  if (path === '/api/ask' && request.method === 'POST') {
    const body = await readJson<{ question: string }>(request);
    const question = normalizeText(body.question);
    if (!question) return json({ error: 'question is required' }, { status: 400 });
    const results = await searchEverything(env.DB, question);
    const context = results.slice(0, 12).map((item) => `${item.kind}: ${item.title} — ${item.text}`).join('\n');
    const enriched = await enrichTextWithWorkersAI(
      env,
      'You are the user’s evidence-grounded personal operating system. Answer only from the supplied operating-system records. State uncertainty when evidence is weak. Be concise and action-oriented.',
      `Question: ${question}\n\nRecords:\n${context || 'No matching records.'}`
    );
    if (enriched) return json({ answer: enriched, mode: 'workers-ai', evidence: results.slice(0, 8) });
    return json({ answer: deterministicAnswer(question, results), mode: 'deterministic', evidence: results.slice(0, 8) });
  }

  return json({ error: 'Not found' }, { status: 404 });
}

function deterministicAnswer(question: string, results: Array<Record<string, unknown>>): string {
  if (!results.length) return 'I do not have enough captured evidence to answer that yet. Add the relevant work, note, decision, or integration and ask again.';
  const q = question.toLowerCase();
  const top = results.slice(0, 5).map((r) => `• ${String(r.title)}`).join('\n');
  if (/unfinished|open|todo|left|need to do/.test(q)) return `These are the strongest matching open threads in your records:\n${top}`;
  if (/learn|lesson|realise|realize/.test(q)) return `These records contain the strongest matching lessons:\n${top}`;
  if (/decision|decide|chose|choose/.test(q)) return `These are the most relevant recorded decisions or decision-adjacent events:\n${top}`;
  if (/content|post|write|documentary/.test(q)) return `These records are the strongest raw material for content:\n${top}`;
  return `I found ${results.length} relevant records. The strongest matches are:\n${top}`;
}

async function githubWebhook(request: Request, env: RuntimeEnv, ctx: ExecutionContext): Promise<Response> {
  const declaredLength = Number(request.headers.get('content-length') ?? 0);
  if (declaredLength > 2_000_000) return json({ error: 'Payload too large' }, { status: 413 });
  const deliveryId = request.headers.get('x-github-delivery');
  if (deliveryId) {
    const seen = await env.DB.prepare('SELECT id FROM webhook_deliveries WHERE id = ?').bind(deliveryId).first<{ id: string }>();
    if (seen) return json({ accepted: true, duplicate: true });
  }
  const rawBody = await request.text();
  if (rawBody.length > 2_000_000) return json({ error: 'Payload too large' }, { status: 413 });
  const valid = await verifyGitHubSignature(rawBody, request.headers.get('x-hub-signature-256'), env.GITHUB_WEBHOOK_SECRET);
  if (!valid) return json({ error: 'Invalid GitHub signature' }, { status: 401 });
  const eventName = request.headers.get('x-github-event') ?? '';
  if (deliveryId) await env.DB.prepare('INSERT INTO webhook_deliveries (id, source, received_at) VALUES (?, ?, ?)').bind(deliveryId, 'github', new Date().toISOString()).run();
  let payload: Record<string, Json>;
  try {
    payload = JSON.parse(rawBody) as Record<string, Json>;
  } catch {
    return json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const inputs = githubPayloadToEvents(eventName, payload);
  const created = [];
  for (const input of inputs) {
    const event = await insertEvent(env.DB, input);
    const pipeline = await runPipeline(env.DB, event);
    created.push({ event, pipeline });
  }
  if (created.length) {
    ctx.waitUntil(generateDailyBrief(env.DB));
    ctx.waitUntil(syncRadarSafely(env));
  }
  return json({ accepted: true, eventName, created: created.length });
}

export default {
  async fetch(request: Request, env: RuntimeEnv, ctx: ExecutionContext): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname.startsWith('/api/')) return await api(request, env, ctx);
      if (url.pathname === '/webhooks/github' && request.method === 'POST') return await githubWebhook(request, env, ctx);
      return env.ASSETS.fetch(request);
    } catch (error) {
      console.error(JSON.stringify({ level: 'error', message: error instanceof Error ? error.message : String(error) }));
      return json({ error: 'Internal server error' }, { status: 500 });
    }
  },

  async scheduled(controller: ScheduledController, env: RuntimeEnv, ctx: ExecutionContext): Promise<void> {
    if (controller.cron === '0 7 * * *') ctx.waitUntil(generateDailyBrief(env.DB));
    ctx.waitUntil(syncRadarSafely(env));
  }
} satisfies ExportedHandler<RuntimeEnv>;
