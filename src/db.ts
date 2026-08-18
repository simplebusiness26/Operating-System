import type { EventInput, TimelineEvent, Brief } from './types';
import { inferEventType, inferImportance, nowIso, parseTags, slugify, uid, safeJson } from './utils';

export async function ensureProject(db: D1Database, name: string): Promise<string> {
  const slug = slugify(name);
  const existing = await db.prepare('SELECT id FROM projects WHERE slug = ?').bind(slug).first<{ id: string }>();
  if (existing?.id) return existing.id;
  const id = uid('project');
  const now = nowIso();
  await db.prepare(
    'INSERT INTO projects (id, name, slug, status, summary, goal, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(id, name.trim(), slug, 'active', '', '', now, now).run();
  return id;
}

export async function insertEvent(db: D1Database, input: EventInput): Promise<TimelineEvent> {
  const title = input.title.trim();
  const body = input.body?.trim() ?? '';
  let projectId = input.projectId ?? null;
  if (!projectId && input.projectName?.trim()) projectId = await ensureProject(db, input.projectName.trim());

  const event: TimelineEvent = {
    id: uid('evt'),
    occurred_at: input.occurredAt ?? nowIso(),
    type: input.type ?? inferEventType(title, body),
    source: input.source ?? 'manual',
    title,
    body,
    project_id: projectId,
    tags_json: JSON.stringify(input.tags?.length ? input.tags : parseTags(`${title} ${body}`)),
    metadata_json: JSON.stringify(input.metadata ?? {}),
    importance: input.importance ?? inferImportance(title, body),
    raw_ref: input.rawRef ?? null,
    created_at: nowIso()
  };

  await db.prepare(`
    INSERT INTO events
    (id, occurred_at, type, source, title, body, project_id, tags_json, metadata_json, importance, raw_ref, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    event.id, event.occurred_at, event.type, event.source, event.title, event.body,
    event.project_id, event.tags_json, event.metadata_json, event.importance, event.raw_ref, event.created_at
  ).run();
  return event;
}

export async function getTimeline(db: D1Database, limit = 50, projectId?: string | null): Promise<TimelineEvent[]> {
  const capped = Math.min(Math.max(limit, 1), 200);
  const statement = projectId
    ? db.prepare('SELECT * FROM events WHERE project_id = ? ORDER BY occurred_at DESC LIMIT ?').bind(projectId, capped)
    : db.prepare('SELECT * FROM events ORDER BY occurred_at DESC LIMIT ?').bind(capped);
  const result = await statement.all<TimelineEvent>();
  return result.results ?? [];
}

export async function getProjects(db: D1Database) {
  const result = await db.prepare(`
    SELECT p.*,
      (SELECT COUNT(*) FROM events e WHERE e.project_id = p.id) AS event_count,
      (SELECT COUNT(*) FROM open_loops o WHERE o.project_id = p.id AND o.status = 'open') AS open_loop_count
    FROM projects p ORDER BY p.updated_at DESC
  `).all();
  return result.results ?? [];
}

export async function createProject(db: D1Database, input: { name: string; summary?: string; goal?: string }) {
  const id = await ensureProject(db, input.name);
  const now = nowIso();
  await db.prepare('UPDATE projects SET summary = ?, goal = ?, updated_at = ? WHERE id = ?')
    .bind(input.summary ?? '', input.goal ?? '', now, id).run();
  return db.prepare('SELECT * FROM projects WHERE id = ?').bind(id).first();
}

export async function getDashboard(db: D1Database) {
  const [counts, events, loops, insights, content, projects, brief] = await Promise.all([
    db.prepare(`SELECT
      (SELECT COUNT(*) FROM events) AS events,
      (SELECT COUNT(*) FROM memories) AS memories,
      (SELECT COUNT(*) FROM projects WHERE status = 'active') AS projects,
      (SELECT COUNT(*) FROM open_loops WHERE status = 'open') AS open_loops,
      (SELECT COUNT(*) FROM content_items WHERE status IN ('idea','draft','ready')) AS content,
      (SELECT COUNT(*) FROM insights) AS insights`).first(),
    db.prepare('SELECT * FROM events ORDER BY occurred_at DESC LIMIT 12').all(),
    db.prepare("SELECT * FROM open_loops WHERE status = 'open' ORDER BY priority DESC, created_at DESC LIMIT 8").all(),
    db.prepare('SELECT * FROM insights ORDER BY score DESC, created_at DESC LIMIT 8').all(),
    db.prepare("SELECT * FROM content_items WHERE status IN ('idea','draft','ready') ORDER BY created_at DESC LIMIT 8").all(),
    db.prepare("SELECT * FROM projects WHERE status = 'active' ORDER BY updated_at DESC LIMIT 8").all(),
    db.prepare('SELECT * FROM daily_briefs ORDER BY brief_date DESC LIMIT 1').first<{ content_json: string }>()
  ]);
  return {
    counts: counts ?? {},
    events: events.results ?? [],
    openLoops: loops.results ?? [],
    insights: insights.results ?? [],
    content: content.results ?? [],
    projects: projects.results ?? [],
    brief: safeJson<Brief | null>(brief?.content_json, null)
  };
}

export async function searchEverything(db: D1Database, query: string) {
  const q = `%${query.replace(/[%_]/g, '')}%`;
  const [events, memories, insights, decisions, content] = await Promise.all([
    db.prepare('SELECT id, occurred_at AS date, type AS kind, title, body AS text, project_id FROM events WHERE title LIKE ? OR body LIKE ? ORDER BY occurred_at DESC LIMIT 20').bind(q, q).all(),
    db.prepare('SELECT id, created_at AS date, kind, title, summary AS text, project_id FROM memories WHERE title LIKE ? OR content LIKE ? OR summary LIKE ? ORDER BY created_at DESC LIMIT 20').bind(q, q, q).all(),
    db.prepare("SELECT id, created_at AS date, 'insight' AS kind, title, body AS text, project_id FROM insights WHERE title LIKE ? OR body LIKE ? ORDER BY score DESC LIMIT 20").bind(q, q).all(),
    db.prepare("SELECT id, created_at AS date, 'decision' AS kind, title, decision AS text, project_id FROM decisions WHERE title LIKE ? OR decision LIKE ? OR rationale LIKE ? ORDER BY created_at DESC LIMIT 20").bind(q, q, q).all(),
    db.prepare("SELECT id, created_at AS date, 'content' AS kind, title, body AS text, project_id FROM content_items WHERE title LIKE ? OR body LIKE ? ORDER BY created_at DESC LIMIT 20").bind(q, q).all()
  ]);
  return [...(events.results ?? []), ...(memories.results ?? []), ...(insights.results ?? []), ...(decisions.results ?? []), ...(content.results ?? [])]
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))
    .slice(0, 50);
}

export async function getAgentRuns(db: D1Database, limit = 40) {
  const result = await db.prepare('SELECT * FROM agent_runs ORDER BY started_at DESC LIMIT ?').bind(Math.min(limit, 100)).all();
  return result.results ?? [];
}

export async function getContent(db: D1Database, status?: string | null) {
  const statement = status
    ? db.prepare('SELECT * FROM content_items WHERE status = ? ORDER BY created_at DESC LIMIT 100').bind(status)
    : db.prepare('SELECT * FROM content_items ORDER BY created_at DESC LIMIT 100');
  const result = await statement.all();
  return result.results ?? [];
}

export async function updateContentStatus(db: D1Database, id: string, status: string) {
  await db.prepare('UPDATE content_items SET status = ?, updated_at = ? WHERE id = ?').bind(status, nowIso(), id).run();
  return db.prepare('SELECT * FROM content_items WHERE id = ?').bind(id).first();
}

export async function getOpenLoops(db: D1Database) {
  const result = await db.prepare("SELECT * FROM open_loops WHERE status = 'open' ORDER BY priority DESC, created_at DESC LIMIT 100").all();
  return result.results ?? [];
}

export async function closeOpenLoop(db: D1Database, id: string) {
  await db.prepare("UPDATE open_loops SET status = 'closed', updated_at = ? WHERE id = ?").bind(nowIso(), id).run();
  return db.prepare('SELECT * FROM open_loops WHERE id = ?').bind(id).first();
}
