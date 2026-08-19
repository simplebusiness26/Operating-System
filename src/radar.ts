import type { RuntimeEnv } from './env';
import { safeJson } from './utils';

export interface RadarProject {
  id: string;
  name: string;
  status: string;
  summary: string;
  goal: string;
  updatedAt?: string;
  reuseReadiness: 'concept' | 'needs_work' | 'lift_and_shift' | 'drop_in';
}

export interface RadarCapability {
  name: string;
  capability: string;
  maturity: 'experimental' | 'working' | 'production' | 'battle_tested';
  evidenceStrength: number;
  notes: string;
  providedBy: string[];
  evidenceRefs: string[];
}

export interface RadarResource {
  name: string;
  resourceKind: 'budget' | 'time' | 'compute' | 'team';
  amount: number;
  unit: string;
  period: 'week' | 'month' | 'quarter' | 'once';
  committed: number;
}

export interface RadarGoal {
  name: string;
  horizon: 'month' | 'quarter' | 'year' | 'long_term';
  priority: number;
  metric?: string | null;
  target?: string | null;
  evidenceRefs: string[];
}

export interface RadarSnapshot {
  version: 1;
  source: 'operating-system';
  generatedAt: string;
  projects: RadarProject[];
  capabilities: RadarCapability[];
  resources: RadarResource[];
  goals: RadarGoal[];
}

interface ProjectRow {
  id: string;
  name: string;
  status: string;
  summary: string;
  goal: string;
  updated_at: string;
}

interface CapabilityEvidenceRow {
  id: string;
  project_id: string | null;
  project_name: string | null;
  type: string;
  source: string;
  title: string;
  body: string;
  tags_json: string;
  importance: number;
}

interface SettingRow {
  key: string;
  value_json: string;
}

/**
 * Deterministic capability vocabulary shared by intent with Radar's taxonomy.
 * A capability is emitted only when actual work evidence contains a matching
 * term. We deliberately favour false negatives over claiming the owner can do
 * something they have never demonstrated.
 */
const CAPABILITY_PATTERNS: Array<{
  capability: string;
  name: string;
  pattern: RegExp;
}> = [
  { capability: 'authentication', name: 'Authentication and accounts', pattern: /\b(auth|authentication|login|sign[ -]?in|user accounts?)\b/i },
  { capability: 'multi tenant', name: 'Multi-tenant workspaces', pattern: /\b(multi[ -]?tenant|workspace|organisation|organization|tenant)\b/i },
  { capability: 'permissions', name: 'Roles and permissions', pattern: /\b(rbac|permissions?|roles?|access control)\b/i },
  { capability: 'audit log', name: 'Audit logging', pattern: /\b(audit log|audit trail|activity log)\b/i },
  { capability: 'background jobs', name: 'Background jobs and scheduling', pattern: /\b(queue|worker|background job|cron|scheduler|scheduled job)\b/i },
  { capability: 'notifications', name: 'Notifications', pattern: /\b(notification|push notification|email sending|alerts?)\b/i },
  { capability: 'file storage', name: 'File storage and uploads', pattern: /\b(file upload|uploads?|object storage|s3|r2)\b/i },
  { capability: 'search', name: 'Search', pattern: /\b(search|full[ -]?text|semantic search)\b/i },
  { capability: 'payments', name: 'Taking payments', pattern: /\b(stripe|payments?|checkout|card payment|deposit)\b/i },
  { capability: 'subscriptions', name: 'Subscription billing', pattern: /\b(subscription|recurring billing|billing|invoice)\b/i },
  { capability: 'marketplace', name: 'Marketplace and payouts', pattern: /\b(marketplace|payout|split payment|two[ -]?sided)\b/i },
  { capability: 'data pipeline', name: 'Data pipelines', pattern: /\b(ingestion|data pipeline|etl|scrap(e|ing)|crawler)\b/i },
  { capability: 'analytics', name: 'Analytics and reporting', pattern: /\b(analytics|dashboard|reporting|metrics|charts?)\b/i },
  { capability: 'llm', name: 'LLM workflows', pattern: /\b(llm|openai|anthropic|claude|gemini|ai agent|agentic|prompt)\b/i },
  { capability: 'structured output', name: 'Structured extraction', pattern: /\b(structured output|extraction|extractor|document parsing|zod schema)\b/i },
  { capability: 'embeddings', name: 'Embeddings and semantic search', pattern: /\b(embedding|vector search|semantic search|rag|pgvector)\b/i },
  { capability: 'evals', name: 'AI evaluation', pattern: /\b(evals?|model evaluation|ai testing|prompt test)\b/i },
  { capability: 'web app', name: 'Responsive web application', pattern: /\b(next\.js|react|web app|frontend|pwa|responsive)\b/i },
  { capability: 'mobile app', name: 'Mobile application', pattern: /\b(android|apk|react native|mobile app|ios)\b/i },
  { capability: 'pwa', name: 'Installable web app', pattern: /\b(pwa|progressive web app|installable)\b/i },
  { capability: 'maps', name: 'Maps and geospatial', pattern: /\b(maplibre|mapbox|leaflet|geospatial|mapping|openstreetmap)\b/i },
  { capability: 'realtime', name: 'Realtime and collaboration', pattern: /\b(websocket|realtime|real[ -]?time|live updates|collaboration)\b/i },
  { capability: 'api', name: 'Public API', pattern: /\b(rest api|public api|api endpoint|\/api\/)\b/i },
  { capability: 'webhooks', name: 'Webhooks', pattern: /\b(webhook|callback endpoint)\b/i },
  { capability: 'deployment', name: 'Deployment and hosting', pattern: /\b(vercel|cloudflare|render|railway|deploy|deployment|hosting|ci\/cd|github actions)\b/i },
  { capability: 'monitoring', name: 'Monitoring and observability', pattern: /\b(observability|monitoring|runtime logs|logging|health check)\b/i },
  { capability: 'content', name: 'Content and SEO', pattern: /\b(content studio|seo|marketing site|social post|ghostwriter)\b/i },
];

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function parseSetting<T>(rows: SettingRow[], key: string, fallback: T): T {
  const row = rows.find((item) => item.key === key);
  return row ? safeJson<T>(row.value_json, fallback) : fallback;
}

function validResources(value: unknown): RadarResource[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is RadarResource => {
    if (!item || typeof item !== 'object') return false;
    const row = item as Record<string, unknown>;
    return typeof row.name === 'string' &&
      ['budget', 'time', 'compute', 'team'].includes(String(row.resourceKind)) &&
      typeof row.amount === 'number' && row.amount >= 0 &&
      typeof row.unit === 'string';
  }).map((item) => ({
    ...item,
    period: ['week', 'month', 'quarter', 'once'].includes(item.period) ? item.period : 'month',
    committed: typeof item.committed === 'number' && item.committed >= 0 ? item.committed : 0,
  }));
}

function validGoals(value: unknown): RadarGoal[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is RadarGoal => {
    if (!item || typeof item !== 'object') return false;
    const row = item as Record<string, unknown>;
    return typeof row.name === 'string' && row.name.trim().length >= 3;
  }).map((item) => ({
    ...item,
    horizon: ['month', 'quarter', 'year', 'long_term'].includes(item.horizon) ? item.horizon : 'quarter',
    priority: Number.isInteger(item.priority) ? Math.max(1, Math.min(10, item.priority)) : 5,
    evidenceRefs: Array.isArray(item.evidenceRefs) ? item.evidenceRefs : ['os:setting:radar.goals'],
  }));
}

export async function buildRadarSnapshot(db: D1Database): Promise<RadarSnapshot> {
  const [projectResult, evidenceResult, settingsResult] = await Promise.all([
    db.prepare('SELECT id, name, status, summary, goal, updated_at FROM projects ORDER BY updated_at DESC LIMIT 500').all<ProjectRow>(),
    db.prepare(`
      SELECT e.id, e.project_id, p.name AS project_name, e.type, e.source,
             e.title, e.body, e.tags_json, e.importance
      FROM events e
      LEFT JOIN projects p ON p.id = e.project_id
      WHERE e.type IN ('code','milestone','learning','decision')
        AND e.occurred_at >= datetime('now','-365 days')
      ORDER BY e.occurred_at DESC
      LIMIT 3000
    `).all<CapabilityEvidenceRow>(),
    db.prepare("SELECT key, value_json FROM settings WHERE key IN ('radar.resources','radar.goals')").all<SettingRow>(),
  ]);

  const projects = (projectResult.results ?? []).map((project): RadarProject => ({
    id: project.id,
    name: project.name,
    status: project.status,
    summary: project.summary ?? '',
    goal: project.goal ?? '',
    updatedAt: project.updated_at,
    reuseReadiness: 'needs_work',
  }));

  const evidenceRows = evidenceResult.results ?? [];
  const capabilities: RadarCapability[] = [];

  for (const definition of CAPABILITY_PATTERNS) {
    const matches = evidenceRows.filter((row) => {
      // A code/milestone record is evidence that the capability exists in real
      // work. Learning/decision records can reinforce it but cannot create the
      // claim alone.
      const text = `${row.title}\n${row.body}\n${safeJson<string[]>(row.tags_json, []).join(' ')}`;
      return definition.pattern.test(text);
    });
    const hardMatches = matches.filter((row) => row.type === 'code' || row.type === 'milestone');
    if (hardMatches.length === 0) continue;

    const projectNames = [...new Set(hardMatches.map((row) => row.project_name).filter((name): name is string => Boolean(name)))];
    const refs = [...new Set(matches.map((row) => `os-event:${row.id}`))].slice(0, 100);
    const milestoneCount = hardMatches.filter((row) => row.type === 'milestone').length;
    const strength = clamp01(0.5 + Math.min(0.25, hardMatches.length * 0.04) + Math.min(0.15, projectNames.length * 0.03));

    capabilities.push({
      name: definition.name,
      capability: definition.capability,
      // Automatic inference never claims production/battle-tested maturity.
      // The owner or later repo analysis can promote it with stronger evidence.
      maturity: hardMatches.length >= 3 || milestoneCount > 0 ? 'working' : 'experimental',
      evidenceStrength: strength,
      notes: `Automatically inferred from ${hardMatches.length} code/milestone record(s) across ${projectNames.length || 1} project(s) in the Operating System.`,
      providedBy: projectNames,
      evidenceRefs: refs,
    });
  }

  // The node name is deliberately stable. If a project's objective changes,
  // Radar updates this goal's target rather than retaining the old objective as
  // a second strategic goal.
  const projectGoals: RadarGoal[] = projects
    .filter((project) => project.goal.trim().length >= 3)
    .map((project) => ({
      name: `${project.name} project goal`.slice(0, 200),
      horizon: 'quarter',
      priority: 5,
      metric: 'project_objective',
      target: project.goal.slice(0, 200),
      evidenceRefs: [`os-project:${project.id}`],
    }));

  const settingsRows = settingsResult.results ?? [];
  const resources = validResources(parseSetting<unknown>(settingsRows, 'radar.resources', []));
  const configuredGoals = validGoals(parseSetting<unknown>(settingsRows, 'radar.goals', []));

  return {
    version: 1,
    source: 'operating-system',
    generatedAt: new Date().toISOString(),
    projects,
    capabilities,
    resources,
    goals: [...projectGoals, ...configuredGoals],
  };
}

function radarSyncUrl(base: string): string {
  const url = new URL(base);
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    throw new Error('RADAR_URL must use https outside local development.');
  }
  url.pathname = '/api/v1/integrations/operating-system/sync';
  url.search = '';
  url.hash = '';
  return url.toString();
}

export async function syncRadar(env: RuntimeEnv): Promise<{ configured: boolean; result?: unknown }> {
  if (!env.RADAR_URL || !env.RADAR_SYNC_TOKEN) return { configured: false };

  const snapshot = await buildRadarSnapshot(env.DB);
  const response = await fetch(radarSyncUrl(env.RADAR_URL), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.RADAR_SYNC_TOKEN}`,
      'content-type': 'application/json',
      'user-agent': 'PersonalOperatingSystem/1.0',
    },
    body: JSON.stringify(snapshot),
  });

  const text = await response.text();
  let result: unknown = text;
  try {
    result = text ? JSON.parse(text) : null;
  } catch {
    // Keep the original response body for diagnostics without exposing secrets.
  }

  if (!response.ok) {
    throw new Error(`Radar sync failed with HTTP ${response.status}: ${text.slice(0, 500)}`);
  }

  return { configured: true, result };
}
