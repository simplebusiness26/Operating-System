type GeneratedEnv = Env;

/** Runtime configuration widened beyond literal wrangler-generated values. */
export type RuntimeEnv = Omit<
  GeneratedEnv,
  | 'AI_MODE'
  | 'AI_MODEL'
  | 'REQUIRE_AUTH'
  | 'APP_NAME'
  | 'RADAR_URL'
  | 'GITHUB_OWNER'
  | 'GITHUB_ACTIVITY_SKIP_REPOS'
  | 'CONTROL_PLANE_MODE'
  | 'AUTO_EXECUTION_LEVEL'
> & {
  AI_MODE: 'deterministic' | 'workers-ai';
  AI_MODEL: string;
  REQUIRE_AUTH: 'true' | 'false';
  APP_NAME: string;
  CONTROL_PLANE_MODE?: 'observe' | 'active';
  AUTO_EXECUTION_LEVEL?: 'none' | 'low' | 'medium' | 'high';
  OS_ACCESS_TOKEN?: string;
  OS_CALLBACK_URL?: string;
  OS_CALLBACK_TOKEN?: string;
  GITHUB_WEBHOOK_SECRET?: string;
  GITHUB_OWNER?: string;
  GITHUB_TOKEN?: string;
  GITHUB_ACTIVITY_SKIP_REPOS?: string;
  RADAR_URL?: string;
  RADAR_SYNC_TOKEN?: string;
  RADAR_DISPATCH_URL?: string;
  AI_FACTORY_DISPATCH_URL?: string;
  AI_FACTORY_HEALTH_URL?: string;
  AI_FACTORY_TOKEN?: string;
  DESIGNLAB_DISPATCH_URL?: string;
  DESIGNLAB_HEALTH_URL?: string;
  DESIGNLAB_TOKEN?: string;
  GHOSTWRITER_DISPATCH_URL?: string;
  GHOSTWRITER_HEALTH_URL?: string;
  GHOSTWRITER_TOKEN?: string;
  REVENUE_HUNTER_DISPATCH_URL?: string;
  REVENUE_HUNTER_HEALTH_URL?: string;
  REVENUE_HUNTER_TOKEN?: string;
};
