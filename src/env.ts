export type RuntimeEnv = Env & {
  OS_ACCESS_TOKEN?: string;
  GITHUB_WEBHOOK_SECRET?: string;
  /** Public base URL of the owner's Opportunity Radar deployment. */
  RADAR_URL?: string;
  /** Dedicated machine token shared only with Radar's OS sync endpoint. */
  RADAR_SYNC_TOKEN?: string;
};
