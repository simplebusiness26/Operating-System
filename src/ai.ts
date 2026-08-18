import type { RuntimeEnv } from './env';
export async function enrichTextWithWorkersAI(
  env: RuntimeEnv,
  system: string,
  prompt: string
): Promise<string | null> {
  if (env.AI_MODE !== 'workers-ai') return null;
  const response = await env.AI.run('@cf/openai/gpt-oss-20b', {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: prompt }
    ],
    max_tokens: 700,
    temperature: 0.4
  });
  if (typeof response === 'string') return response;
  if (response && typeof response === 'object' && 'response' in response && typeof response.response === 'string') {
    return response.response;
  }
  return null;
}
