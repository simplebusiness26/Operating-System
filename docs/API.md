# API surface

All `/api/*` routes except `/api/health` require the access token when `REQUIRE_AUTH=true`.

| Method | Route | Purpose |
|---|---|---|
| GET | `/api/health` | runtime / AI mode health |
| GET | `/api/dashboard` | Mission Control aggregate |
| GET | `/api/timeline` | chronological evidence |
| POST | `/api/events` | capture event + run intelligence pipeline |
| GET/POST | `/api/projects` | project contexts |
| GET | `/api/search?q=` | lexical search across memories and outputs |
| POST | `/api/ask` | evidence-grounded question answering |
| POST | `/api/brief/generate` | regenerate Chief of Staff brief |
| GET | `/api/open-loops` | outstanding work |
| PATCH | `/api/open-loops/:id` | close a loop |
| GET | `/api/content` | content studio queue |
| PATCH | `/api/content/:id` | move content through workflow states |
| GET | `/api/agents` | agent audit trail |
| GET | `/api/documentary?days=30` | documentary outline from preserved beats |
| GET | `/api/reflection?days=7` | weekly/monthly reflection packet |
| GET | `/api/export` | portable JSON export of user-owned data |
| POST | `/webhooks/github` | signed GitHub webhook ingress |
