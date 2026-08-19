PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS recommendations (
  id TEXT PRIMARY KEY,
  source_system TEXT NOT NULL,
  external_id TEXT,
  dedupe_key TEXT NOT NULL UNIQUE,
  project_id TEXT,
  project_name TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  score REAL,
  status TEXT NOT NULL DEFAULT 'received',
  payload_json TEXT NOT NULL,
  decision_note TEXT NOT NULL DEFAULT '',
  work_order_id TEXT,
  received_at TEXT NOT NULL,
  decided_at TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS work_orders (
  id TEXT PRIMARY KEY,
  recommendation_id TEXT NOT NULL UNIQUE,
  project_id TEXT,
  project_name TEXT NOT NULL DEFAULT '',
  repository TEXT NOT NULL DEFAULT '',
  objective TEXT NOT NULL,
  constraints_json TEXT NOT NULL DEFAULT '[]',
  acceptance_criteria_json TEXT NOT NULL DEFAULT '[]',
  authority_json TEXT NOT NULL DEFAULT '{}',
  source_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'approved',
  factory_job_id TEXT,
  dispatch_error TEXT,
  created_at TEXT NOT NULL,
  dispatched_at TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (recommendation_id) REFERENCES recommendations(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS execution_results (
  id TEXT PRIMARY KEY,
  work_order_id TEXT NOT NULL,
  status TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL DEFAULT '{}',
  received_at TEXT NOT NULL,
  FOREIGN KEY (work_order_id) REFERENCES work_orders(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_recommendations_status ON recommendations(status, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_recommendations_project ON recommendations(project_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_work_orders_status ON work_orders(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_execution_results_work_order ON execution_results(work_order_id, received_at DESC);
