import type { EventInput, Json } from './types';
import { normalizeText } from './utils';

function toHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function verifyGitHubSignature(rawBody: string, signature: string | null, secret: string | undefined): Promise<boolean> {
  if (!secret) return false;
  if (!signature?.startsWith('sha256=')) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
  const expected = `sha256=${toHex(digest)}`;
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

export function githubPayloadToEvents(eventName: string, payload: Record<string, Json>): EventInput[] {
  const repository = isObject(payload.repository) ? normalizeText(payload.repository.name) : '';
  const projectName = repository || 'GitHub';
  const events: EventInput[] = [];

  if (eventName === 'push') {
    const commits = Array.isArray(payload.commits) ? payload.commits.filter(isObject) : [];
    for (const commit of commits.slice(0, 20)) {
      const message = normalizeText(commit.message);
      const sha = normalizeText(commit.id).slice(0, 8);
      const url = normalizeText(commit.url);
      events.push({
        title: message.split('\n')[0] || `Commit ${sha}`,
        body: `GitHub commit ${sha}${message ? `: ${message}` : ''}`,
        type: 'code',
        source: 'github',
        projectName,
        importance: 55,
        metadata: { sha, url },
        rawRef: url || null,
        tags: ['github', 'code']
      });
    }
  }

  if (eventName === 'pull_request' && isObject(payload.pull_request)) {
    const pr = payload.pull_request;
    const action = normalizeText(payload.action);
    const title = normalizeText(pr.title);
    const url = normalizeText(pr.html_url);
    events.push({
      title: `PR ${action}: ${title}`,
      body: normalizeText(pr.body),
      type: action === 'closed' && pr.merged === true ? 'milestone' : 'code',
      source: 'github',
      projectName,
      importance: action === 'closed' && pr.merged === true ? 75 : 60,
      metadata: { number: typeof pr.number === 'number' ? pr.number : 0, action, url },
      rawRef: url || null,
      tags: ['github', 'code']
    });
  }

  if (eventName === 'issues' && isObject(payload.issue)) {
    const issue = payload.issue;
    const action = normalizeText(payload.action);
    const title = normalizeText(issue.title);
    const body = normalizeText(issue.body);
    const url = normalizeText(issue.html_url);
    events.push({
      title: `Issue ${action}: ${title}`,
      body,
      type: action === 'closed' ? 'milestone' : 'problem',
      source: 'github',
      projectName,
      importance: action === 'opened' ? 65 : 55,
      metadata: { action, url },
      rawRef: url || null,
      tags: ['github', 'bug']
    });
  }

  return events;
}

function isObject(value: Json | undefined): value is Record<string, Json> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
