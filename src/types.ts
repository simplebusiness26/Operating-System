export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export type EventInput = {
  title: string;
  body?: string;
  type?: string;
  source?: string;
  projectId?: string | null;
  projectName?: string | null;
  occurredAt?: string;
  tags?: string[];
  importance?: number;
  metadata?: Record<string, Json>;
  rawRef?: string | null;
};

export type TimelineEvent = {
  id: string;
  occurred_at: string;
  type: string;
  source: string;
  title: string;
  body: string;
  project_id: string | null;
  tags_json: string;
  metadata_json: string;
  importance: number;
  raw_ref: string | null;
  created_at: string;
};

export type AgentName =
  | 'observer'
  | 'archivist'
  | 'knowledge-extractor'
  | 'strategist'
  | 'ghostwriter'
  | 'producer'
  | 'opportunity-scout'
  | 'chief-of-staff';

export type AgentResult = {
  agent: AgentName;
  created: Array<{ kind: string; id: string; title: string }>;
  notes: string[];
};

export type Brief = {
  date: string;
  headline: string;
  focus: Array<{ title: string; detail: string; priority: number }>;
  recentWins: string[];
  signals: string[];
  contentReady: number;
  openLoops: number;
};
