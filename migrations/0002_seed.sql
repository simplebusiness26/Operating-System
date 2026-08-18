INSERT OR IGNORE INTO projects (id, name, slug, status, summary, goal, created_at, updated_at)
VALUES (
  'project-operating-system',
  'Operating System',
  'operating-system',
  'active',
  'Personal intelligence infrastructure that converts activity into memory, knowledge, content, decisions and opportunities.',
  'Make useful leverage emerge automatically from everyday work.',
  datetime('now'),
  datetime('now')
);
