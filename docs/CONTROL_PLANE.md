# Operating System Control Plane

The Operating System has two layers:

1. **Evidence + intelligence** — timeline, memory, decisions, open loops, knowledge, content, story and opportunities.
2. **Control plane** — attention, execution, approval gates, experiments, health checks, notifications and specialist dispatch.

## Operating loop

```text
INPUTS
GitHub / manual / connector imports / Opportunity Radar
        |
        v
EVENT + EVIDENCE PIPELINE
        |
        +--> Memory graph
        +--> Decisions + outcome reviews
        +--> Open loops + attention scoring
        +--> Content + documentary beats
        +--> Opportunity signals + cheap experiments
        |
        v
COMMAND / CHIEF OF STAFF
        |
        v
EXECUTION JOB
        |
  risk classification
     /         \
 safe          risky
  |              |
auto-run     Needs You approval
  |              |
  +-------> specialist dispatch
               |
      AI Factory / DesignLab / GhostWriter /
      Opportunity Radar / Revenue Hunter
               |
         callback / evidence
               |
               v
        COMPLETE / BLOCKED
```

## Safety and authority

The default `AUTO_EXECUTION_LEVEL` is `low`.

High/critical actions are always approval-gated even if the auto-execution setting is later raised. The built-in risk gate treats deploy, publish, send, merge, production writes, deletion, spending and credential changes as human-authority actions.

Approval resolution, connector imports, decision outcome scoring, health refresh and automation-policy changes require `OS_ACCESS_TOKEN` even while the dashboard remains publicly reachable.

External systems report execution status through `/api/execution/callback`, protected by a separate `OS_CALLBACK_TOKEN`.

## Execution connectors

Optional runtime variables:

- `AI_FACTORY_DISPATCH_URL` / `AI_FACTORY_TOKEN`
- `DESIGNLAB_DISPATCH_URL` / `DESIGNLAB_TOKEN`
- `GHOSTWRITER_DISPATCH_URL` / `GHOSTWRITER_TOKEN`
- `REVENUE_HUNTER_DISPATCH_URL` / `REVENUE_HUNTER_TOKEN`
- `RADAR_DISPATCH_URL` / `RADAR_SYNC_TOKEN`

Dispatch URLs are exact POST endpoints. The OS sends a versioned job envelope containing objective, project, priority, risk and plan, plus `OS_CALLBACK_URL` when configured.

If a specialist endpoint is absent, the job moves to **blocked / waiting** with a connection-required notification. It is preserved and can be retried after the connector is added.

## Connector-ready evidence imports

`POST /api/connectors/import` accepts structured batches from Calendar, Gmail, Drive/docs, voice capture, files, Slack and manual bridge adapters. Imports are deduplicated by connector + external ID and pass through the same intelligence pipeline as GitHub/manual evidence. The endpoint requires `OS_ACCESS_TOKEN`.

## Project intelligence

Each project is calculated from evidence rather than manually maintained status text. The project card includes goal/summary, latest activity, event count, open loops, recent problems/wins, active jobs, pending approvals, next action, health score, confidence and attention lane.

## Attention engine

- **NOW** — approvals, due decision reviews and critical/high-priority work.
- **NEXT** — useful queued work and proposed experiments.
- **WAITING** — running or blocked work that should not steal active attention.
- **IGNORE** — low-value/stale work that should not clutter the operating picture.

## Experiment engine

High-scoring opportunity signals automatically create a proposed falsification experiment. The default test seeks behavioural evidence before a full build: payment, booked call, trial use, data access or repeated explicit demand.

## Decision learning

Decisions older than seven days receive a review record. Once reviewed, the outcome, score and lesson are fed back into the event pipeline as a learning event so the OS can accumulate evidence about which choices actually worked.

## Memory graph

Recent events maintain project → technology and project → system relationships. Repeated evidence strengthens existing links rather than generating duplicates.

## Self-monitoring

Hourly maintenance records health for D1, GitHub ingestion freshness and configured specialist systems. Degradation creates a deduplicated notification; recovery clears the unread health warning.

## Browser notifications

The PWA can request device notification permission. While the app is active, unread OS notifications can surface through the service worker. Closed-app push requires a future push-subscription/VAPID transport.

## Remaining external-only setup

The control-plane contracts are implemented. These cannot be truthfully activated without owner credentials or receiving endpoints:

1. Set `OS_ACCESS_TOKEN` and `OS_CALLBACK_TOKEN` as Cloudflare Worker secrets.
2. Then set `REQUIRE_AUTH=true` and deploy to lock the dashboard.
3. Add exact specialist dispatch URLs/tokens for AI Factory, DesignLab, GhostWriter and Revenue Hunter when those systems expose receivers.
4. Connect Gmail/Calendar/Drive credentials before sending private data.

Until those are connected, the OS preserves work as blocked/bridge-ready rather than pretending it executed externally.
