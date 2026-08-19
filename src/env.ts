export type RuntimeEnv = Omit<Env, 'AI_MODE' | 'AI_MODEL' | 'REQUIRE_AUTH' | 'APP_NAME'> & {
  AI_MODE: string;
  AI_MODEL: string;
  REQUIRE_AUTH: string;
  APP_NAME: string;
  OS_ACCESS_TOKEN?: string;
  GITHUB_WEBHOOK_SECRET?: string;
};
