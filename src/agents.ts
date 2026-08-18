import type { AgentName, AgentResult, Brief, TimelineEvent } from './types';
import { firstSentence, nowIso, safeJson, uid } from './utils';

const AGENTS: AgentName[] = [
  'observer',
  'archivist',
  'knowledge-extractor',
  'strategist',
  'ghostwriter',
  'producer',
  'opportunity-scout',
  'chief-of-staff'
];

async function beginRun(db: D1Database, agent: AgentName, inputRef: string): Promise<string> {
  const id = uid('run');
  await db.prepare('INSERT INTO agent_runs (id, agent, status, input_ref, output_json, started_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, agent, 'running', inputRef, '{}', nowIso()).run();
  return id;
}

async function finishRun(db: D1Database, id: string, result: AgentResult, error?: string) {
  await db.prepare('UPDATE agent_runs SET status = ?, output_json = ?, error = ?, completed_at = ? WHERE id = ?')
    .bind(error ? 'failed' : 'complete', JSON.stringify(result), error ?? null, nowIso(), id).run();
}

async function executeAgent(db: D1Database, event: TimelineEvent, agent: AgentName): Promise<AgentResult> {
  const created: AgentResult['created'] = [];
  const notes: string[] = [];
  const tags = safeJson<string[]>(event.tags_json, []);
  const projectId = event.project_id;
  const text = `${event.title}. ${event.body}`.trim();

  if (agent === 'observer') {
    notes.push(`Observed ${event.type} from ${event.source} with importance ${event.importance}.`);
    if (event.importance >= 75) notes.push('High-signal event: preserve downstream provenance.');
  }

  if (agent === 'archivist') {
    const id = uid('mem');
    const kind = event.type === 'problem' ? 'problem-record' : event.type === 'decision' ? 'decision-record' : 'work-log';
    const summary = firstSentence(event.body || event.title, 220);
    await db.prepare(`INSERT INTO memories
      (id, kind, title, content, summary, project_id, source_event_ids_json, tags_json, confidence, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, kind, event.title, text, summary, projectId, JSON.stringify([event.id]), JSON.stringify(tags), 0.92, nowIso(), nowIso()).run();
    created.push({ kind: 'memory', id, title: event.title });
  }

  if (agent === 'knowledge-extractor') {
    if (['learning', 'problem', 'milestone', 'decision'].includes(event.type) || event.importance >= 70) {
      const id = uid('insight');
      const type = event.type === 'problem' ? 'lesson' : event.type === 'milestone' ? 'proof' : 'knowledge';
      const title = event.type === 'problem' ? `Lesson from: ${event.title}` : `Signal: ${event.title}`;
      const body = event.body ? firstSentence(event.body, 420) : `The event “${event.title}” is worth retaining as reusable knowledge.`;
      await db.prepare('INSERT INTO insights (id, type, title, body, project_id, score, evidence_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(id, type, title, body, projectId, Math.min(100, event.importance + 5), JSON.stringify([event.id]), nowIso()).run();
      created.push({ kind: 'insight', id, title });
    } else notes.push('No durable knowledge extracted from this low-signal event.');
  }

  if (agent === 'strategist') {
    if (event.type === 'decision') {
      const id = uid('decision');
      await db.prepare('INSERT INTO decisions (id, title, decision, rationale, project_id, status, source_event_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(id, event.title, event.body || event.title, 'Captured automatically from the timeline.', projectId, 'active', event.id, nowIso()).run();
      created.push({ kind: 'decision', id, title: event.title });
    }
    if (['problem', 'idea'].includes(event.type)) {
      const exists = await db.prepare("SELECT id FROM open_loops WHERE source_event_id = ? AND status = 'open'").bind(event.id).first<{ id: string }>();
      if (!exists) {
        const id = uid('loop');
        const title = event.type === 'problem' ? `Resolve: ${event.title}` : `Evaluate: ${event.title}`;
        await db.prepare(`INSERT INTO open_loops
          (id, title, detail, project_id, status, priority, source_event_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?)`)
          .bind(id, title, firstSentence(event.body || event.title, 280), projectId, event.importance, event.id, nowIso(), nowIso()).run();
        created.push({ kind: 'open-loop', id, title });
      }
    }
  }

  if (agent === 'ghostwriter') {
    if (event.importance >= 65 || ['milestone', 'learning', 'decision'].includes(event.type)) {
      const id = uid('content');
      const title = `From the build: ${event.title}`;
      const body = buildSocialDraft(event);
      await db.prepare(`INSERT INTO content_items
        (id, platform, format, title, body, status, project_id, source_ids_json, created_at, updated_at)
        VALUES (?, 'x', 'post', ?, ?, 'draft', ?, ?, ?, ?)`)
        .bind(id, title, body, projectId, JSON.stringify([event.id]), nowIso(), nowIso()).run();
      created.push({ kind: 'content', id, title });
    }
  }

  if (agent === 'producer') {
    if (event.importance >= 70 || ['problem', 'milestone', 'decision'].includes(event.type)) {
      const id = uid('beat');
      const beatType = event.type === 'problem' ? 'conflict' : event.type === 'milestone' ? 'payoff' : 'turning-point';
      const title = event.title;
      const narrative = event.body
        ? `${firstSentence(event.body, 360)} This is preserved as a documentary beat because it changed the story of the work.`
        : `A ${beatType} occurred: ${event.title}.`;
      await db.prepare('INSERT INTO documentary_beats (id, beat_type, title, narrative, project_id, source_ids_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(id, beatType, title, narrative, projectId, JSON.stringify([event.id]), nowIso()).run();
      created.push({ kind: 'documentary-beat', id, title });
    }
  }

  if (agent === 'opportunity-scout') {
    const phrase = `${event.title} ${event.body}`.toLowerCase();
    const opportunitySignal = /reusable|repeat|template|product|sell|customer|everyone|people need|same component|automation|manual/i.test(phrase);
    if (opportunitySignal || (event.type === 'idea' && event.importance >= 60)) {
      const id = uid('insight');
      const title = `Opportunity: ${event.title}`;
      const body = 'Check whether this work can become a reusable component, workflow, template, service, or standalone product. Validate against repeated need before investing heavily.';
      await db.prepare("INSERT INTO insights (id, type, title, body, project_id, score, evidence_json, created_at) VALUES (?, 'opportunity', ?, ?, ?, ?, ?, ?)")
        .bind(id, title, body, projectId, Math.min(100, event.importance + 10), JSON.stringify([event.id]), nowIso()).run();
      created.push({ kind: 'opportunity', id, title });
    }
  }

  if (agent === 'chief-of-staff') {
    notes.push('Event incorporated into the operating picture; daily brief can now be refreshed.');
  }

  return { agent, created, notes };
}

export async function runPipeline(db: D1Database, event: TimelineEvent): Promise<AgentResult[]> {
  const results: AgentResult[] = [];
  for (const agent of AGENTS) {
    const runId = await beginRun(db, agent, event.id);
    try {
      const result = await executeAgent(db, event, agent);
      await finishRun(db, runId, result);
      results.push(result);
    } catch (error) {
      const result: AgentResult = { agent, created: [], notes: [] };
      await finishRun(db, runId, result, error instanceof Error ? error.message : String(error));
      results.push(result);
    }
  }
  return results;
}

function buildSocialDraft(event: TimelineEvent): string {
  const detail = firstSentence(event.body || event.title, 260);
  if (event.type === 'problem') return `A useful build lesson: ${event.title}.\n\n${detail}\n\nThe point isn't pretending problems disappear. It's building a system that remembers the fix so you don't pay for the same lesson twice.`;
  if (event.type === 'decision') return `Decision made: ${event.title}.\n\n${detail}\n\nGood systems don't just store the final answer. They preserve why the decision was made, so future changes have context.`;
  if (event.type === 'milestone') return `${event.title}.\n\n${detail}\n\nSmall proof beats big promises. Capture the work while it happens and the story writes itself.`;
  return `${event.title}.\n\n${detail}\n\nTurn the work into reusable knowledge while the context is still fresh.`;
}

export async function minePatterns(db: D1Database): Promise<number> {
  const rows = await db.prepare("SELECT id, project_id, tags_json, occurred_at FROM events WHERE occurred_at >= datetime('now','-180 days') ORDER BY occurred_at DESC LIMIT 2000").all<{ id: string; project_id: string | null; tags_json: string; occurred_at: string }>();
  const map = new Map<string, { count: number; projects: Set<string>; evidence: string[] }>();
  for (const row of rows.results ?? []) {
    for (const tag of safeJson<string[]>(row.tags_json, [])) {
      const bucket = map.get(tag) ?? { count: 0, projects: new Set<string>(), evidence: [] };
      bucket.count += 1;
      if (row.project_id) bucket.projects.add(row.project_id);
      if (bucket.evidence.length < 12) bucket.evidence.push(row.id);
      map.set(tag, bucket);
    }
  }
  let created = 0;
  for (const [tag, pattern] of map) {
    if (pattern.count < 3 || pattern.projects.size < 2) continue;
    const title = `Cross-project pattern: ${tag}`;
    const recent = await db.prepare("SELECT id FROM insights WHERE title = ? AND created_at >= datetime('now','-30 days')").bind(title).first<{ id: string }>();
    if (recent) continue;
    const id = uid('insight');
    const body = `${tag} has appeared ${pattern.count} times across ${pattern.projects.size} projects in the last 180 days. Check whether a shared component, playbook, automation or reusable product can remove duplicated effort.`;
    await db.prepare("INSERT INTO insights (id, type, title, body, project_id, score, evidence_json, created_at) VALUES (?, 'pattern', ?, ?, NULL, ?, ?, ?)")
      .bind(id, title, body, Math.min(95, 60 + pattern.count * 3 + pattern.projects.size * 5), JSON.stringify(pattern.evidence), nowIso()).run();
    created += 1;
  }
  const stale = await db.prepare("SELECT id, title, project_id, priority FROM open_loops WHERE status = 'open' AND created_at < datetime('now','-14 days') ORDER BY priority DESC LIMIT 10").all<{ id: string; title: string; project_id: string | null; priority: number }>();
  for (const loop of stale.results ?? []) {
    const title = `Stale loop: ${loop.title}`;
    const recent = await db.prepare("SELECT id FROM insights WHERE title = ? AND created_at >= datetime('now','-14 days')").bind(title).first<{ id: string }>();
    if (recent) continue;
    const id = uid('insight');
    await db.prepare("INSERT INTO insights (id, type, title, body, project_id, score, evidence_json, created_at) VALUES (?, 'attention', ?, ?, ?, ?, ?, ?)")
      .bind(id, title, 'This open loop has survived for more than two weeks. Close it, schedule it, delegate it, or consciously kill it.', loop.project_id, Math.min(95, loop.priority + 10), JSON.stringify([loop.id]), nowIso()).run();
    created += 1;
  }
  return created;
}

export async function generateDailyBrief(db: D1Database, date = new Date().toISOString().slice(0, 10)): Promise<Brief> {
  await minePatterns(db);
  const [loops, recent, signals, contentCount] = await Promise.all([
    db.prepare("SELECT title, detail, priority FROM open_loops WHERE status = 'open' ORDER BY priority DESC, created_at DESC LIMIT 5").all<{ title: string; detail: string; priority: number }>(),
    db.prepare("SELECT title, type FROM events WHERE occurred_at >= datetime('now','-48 hours') ORDER BY importance DESC, occurred_at DESC LIMIT 10").all<{ title: string; type: string }>(),
    db.prepare("SELECT title FROM insights WHERE created_at >= datetime('now','-7 days') ORDER BY score DESC, created_at DESC LIMIT 5").all<{ title: string }>(),
    db.prepare("SELECT COUNT(*) AS count FROM content_items WHERE status IN ('draft','ready')").first<{ count: number }>()
  ]);
  const focus = (loops.results ?? []).slice(0, 3);
  const wins = (recent.results ?? []).filter((e) => e.type === 'milestone').map((e) => e.title).slice(0, 4);
  const brief: Brief = {
    date,
    headline: focus.length ? `Protect momentum: ${focus[0]!.title}` : 'No critical open loop is dominating the board.',
    focus,
    recentWins: wins,
    signals: (signals.results ?? []).map((x) => x.title),
    contentReady: contentCount?.count ?? 0,
    openLoops: (loops.results ?? []).length
  };
  await db.prepare('INSERT OR REPLACE INTO daily_briefs (id, brief_date, content_json, created_at) VALUES (?, ?, ?, ?)')
    .bind(`brief_${date}`, date, JSON.stringify(brief), nowIso()).run();
  return brief;
}

export async function buildDocumentaryEpisode(db: D1Database, days = 30) {
  const result = await db.prepare(`
    SELECT beat_type, title, narrative, created_at FROM documentary_beats
    WHERE created_at >= datetime('now', ?)
    ORDER BY created_at ASC LIMIT 100
  `).bind(`-${Math.max(1, Math.min(days, 365))} days`).all<{ beat_type: string; title: string; narrative: string; created_at: string }>();
  const beats = result.results ?? [];
  return {
    title: `The Build — Last ${days} Days`,
    logline: beats.length
      ? `${beats.length} turning points captured from real work, reconstructed from evidence rather than memory.`
      : 'No documentary beats captured yet.',
    beats,
    outline: beats.map((b, index) => ({ act: index < beats.length / 3 ? 1 : index < (beats.length * 2) / 3 ? 2 : 3, ...b }))
  };
}

export async function buildWeeklyReflection(db: D1Database, days = 7) {
  const windowDays = Math.max(1, Math.min(days, 90));
  const modifier = `-${windowDays} days`;
  const [events, decisions, loops, insights] = await Promise.all([
    db.prepare("SELECT type, title, importance, occurred_at FROM events WHERE occurred_at >= datetime('now', ?) ORDER BY occurred_at DESC").bind(modifier).all<{ type: string; title: string; importance: number; occurred_at: string }>(),
    db.prepare("SELECT title, decision, created_at FROM decisions WHERE created_at >= datetime('now', ?) ORDER BY created_at DESC LIMIT 20").bind(modifier).all<{ title: string; decision: string; created_at: string }>(),
    db.prepare("SELECT title, priority, status FROM open_loops WHERE created_at >= datetime('now', ?) OR status = 'open' ORDER BY priority DESC LIMIT 20").bind(modifier).all<{ title: string; priority: number; status: string }>(),
    db.prepare("SELECT type, title, score FROM insights WHERE created_at >= datetime('now', ?) ORDER BY score DESC LIMIT 20").bind(modifier).all<{ type: string; title: string; score: number }>()
  ]);
  const allEvents = events.results ?? [];
  const counts = allEvents.reduce<Record<string, number>>((acc, event) => { acc[event.type] = (acc[event.type] ?? 0) + 1; return acc; }, {});
  return {
    windowDays,
    eventCount: allEvents.length,
    signalMix: counts,
    wins: allEvents.filter((e) => e.type === 'milestone').slice(0, 8),
    friction: allEvents.filter((e) => e.type === 'problem').slice(0, 8),
    decisions: decisions.results ?? [],
    unresolved: (loops.results ?? []).filter((l) => l.status === 'open').slice(0, 10),
    strongestSignals: insights.results ?? [],
    prompt: 'What should be repeated, stopped, systemized, documented or turned into a product next?'
  };
}
