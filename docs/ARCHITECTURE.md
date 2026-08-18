# Architecture

## Product boundary

Operating System is personal intelligence infrastructure. It captures evidence about work, stores it durably, derives useful artifacts, and presents an operating picture. It is deliberately not a single chatbot with a large prompt.

## Runtime

- **Cloudflare Worker**: API, webhook ingress, scheduled brief generation and optional Workers AI calls.
- **Workers Static Assets**: the installable mobile-first web application.
- **D1**: structured source of truth for events, projects, memories, decisions, open loops, insights, content, documentary beats and agent audit runs.
- **Workers AI (optional)**: higher-quality natural-language enrichment. The deterministic pipeline remains functional when AI is disabled.
- **GitHub Actions**: validation and opt-in deployment after the Cloudflare credentials are configured.

## Core data flow

```text
human capture / GitHub webhook / future integration
                    |
                    v
                 EVENT
                    |
        +-----------+-----------+
        |                       |
        v                       v
  raw evidence             project context
        |
        v
  intelligence pipeline
        |
        +--> Observer ---------- signal score / classification
        +--> Archivist --------- durable memory
        +--> Knowledge Extractor lessons / proof
        +--> Strategist -------- decisions / open loops
        +--> Ghostwriter ------- content drafts
        +--> Producer ---------- documentary beats
        +--> Opportunity Scout - leverage / product signals
        +--> Chief of Staff ---- operating picture / brief
```

Every derivative artifact retains source IDs. The principle is **evidence first, generation second**.

## Why multiple agents

The agents are jobs, not personalities. A narrow specialist can be tested and replaced independently. The deterministic V1 proves orchestration and data contracts without requiring paid inference for every event. Later, each job can selectively invoke a model only when the expected value justifies the cost.

## Security model

The app can run open in local development. Production should set `REQUIRE_AUTH=true` and store `OS_ACCESS_TOKEN` with `wrangler secret put`. GitHub ingress requires `GITHUB_WEBHOOK_SECRET` and validates `X-Hub-Signature-256` before accepting payloads. Secrets are never stored in D1 or committed to source.

## Scaling path

1. Current synchronous pipeline for immediate, inspectable behavior.
2. Queue heavy enrichment after capture while returning the event immediately.
3. Add Vectorize/embeddings only when the event corpus is large enough that lexical search is inadequate.
4. Add R2 for attachments, transcripts, screenshots, audio and video evidence.
5. Add Workflows for long-running documentary/report generation.
6. Add per-user tenancy and encrypted integration credentials if the system becomes a product for other people.
