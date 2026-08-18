export type RuntimeEnv = Env & {
  OS_ACCESS_TOKEN?: string;
  GITHUB_WEBHOOK_SECRET?: string;
};
