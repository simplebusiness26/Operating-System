import { ensureProject, insertEvent } from './db';
import type { RuntimeEnv } from './env';
import { nowIso } from './utils';

interface GitHubOwner {
  login?: string;
}

export interface GitHubRepoInput {
  name?: string;
  full_name?: string;
  html_url?: string;
  description?: string | null;
  homepage?: string | null;
  language?: string | null;
  topics?: string[];
  fork?: boolean;
  archived?: boolean;
  disabled?: boolean;
  pushed_at?: string | null;
  updated_at?: string | null;
  visibility?: string;
  owner?: GitHubOwner;
}

export interface GitHubInventoryResult {
  configured: boolean;
  owner?: string;
  repositoriesSeen?: number;
  projectsUpserted?: number;
  evidenceCreated?: number;
}

function headers(env: RuntimeEnv): Headers {
  const out = new Headers({
    accept: 'application/vnd.github+json',
    'user-agent': 'PersonalOperatingSystem/1.0',
    'x-github-api-version': '2022-11-28',
  });
  if (env.GITHUB_TOKEN) out.set('authorization', `Bearer ${env.GITHUB_TOKEN}`);
  return out;
}

function inventoryUrl(env: RuntimeEnv, owner: string, page: number): string {
  if (env.GITHUB_TOKEN) {
    const url = new URL('https://api.github.com/user/repos');
    url.searchParams.set('affiliation', 'owner');
    url.searchParams.set('visibility', 'all');
    url.searchParams.set('sort', 'updated');
    url.searchParams.set('direction', 'desc');
    url.searchParams.set('per_page', '100');
    url.searchParams.set('page', String(page));
    return url.toString();
  }
  const url = new URL(`https://api.github.com/users/${encodeURIComponent(owner)}/repos`);
  url.searchParams.set('type', 'owner');
  url.searchParams.set('sort', 'updated');
  url.searchParams.set('direction', 'desc');
  url.searchParams.set('per_page', '100');
  url.searchParams.set('page', String(page));
  return url.toString();
}

function repoSummary(repo: GitHubRepoInput): string {
  const parts: string[] = [];
  if (repo.description?.trim()) parts.push(repo.description.trim());
  if (repo.language?.trim()) parts.push(`Primary language: ${repo.language.trim()}.`);
  if (repo.topics?.length) parts.push(`Topics: ${repo.topics.slice(0, 20).join(', ')}.`);
  if (repo.homepage?.trim()) parts.push(`Homepage: ${repo.homepage.trim()}.`);
  return parts.join(' ').slice(0, 2000);
}

export async function ingestGitHubRepositoryInventory(
  db: D1Database,
  owner: string,
  repos: GitHubRepoInput[],
): Promise<GitHubInventoryResult> {
  const normalizedOwner = owner.trim();
  if (!normalizedOwner) return { configured: false };

  const owned = repos.filter((repo) => {
    const sameOwner = !repo.owner?.login || repo.owner.login.toLowerCase() === normalizedOwner.toLowerCase();
    return sameOwner && !repo.fork && !repo.archived && !repo.disabled && Boolean(repo.name?.trim());
  });

  let projectsUpserted = 0;
  let evidenceCreated = 0;
  const observedAt = nowIso();

  for (const repo of owned) {
    const name = repo.name!.trim();
    const projectId = await ensureProject(db, name);
    const summary = repoSummary(repo);

    if (summary) {
      await db.prepare(`
        UPDATE projects
        SET summary = CASE WHEN trim(summary) = '' THEN ? ELSE summary END,
            updated_at = CASE WHEN updated_at < ? THEN ? ELSE updated_at END
        WHERE id = ?
      `).bind(summary, repo.updated_at ?? observedAt, repo.updated_at ?? observedAt, projectId).run();
    }
    projectsUpserted += 1;

    const repoUrl = repo.html_url?.trim() || `https://github.com/${normalizedOwner}/${encodeURIComponent(name)}`;
    const existing = await db.prepare(
      "SELECT id FROM events WHERE source = 'github-inventory' AND raw_ref = ? LIMIT 1"
    ).bind(repoUrl).first<{ id: string }>();

    if (!existing?.id) {
      const metadataText = [
        `GitHub repository ${repo.full_name ?? `${normalizedOwner}/${name}`}.`,
        summary,
        repo.visibility ? `Visibility: ${repo.visibility}.` : '',
      ].filter(Boolean).join(' ');

      await insertEvent(db, {
        title: `Repository inventory: ${name}`,
        body: metadataText,
        type: 'code',
        source: 'github-inventory',
        projectId,
        occurredAt: repo.pushed_at ?? repo.updated_at ?? observedAt,
        importance: 45,
        rawRef: repoUrl,
        metadata: {
          repository: repo.full_name ?? `${normalizedOwner}/${name}`,
          language: repo.language ?? null,
          topics: repo.topics ?? [],
          visibility: repo.visibility ?? 'public',
        },
        tags: ['github', 'repository', 'inventory', ...(repo.language ? [repo.language.toLowerCase()] : [])],
      });
      evidenceCreated += 1;
    }
  }

  return {
    configured: true,
    owner: normalizedOwner,
    repositoriesSeen: owned.length,
    projectsUpserted,
    evidenceCreated,
  };
}

/**
 * Fallback inventory path for environments where the Worker itself can call
 * GitHub reliably. Production primarily uses GitHub Actions to avoid shared-IP
 * rate limits on unauthenticated Worker traffic.
 */
export async function syncGitHubRepositoryInventory(
  db: D1Database,
  env: RuntimeEnv,
): Promise<GitHubInventoryResult> {
  const owner = env.GITHUB_OWNER?.trim();
  if (!owner) return { configured: false };

  const repos: GitHubRepoInput[] = [];
  for (let page = 1; page <= 3; page += 1) {
    const response = await fetch(inventoryUrl(env, owner, page), { headers: headers(env) });
    if (!response.ok) {
      throw new Error(`GitHub repository inventory failed with HTTP ${response.status}`);
    }
    const batch = await response.json() as GitHubRepoInput[];
    repos.push(...batch);
    if (batch.length < 100) break;
  }

  return ingestGitHubRepositoryInventory(db, owner, repos);
}
