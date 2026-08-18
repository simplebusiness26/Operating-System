# Operating System

**Personal intelligence infrastructure that turns everyday work into memory, knowledge, direction, content, story and opportunity.**

This is not a generic chatbot wrapper. It is an evidence-first operating layer built around a living timeline and eight narrow specialist agents.

## What is already built

- **Mission Control** — daily Chief of Staff brief, signals, metrics, open loops and content queue.
- **Living Timeline** — chronological source of truth for work, decisions, problems, wins and ideas.
- **Project Contexts** — durable project containers instead of repeatedly re-explaining context.
- **Eight-agent pipeline** — Observer, Archivist, Knowledge Extractor, Strategist, Ghostwriter, Producer, Opportunity Scout and Chief of Staff.
- **Memory + provenance** — derived artifacts retain their source event IDs.
- **Decision ledger** — decisions are captured separately from generic notes.
- **Open-loop engine** — problems and ideas become explicit follow-up items.
- **Knowledge + opportunity radar** — high-value events become lessons, proof and opportunity signals.
- **Content Studio** — work-derived X drafts with workflow state (draft → ready → published).
- **Documentary engine** — important events become conflict/turning-point/payoff beats and a 30-day episode outline.
- **Ask Your History** — evidence-grounded search with deterministic answers by default and optional Workers AI enrichment.
- **Weekly reflection API** — wins, friction, decisions, unresolved loops and strongest signals.
- **Portable export** — JSON export of the user's structured data. No artificial lock-in.
- **GitHub ingestion** — signed, deduplicated webhooks for pushes, pull requests and issues.
- **Mobile-first PWA** — installable web shell designed to work properly from a phone.
- **Cloudflare-native deployment** — Worker + Static Assets + D1, with optional Workers AI.
- **CI + opt-in CD** — GitHub Actions verifies every main push; deployment stays disabled until Cloudflare credentials are added.

## Architecture in one picture

```text
CAPTURE
  manual / GitHub / future connectors
          |
          v
      [ EVENT LOG ]  <---- immutable-ish evidence layer
          |
          v
   intelligence pipeline
          |
  +-------+---------+---------+---------+
  |       |         |         |         |
Memory  Knowledge  Strategy  Content  Story/Opportunity
  |       |         |         |         |
  +-----------------+-------------------+
                    |
                    v
             [ CHIEF OF STAFF ]
                    |
             Mission Control / Ask
```

## Stack

- TypeScript
- Cloudflare Workers
- Workers Static Assets
- Cloudflare D1 (SQLite)
- Optional Cloudflare Workers AI
- Vanilla browser JS/CSS for a low-dependency, fast phone-first client

Cloudflare currently recommends Workers Static Assets for new full-stack Worker projects, recommends `wrangler.jsonc`, supports D1/AI bindings and automatic resource provisioning, and recommends generating Worker binding types using `wrangler types`. See the Cloudflare docs linked from `docs/ARCHITECTURE.md` for the rationale.

## Local development

```bash
npm install
npm run types
npm run db:local
npm run dev
```

Wrangler will serve the app and persist the local D1 database between runs.

## First production deployment

```bash
npm install
npm run types
npm run db:remote
npm run deploy
```

For a private deployment:

```bash
npx wrangler secret put OS_ACCESS_TOKEN
npx wrangler secret put GITHUB_WEBHOOK_SECRET
```

Then set `REQUIRE_AUTH` to `true` in `wrangler.jsonc` before deploying.

## AI modes

The default is:

```json
"AI_MODE": "deterministic"
```

That is deliberate. The core product works without paying for an LLM call on every event.

To enable Cloudflare Workers AI for the **Ask Your History** natural-language synthesis layer, change it to:

```json
"AI_MODE": "workers-ai"
```

The deterministic agents remain the source of structured memory and provenance either way.

## GitHub auto-capture

After deployment, add this webhook to repositories you want observed:

```text
https://YOUR-OS-DOMAIN/webhooks/github
```

Use JSON payloads, set a webhook secret, and subscribe to Pushes, Pull requests and Issues. See [`docs/CONNECT.md`](docs/CONNECT.md).

## Product documents

- [`docs/PRODUCT_VISION.md`](docs/PRODUCT_VISION.md) — complete product vision and future modules.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — runtime, security, data flow and scaling.
- [`docs/CONNECT.md`](docs/CONNECT.md) — exactly what still needs connecting.
- [`docs/API.md`](docs/API.md) — current API contract.

## Status

**Foundation: working implementation.** The remaining blockers to a live personal deployment are external account connections/credentials, D1 migration execution on the target Cloudflare account, and optional integration wiring.

The next architectural upgrades after real usage produces enough data are R2 attachments, queue-backed heavy enrichment, semantic/vector retrieval, deeper entity graph extraction, Calendar/Gmail/Drive connectors, voice capture, and multi-tenant identity if this becomes a product for other users.
