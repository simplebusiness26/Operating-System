PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS recommendations (
  id TEXT PRIMARY KEY,
  source_system TEXT NOT NULL,
  external_id TEXT NOT NULL,
  title TEXT NOT NULL,
  objective TEXT NOT NULL DEFAULT '',
  project_name TEXT,
  repository TEXT,
  confidence REAL NOT NULL DEFAULT 0.5,
  priority INTEGER NOT NULL DEFAULT 60,
  status TEXT NOT NULL DEFAULT 'received',
  original_json TEXT NOT NULL,
  derived_json TEXT NOT NULL DEFAULT '{}',
  execution_job_id TEXT,
  rejection_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  approved_at TEXT,
  dispatched_at TEXT,
  completed_at TEXT,
  UNIQUE(source_system, external_id)
);

CREATE TABLE IF NOT EXISTS factory_results (
  id TEXT PRIMARY KEY,
  work_order_id TEXT NOT NULL,
  status TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL,
  received_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_recommendations_status ON recommendations(status, priority DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_recommendations_source ON recommendations(source_system, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_factory_results_work ON factory_results(work_order_id, received_at DESC);
