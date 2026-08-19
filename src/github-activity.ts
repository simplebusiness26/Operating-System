import { runPipeline } from './agents';
import { insertEvent } from './db';
import type { RuntimeEnv } from './env';
import type { EventInput, Json } from './types';
import { normalizeText } from './utils';

interface GitHubActivityRepo {
  name?: string;
}

interface GitHubActivityEvent {
  id?: string;
  type?: string;
  repo?: GitHubActivityRepo;
  payload?: Record<string, unknown>;
  public?: boolean;
  created_at?: string;
}

export interface GitHubActivitySyncResult {
  configured: boolean;
  owner?: string;
  mode?: 'public' | 'authenticated';
  eventsSeen?: number;
  eligibleEvents?: number;
  eventsCreated?: number;
  skippedExisting?: number;
  skippedRepositories?: string[];
}

function headers(env: RuntimeEnv): Headers {
  const out = new Headers({
    accept: 'application/vnd.github+json',
    'user-agent': 'PersonalOperatingSystem/1.0',
    'x-github-api-version': '2026-03-10',
  });
  if (env.GITHUB_TOKEN) out.set('authorization', `Bearer ${env.GITHUB_TOKEN}`);
  return out;
}

function activityUrl(env: RuntimeEnv, owner: string): string {
  const suffix = env.GITHUB_TOKEN ? 'events' : 'events/public';
  const url = new URL(`https://api.github.com/users/${encodeURIComponent(owner)}/${suffix}`);
  url.searchParams.set('per_page', '100');
  url.searchParams.set('page', '1');
  return url.toString();
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function projectName(event: GitHubActivityEvent): string {
  const fullName = event.repo?.name?.trim() ?? '';
  return fullName.split('/').pop()?.trim() || 'GitHub';
}

function branchName(ref: string): string {
  return ref.replace(/^refs\/heads\//, '').replace(/^refs\/tags\//, '') || ref;
}

function eventMetadata(event: GitHubActivityEvent): Record<string, Json> {
  return {
    githubEventId: event.id ?? '',
    githubEventType: event.type ?? '',
    repository: event.repo?.name ?? '',
    public: event.public ?? true,
  };
}

export function githubActivityToEventInput(event: GitHubActivityEvent): EventInput | null {
  const eventId = asString(event.id);
  const eventType = asString(event.type);
  const occurredAt = asString(event.created_at);
  const repo = event.repo?.name?.trim() ?? '';
  const project = projectName(event);
  const payload = event.payload ?? {};
  if (!eventId || !eventType || !occurredAt || !repo) return null;

  const metadata = eventMetadata(event);
  const rawRef = `github-event:${eventId}`;

  if (eventType === 'PushEvent') {
    const ref = asString(payload.ref);
    const commits = Array.isArray(payload.commits) ? payload.commits.map(asObject).filter(Boolean) as Record<string, unknown>[] : [];
    const count = asNumber(payload.distinct_size) || asNumber(payload.size) || commits.length || 1;
    const messages = commits
      .map((commit) => asString(commit.message).split('\n')[0])
      .filter(Boolean)
      .slice(0, 6);
    const body = [
      `GitHub push to ${repo}${ref ? ` on ${branchName(ref)}` : ''}.`,
      messages.length ? `Commits: ${messages.join(' · ')}` : '',
    ].filter(Boolean).join(' ');
    return {
      title: `Pushed ${count} commit${count === 1 ? '' : 's'} to ${project}`,
      body,
      type: 'code',
      source: 'github-activity',
      projectName: project,
      occurredAt,
      importance: count >= 5 ? 62 : 55,
      rawRef,
      metadata: { ...metadata, ref, commitCount: count },
      tags: ['github', 'code', 'push'],
    };
  }

  if (eventType === 'PullRequestEvent') {
    const action = asString(payload.action) || 'updated';
    const pr = asObject(payload.pull_request);
    if (!pr) return null;
    const title = normalizeText(pr.title) || 'Untitled pull request';
    const body = normalizeText(pr.body);
    const url = asString(pr.html_url);
    const merged = pr.merged === true;
    return {
      title: `PR ${action}: ${title}`,
      body,
      type: action === 'closed' && merged ? 'milestone' : 'code',
      source: 'github-activity',
      projectName: project,
      occurredAt,
      importance: action === 'closed' && merged ? 78 : 62,
      rawRef,
      metadata: { ...metadata, action, url, merged },
      tags: ['github', 'code', 'pull-request'],
    };
  }

  if (eventType === 'IssuesEvent') {
    const action = asString(payload.action) || 'updated';
    const issue = asObject(payload.issue);
    if (!issue) return null;
    const title = normalizeText(issue.title) || 'Untitled issue';
    const body = normalizeText(issue.body);
    const url = asString(issue.html_url);
    return {
      title: `Issue ${action}: ${title}`,
      body,
      type: action === 'closed' ? 'milestone' : 'problem',
      source: 'github-activity',
      projectName: project,
      occurredAt,
      importance: action === 'opened' ? 65 : 55,
      rawRef,
      metadata: { ...metadata, action, url },
      tags: ['github', 'issue'],
    };
  }

  if (eventType === 'ReleaseEvent') {
    const action = asString(payload.action) || 'published';
    const release = asObject(payload.release);
    const name = normalizeText(release?.name) || normalizeText(release?.tag_name) || project;
    const url = asString(release?.html_url);
    return {
      title: `Release ${action}: ${name}`,
      body: `GitHub release activity for ${repo}.`,
      type: 'milestone',
      source: 'github-activity',
      projectName: project,
      occurredAt,
      importance: 82,
      rawRef,
      metadata: { ...metadata, action, url },
      tags: ['github', 'launch', 'release'],
    };
  }

  if (eventType === 'CreateEvent' || eventType === 'DeleteEvent') {
    const refType = asString(payload.ref_type) || 'ref';
    const ref = asString(payload.ref);
    const verb = eventType === 'CreateEvent' ? 'Created' : 'Deleted';
    return {
      title: `${verb} ${refType}${ref ? ` ${ref}` : ''} in ${project}`,
      body: `GitHub ${eventType === 'CreateEvent' ? 'creation' : 'deletion'} activity for ${repo}.`,
      type: 'code',
      source: 'github-activity',
      projectName: project,
      occurredAt,
      importance: refType === 'repository' ? 70 : 48,
      rawRef,
      metadata: { ...metadata, refType, ref },
      tags: ['github', 'code'],
    };
  }

  return null;
}

function skippedRepoSet(env: RuntimeEnv): Set<string> {
  return new Set(
    (env.GITHUB_ACTIVITY_SKIP_REPOS ?? '')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
}

export async function syncGitHubActivity(
  db: D1Database,
  env: RuntimeEnv,
): Promise<GitHubActivitySyncResult> {
  const owner = env.GITHUB_OWNER?.trim();
  if (!owner) return { configured: false };

  const response = await fetch(activityUrl(env, owner), { headers: headers(env) });
  if (!response.ok) throw new Error(`GitHub activity sync failed with HTTP ${response.status}`);
  const events = await response.json() as GitHubActivityEvent[];
  const skipRepos = skippedRepoSet(env);
  const cutoff = Date.now() - (48 * 60 * 60 * 1000);

  const eligible = events
    .filter((event) => {
      const createdAt = Date.parse(event.created_at ?? '');
      const repo = projectName(event).toLowerCase();
      return Number.isFinite(createdAt) && createdAt >= cutoff && !skipRepos.has(repo);
    })
    .slice(0, 40)
    .reverse();

  let eventsCreated = 0;
  let skippedExisting = 0;

  for (const activity of eligible) {
    const input = githubActivityToEventInput(activity);
    if (!input?.rawRef) continue;
    const existing = await db.prepare(
      "SELECT id FROM events WHERE source = 'github-activity' AND raw_ref = ? LIMIT 1"
    ).bind(input.rawRef).first<{ id: string }>();
    if (existing?.id) {
      skippedExisting += 1;
      continue;
    }

    const event = await insertEvent(db, input);
    await runPipeline(db, event);
    eventsCreated += 1;
  }

  return {
    configured: true,
    owner,
    mode: env.GITHUB_TOKEN ? 'authenticated' : 'public',
    eventsSeen: events.length,
    eligibleEvents: eligible.length,
    eventsCreated,
    skippedExisting,
    skippedRepositories: [...skipRepos],
  };
}
