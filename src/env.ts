type GeneratedEnv = Env;

/**
 * Wrangler intentionally generates literal string types for values currently in
 * wrangler.jsonc. Runtime secrets and deploy-time configuration are broader than
 * those literals, so widen the fields the application is designed to change.
 */
export type RuntimeEnv = Omit<
  GeneratedEnv,
  'AI_MODE' | 'AI_MODEL' | 'REQUIRE_AUTH' | 'APP_NAME' | 'RADAR_URL' | 'GITHUB_OWNER' | 'GITHUB_ACTIVITY_SKIP_REPOS'
> & {
  AI_MODE: 'deterministic' | 'workers-ai';
  AI_MODEL: string;
  REQUIRE_AUTH: 'true' | 'false';
  APP_NAME: string;
  OS_ACCESS_TOKEN?: string;
  GITHUB_WEBHOOK_SECRET?: string;
  /** GitHub account whose repositories form the owner's automatic project inventory. */
  GITHUB_OWNER?: string;
  /** Optional GitHub token. Public repositories work without it; a token can add private repos later. */
  GITHUB_TOKEN?: string;
  /** Comma-separated repositories excluded from polling because a webhook already captures them instantly. */
  GITHUB_ACTIVITY_SKIP_REPOS?: string;
  /** Public base URL of the owner's Opportunity Radar deployment. */
  RADAR_URL?: string;
  /** Dedicated machine token shared only with Radar's OS sync endpoint. */
  RADAR_SYNC_TOKEN?: string;
};
