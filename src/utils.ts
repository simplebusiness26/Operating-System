export const nowIso = () => new Date().toISOString();
export const uid = (prefix: string) => `${prefix}_${crypto.randomUUID()}`;

export function clamp(value: number, min = 0, max = 100): number {
  return Math.min(max, Math.max(min, value));
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 64) || 'untitled';
}

export function safeJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function json(value: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', 'no-store');
  return new Response(JSON.stringify(value), { ...init, headers });
}

export function parseTags(text: string): string[] {
  const dictionary = [
    'agent', 'ai', 'design', 'database', 'deploy', 'github', 'content', 'video',
    'product', 'customer', 'marketing', 'bug', 'test', 'launch', 'idea', 'decision',
    'research', 'automation', 'mobile', 'cloudflare', 'privacy', 'memory', 'strategy'
  ];
  const lower = text.toLowerCase();
  return dictionary.filter((word) => lower.includes(word)).slice(0, 8);
}

export function inferEventType(title: string, body = ''): string {
  const text = `${title} ${body}`.toLowerCase();
  if (/\b(decided|decision|choose|chose|locked in|we will|going with)\b/.test(text)) return 'decision';
  if (/\b(fixed|solved|working|shipped|deployed|completed|done)\b/.test(text)) return 'milestone';
  if (/\b(error|bug|broken|failed|crash|problem|issue)\b/.test(text)) return 'problem';
  if (/\b(idea|could build|what if|maybe|opportunity)\b/.test(text)) return 'idea';
  if (/\b(learned|realised|realized|lesson|discovered)\b/.test(text)) return 'learning';
  if (/\b(commit|pull request|merge|branch)\b/.test(text)) return 'code';
  return 'note';
}

export function inferImportance(title: string, body = ''): number {
  const text = `${title} ${body}`.toLowerCase();
  let score = 45;
  if (/\b(launch|shipped|deployed|milestone|critical|major)\b/.test(text)) score += 30;
  if (/\b(decision|locked in|architecture|strategy)\b/.test(text)) score += 20;
  if (/\b(bug|failed|problem|blocked)\b/.test(text)) score += 10;
  if (body.length > 300) score += 5;
  return clamp(score);
}

export function firstSentence(text: string, max = 180): string {
  const cleaned = text.trim().replace(/\s+/g, ' ');
  const sentence = cleaned.split(/(?<=[.!?])\s/)[0] || cleaned;
  return sentence.length > max ? `${sentence.slice(0, max - 1)}…` : sentence;
}

export async function constantTimeSecretEquals(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(a)),
    crypto.subtle.digest('SHA-256', encoder.encode(b))
  ]);
  const aa = new Uint8Array(ha);
  const bb = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < aa.length; i += 1) diff |= aa[i]! ^ bb[i]!;
  return diff === 0;
}

export function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
