import legacy from './index';
import type { RuntimeEnv } from './env';
import { constantTimeSecretEquals, json, normalizeText } from './utils';
import type { Json } from './types';
import {
  applyExecutionCallback,
  createExecutionJob,
  createExperiment,
  getAttentionBoard,
  getAutomationRules,
  getControlPlaneSnapshot,
  getMemoryGraph,
  getProjectIntelligence,
  getSystemHealth,
  ingestConnectorEvents,
  listApprovals,
  listDecisionReviews,
  listExecutionJobs,
  listExperiments,
  listNotifications,
  markNotification,
  processExecutionJob,
  resolveApproval,
  reviewDecision,
  routeCommand,
  runControlPlaneMaintenance,
  runSystemHealthChecks,
  syncIntegrationRegistry,
  updateAutomationRule,
  updateExperiment,
} from './control-plane';

function bearer(request: Request): string {
  const auth = request.headers.get('authorization') || '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : '';
}

async function ownerAuthorized(request: Request, env: RuntimeEnv): Promise<boolean> {
  if (!env.OS_ACCESS_TOKEN) return false;
  const token = bearer(request) || request.headers.get('x-os-token') || '';
  return Boolean(token) && constantTimeSecretEquals(token, env.OS_ACCESS_TOKEN);
}

async function dashboardAuthorized(request: Request, env: RuntimeEnv): Promise<boolean> {
  if (env.REQUIRE_AUTH !== 'true') return true;
  return ownerAuthorized(request, env);
}

async function callbackAuthorized(request: Request, env: RuntimeEnv): Promise<boolean> {
  if (!env.OS_CALLBACK_TOKEN) return false;
  const token = bearer(request) || request.headers.get('x-os-callback-token') || '';
  return Boolean(token) && constantTimeSecretEquals(token, env.OS_CALLBACK_TOKEN);
}

async function body<T>(request: Request): Promise<T> {
  if (!(request.headers.get('content-type') || '').includes('application/json')) throw new Error('Expected application/json');
  return request.json() as Promise<T>;
}

function idFrom(path: string): string {
  return decodeURIComponent(path.split('/').filter(Boolean).pop() || '');
}

function needsOwner(env: RuntimeEnv) {
  return json({
    error: 'Owner authorization required',
    setupRequired: !env.OS_ACCESS_TOKEN,
    message: env.OS_ACCESS_TOKEN
      ? 'Enter the Operating System owner access token.'
      : 'Configure OS_ACCESS_TOKEN before enabling commands, approvals, connector imports or policy changes.',
  }, { status: 401 });
}

async function controlApi(request: Request, env: RuntimeEnv): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === '/api/health' && request.method === 'GET') {
    return json({
      ok: true,
      app: env.APP_NAME,
      controlPlane: true,
      controlPlaneMode: env.CONTROL_PLANE_MODE || 'active',
      autoExecutionLevel: env.AUTO_EXECUTION_LEVEL || 'low',
      aiMode: env.AI_MODE,
      githubInventoryConfigured: Boolean(env.GITHUB_OWNER),
      githubActivityConfigured: Boolean(env.GITHUB_OWNER),
      radarSyncConfigured: Boolean(env.RADAR_URL && env.RADAR_SYNC_TOKEN),
      security: {
        requireAuth: env.REQUIRE_AUTH === 'true',
        accessTokenConfigured: Boolean(env.OS_ACCESS_TOKEN),
        callbackTokenConfigured: Boolean(env.OS_CALLBACK_TOKEN),
        publicDashboard: env.REQUIRE_AUTH !== 'true',
      },
      time: new Date().toISOString(),
    });
  }

  if (path === '/api/security/status' && request.method === 'GET') {
    return json({
      requireAuth: env.REQUIRE_AUTH === 'true',
      accessTokenConfigured: Boolean(env.OS_ACCESS_TOKEN),
      callbackTokenConfigured: Boolean(env.OS_CALLBACK_TOKEN),
      publicDashboard: env.REQUIRE_AUTH !== 'true',
      sensitiveActionsLocked: !env.OS_ACCESS_TOKEN,
      recommendation: env.REQUIRE_AUTH === 'true' && env.OS_ACCESS_TOKEN
        ? 'Private access is enabled.'
        : 'Set OS_ACCESS_TOKEN and OS_CALLBACK_TOKEN, then set REQUIRE_AUTH=true before importing private mail, calendar or documents.',
    });
  }

  const protectedReads = new Set([
    '/api/control','/api/attention','/api/project-intelligence','/api/approvals','/api/execution','/api/experiments',
    '/api/decision-reviews','/api/notifications','/api/system-health','/api/memory-graph','/api/automation-rules',
  ]);
  if (request.method === 'GET' && protectedReads.has(path) && !(await dashboardAuthorized(request, env))) return needsOwner(env);

  if (path === '/api/control' && request.method === 'GET') return json(await getControlPlaneSnapshot(env.DB, env));
  if (path === '/api/attention' && request.method === 'GET') return json(await getAttentionBoard(env.DB));
  if (path === '/api/project-intelligence' && request.method === 'GET') return json(await getProjectIntelligence(env.DB));
  if (path === '/api/approvals' && request.method === 'GET') return json(await listApprovals(env.DB, url.searchParams.get('status') || 'pending'));
  if (path === '/api/execution' && request.method === 'GET') return json(await listExecutionJobs(env.DB, url.searchParams.get('status')));
  if (path === '/api/experiments' && request.method === 'GET') return json(await listExperiments(env.DB, url.searchParams.get('status')));
  if (path === '/api/decision-reviews' && request.method === 'GET') return json(await listDecisionReviews(env.DB, url.searchParams.get('status') || 'pending'));
  if (path === '/api/notifications' && request.method === 'GET') return json(await listNotifications(env.DB, url.searchParams.get('status') || 'unread'));
  if (path === '/api/system-health' && request.method === 'GET') return json(await getSystemHealth(env.DB, env));
  if (path === '/api/memory-graph' && request.method === 'GET') return json(await getMemoryGraph(env.DB));
  if (path === '/api/automation-rules' && request.method === 'GET') return json(await getAutomationRules(env.DB));

  if (path === '/api/execution/callback' && request.method === 'POST') {
    if (!(await callbackAuthorized(request, env))) return json({ error: 'Invalid callback authorization' }, { status: 401 });
    const input = await body<{ jobId: string; status: string; result?: Record<string, Json>; blockedReason?: string; currentStep?: number }>(request);
    if (!normalizeText(input.jobId) || !normalizeText(input.status)) return json({ error: 'jobId and status are required' }, { status: 400 });
    return json(await applyExecutionCallback(env.DB, input.jobId, input));
  }

  const owner = await ownerAuthorized(request, env);
  const protectedWrite = request.method !== 'GET' && (
    path === '/api/command' || path === '/api/execution' || path.startsWith('/api/execution/') ||
    path.startsWith('/api/approvals/') || path === '/api/experiments' || path.startsWith('/api/experiments/') ||
    path.startsWith('/api/decision-reviews/') || path.startsWith('/api/notifications/') ||
    path === '/api/system-health/refresh' || path === '/api/connectors/import' || path === '/api/maintenance/run' ||
    path.startsWith('/api/automation-rules/')
  );
  if (protectedWrite && !owner) return needsOwner(env);

  if (path === '/api/command' && request.method === 'POST') {
    const input = await body<{ command: string }>(request);
    return json(await routeCommand(env.DB, env, input.command));
  }
  if (path === '/api/execution' && request.method === 'POST') {
    const input = await body<{ title?: string; objective: string; projectId?: string | null; projectName?: string | null; assignedSystem?: string; actionType?: string; priority?: number; confidence?: number; sourceRef?: string | null; plan?: Array<{ title: string; system?: string }> }>(request);
    return json(await createExecutionJob(env.DB, env, input), { status: 201 });
  }
  if (/^\/api\/execution\/[^/]+\/run$/.test(path) && request.method === 'POST') {
    const parts = path.split('/').filter(Boolean);
    return json(await processExecutionJob(env.DB, env, decodeURIComponent(parts[2] || '')));
  }
  if (path.startsWith('/api/approvals/') && request.method === 'PATCH') {
    const input = await body<{ decision: 'approved' | 'rejected'; note?: string }>(request);
    if (!['approved','rejected'].includes(input.decision)) return json({ error: 'decision must be approved or rejected' }, { status: 400 });
    return json(await resolveApproval(env.DB, env, idFrom(path), input.decision, input.note || ''));
  }
  if (path === '/api/experiments' && request.method === 'POST') {
    const input = await body<{ title?: string; projectId?: string | null; projectName?: string | null; hypothesis: string; test: string; successCriteria: string; priority?: number; sourceRef?: string | null }>(request);
    if (!normalizeText(input.hypothesis) || !normalizeText(input.test) || !normalizeText(input.successCriteria)) return json({ error: 'hypothesis, test and successCriteria are required' }, { status: 400 });
    return json(await createExperiment(env.DB, input), { status: 201 });
  }
  if (path.startsWith('/api/experiments/') && request.method === 'PATCH') {
    const input = await body<{ status?: string; result?: string; learning?: string; confidence?: number }>(request);
    return json(await updateExperiment(env.DB, idFrom(path), input));
  }
  if (path.startsWith('/api/decision-reviews/') && request.method === 'PATCH') {
    const input = await body<{ outcome: string; score: number; lesson?: string }>(request);
    if (!normalizeText(input.outcome)) return json({ error: 'outcome is required' }, { status: 400 });
    return json(await reviewDecision(env.DB, idFrom(path), input));
  }
  if (path.startsWith('/api/notifications/') && request.method === 'PATCH') {
    const input = await body<{ status: 'read' | 'dismissed' }>(request);
    if (!['read','dismissed'].includes(input.status)) return json({ error: 'Invalid notification status' }, { status: 400 });
    return json(await markNotification(env.DB, idFrom(path), input.status));
  }
  if (path === '/api/system-health/refresh' && request.method === 'POST') return json(await runSystemHealthChecks(env.DB, env));
  if (path === '/api/maintenance/run' && request.method === 'POST') return json(await runControlPlaneMaintenance(env.DB, env));
  if (path === '/api/connectors/import' && request.method === 'POST') {
    const input = await body<{ connector: string; items: Array<{ externalId: string; title: string; body?: string; projectName?: string; occurredAt?: string; type?: string; tags?: string[]; importance?: number; metadata?: Record<string, Json> }> }>(request);
    if (!normalizeText(input.connector) || !Array.isArray(input.items)) return json({ error: 'connector and items are required' }, { status: 400 });
    return json(await ingestConnectorEvents(env.DB, input.connector, input.items));
  }
  if (path.startsWith('/api/automation-rules/') && request.method === 'PATCH') {
    const input = await body<{ enabled: boolean }>(request);
    return json(await updateAutomationRule(env.DB, idFrom(path), Boolean(input.enabled)));
  }

  return null;
}

export default {
  async fetch(request: Request, env: RuntimeEnv, ctx: ExecutionContext): Promise<Response> {
    try {
      const handled = await controlApi(request, env);
      if (handled) return handled;
      const url = new URL(request.url);
      if (url.pathname === '/') return Response.redirect(new URL('/control.html', url), 302);
      return legacy.fetch(request, env, ctx);
    } catch (error) {
      console.error(JSON.stringify({ level: 'error', subsystem: 'control-entry', message: error instanceof Error ? error.message : String(error) }));
      return json({ error: 'Internal server error' }, { status: 500 });
    }
  },

  async scheduled(controller: ScheduledController, env: RuntimeEnv, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil((async () => {
      await syncIntegrationRegistry(env.DB, env);
      await legacy.scheduled(controller, env, ctx);
      await runControlPlaneMaintenance(env.DB, env);
    })());
  },
} satisfies ExportedHandler<RuntimeEnv>;
