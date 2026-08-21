import type { RuntimeEnv } from './env';
import type { Json } from './types';
import { nowIso, uid } from './utils';
import { ensureOrchestrationSchema } from './orchestration';

type RevenueExportItem = {
  externalRef: string;
  title: string;
  kind: 'near_term_revenue';
  score: number;
  problem?: string | null;
  proposedSolution?: string | null;
  indicativePrice?: number | null;
};

type RevenueExport = {
  contract: 'revenue-hunter.opportunities.v1';
  generatedAt: string;
  items: RevenueExportItem[];
};

function clean(value: unknown, max = 4000): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

export async function syncRevenueHunterExport(db: D1Database, env: RuntimeEnv) {
  await ensureOrchestrationSchema(db);
  if (!env.REVENUE_HUNTER_EXPORT_URL) return { configured:false, inserted:0, seen:0 };
  const headers = new Headers({ accept:'application/json', 'user-agent':'Operating-System-Revenue-Hunter-Bridge/1.0' });
  if (env.REVENUE_HUNTER_TOKEN) headers.set('authorization',`Bearer ${env.REVENUE_HUNTER_TOKEN}`);
  const response = await fetch(env.REVENUE_HUNTER_EXPORT_URL,{headers});
  if (!response.ok) throw new Error(`Revenue Hunter export returned ${response.status}`);
  const payload = await response.json() as RevenueExport;
  if (payload.contract !== 'revenue-hunter.opportunities.v1' || !Array.isArray(payload.items)) {
    throw new Error('Revenue Hunter export contract mismatch');
  }

  let inserted = 0;
  const now = nowIso();
  for (const item of payload.items.slice(0,100)) {
    const externalId = clean(item.externalRef,300);
    const title = clean(item.title,300);
    if (!externalId || !title) continue;
    const score = Math.max(0,Math.min(100,Number(item.score)||0));
    const problem = clean(item.problem,2500);
    const solution = clean(item.proposedSolution,3000);
    const objective = solution
      ? `Prepare the lowest-risk fulfilment route for ${title}: ${solution}`
      : `Evaluate the near-term revenue opportunity for ${title} and prepare the smallest sellable fulfilment route.`;
    const derived = {
      externalId,
      title,
      objective,
      projectName:null,
      repository:null,
      confidence:score/100,
      priority:Math.max(60,Math.round(score)),
      acceptance:[],
      constraints:['Revenue Hunter remains an independent source; do not alter its ranking or state.'],
      commercial:{problem:problem||null,proposedSolution:solution||null,indicativePrice:Number.isFinite(Number(item.indicativePrice))?Number(item.indicativePrice):null}
    };
    const result = await db.prepare(`INSERT OR IGNORE INTO recommendations
      (id,source_system,external_id,title,objective,project_name,repository,confidence,priority,status,original_json,derived_json,created_at,updated_at)
      VALUES (?,?,?,?,?,NULL,NULL,?,?,'received',?,?,?,?)`)
      .bind(uid('rec'),'revenue-hunter',externalId,title,objective,derived.confidence,derived.priority,JSON.stringify(item as unknown as Json),JSON.stringify(derived),now,now).run();
    inserted += Number(result.meta?.changes || 0);
  }
  return { configured:true, contract:payload.contract, generatedAt:payload.generatedAt, seen:payload.items.length, inserted };
}
