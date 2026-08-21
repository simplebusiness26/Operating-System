PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS execution_jobs (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  objective TEXT NOT NULL,
  project_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  lane TEXT NOT NULL DEFAULT 'next',
  priority INTEGER NOT NULL DEFAULT 60,
  confidence REAL NOT NULL DEFAULT 0.7,
  assigned_system TEXT NOT NULL DEFAULT 'operating-system',
  action_type TEXT NOT NULL DEFAULT 'plan',
  risk_level TEXT NOT NULL DEFAULT 'low',
  source_ref TEXT,
  plan_json TEXT NOT NULL DEFAULT '[]',
  result_json TEXT NOT NULL DEFAULT '{}',
  current_step INTEGER NOT NULL DEFAULT 0,
  blocked_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS execution_steps (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  step_index INTEGER NOT NULL,
  title TEXT NOT NULL,
  system TEXT NOT NULL DEFAULT 'operating-system',
  status TEXT NOT NULL DEFAULT 'pending',
  input_json TEXT NOT NULL DEFAULT '{}',
  output_json TEXT NOT NULL DEFAULT '{}',
  started_at TEXT,
  completed_at TEXT,
  FOREIGN KEY (job_id) REFERENCES execution_jobs(id) ON DELETE CASCADE,
  UNIQUE(job_id, step_index)
);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  project_id TEXT,
  job_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  risk_level TEXT NOT NULL DEFAULT 'high',
  action_type TEXT NOT NULL DEFAULT 'external-write',
  action_payload_json TEXT NOT NULL DEFAULT '{}',
  source_ref TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  resolution_note TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL,
  FOREIGN KEY (job_id) REFERENCES execution_jobs(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS experiments (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  project_id TEXT,
  hypothesis TEXT NOT NULL,
  test TEXT NOT NULL,
  success_criteria TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed',
  priority INTEGER NOT NULL DEFAULT 60,
  confidence REAL NOT NULL DEFAULT 0.5,
  source_ref TEXT,
  result TEXT NOT NULL DEFAULT '',
  learning TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS decision_reviews (
  id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL UNIQUE,
  expected_outcome TEXT NOT NULL DEFAULT '',
  review_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  outcome TEXT NOT NULL DEFAULT '',
  score INTEGER,
  lesson TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (decision_id) REFERENCES decisions(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info',
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  project_id TEXT,
  action_ref TEXT,
  dedupe_key TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'unread',
  created_at TEXT NOT NULL,
  read_at TEXT,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS system_checks (
  id TEXT PRIMARY KEY,
  subsystem TEXT NOT NULL,
  status TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  recovery_action TEXT NOT NULL DEFAULT '',
  checked_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS connector_receipts (
  id TEXT PRIMARY KEY,
  connector TEXT NOT NULL,
  external_id TEXT NOT NULL,
  event_id TEXT,
  received_at TEXT NOT NULL,
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE SET NULL,
  UNIQUE(connector, external_id)
);
CREATE TABLE IF NOT EXISTS automation_rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  trigger_type TEXT NOT NULL,
  action_type TEXT NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_execution_status ON execution_jobs(status, priority DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_execution_project ON execution_jobs(project_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_experiments_status ON experiments(status, priority DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_status ON notifications(status, severity, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_system_checks_subsystem ON system_checks(subsystem, checked_at DESC);
INSERT OR IGNORE INTO automation_rules (id,name,description,enabled,trigger_type,action_type,config_json,created_at,updated_at) VALUES
('rule_high_risk_approval','High-risk approval gate','Deploy, publish, send, merge, spend, delete and credential-changing actions require human approval.',1,'execution-job','approval-gate','{"minimumRisk":"high"}',datetime('now'),datetime('now')),
('rule_opportunity_experiment','Opportunity experiment proposal','Strong opportunity signals create a cheap falsification experiment before major investment.',1,'opportunity-insight','propose-experiment','{"minimumScore":70}',datetime('now'),datetime('now')),
('rule_decision_review','Decision outcome review','Older decisions return for outcome scoring so the OS learns which choices worked.',1,'decision-age','decision-review','{"afterDays":7}',datetime('now'),datetime('now')),
('rule_system_health','System health watch','Connected systems are checked and degraded integrations create one actionable alert.',1,'scheduled','health-check','{"interval":"hourly"}',datetime('now'),datetime('now'));
