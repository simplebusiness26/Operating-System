# Factory V2 orchestration

The Operating System is the sole execution authority between intelligence systems and AI Factory.

## Flow

```text
Opportunity Radar ----recommendation----\
                                      Operating System -> approval/policy -> AI Factory
Revenue Hunter -------recommendation----/                              -> verified result -> OS
```

Opportunity Radar and Revenue Hunter remain independent. Their data, scoring and lifecycle state are not merged. The Operating System stores their recommendations in a neutral inbox and records the original payload unchanged.

## Recommendation states

`received -> approved | rejected -> dispatched -> completed | failed`

Receiving a recommendation never grants execution authority.

## Endpoints

### Machine ingress

- `POST /api/integrations/radar/handoffs`
- `POST /api/integrations/revenue-hunter/handoffs`
- `POST /api/integrations/factory/results`
- `GET /api/integrations/health`

### Owner decision surface

- `GET /api/integrations/recommendations`
- `POST /api/integrations/recommendations/:id/approve`
- `POST /api/integrations/recommendations/:id/reject`
- `/recommendations` mobile inbox

## Revenue Hunter

The OS consumes Revenue Hunter through its versioned read-only export `revenue-hunter.opportunities.v1`. The scheduled OS job pulls the configured `REVENUE_HUNTER_EXPORT_URL`, validates the contract and inserts new high-value items as `revenue-hunter` recommendations.

The OS never writes Revenue Hunter rankings/state, and Revenue Hunter never reads or writes Opportunity Radar state.

## Opportunity Radar

Radar keeps its existing delivery-target mechanism. Its delivery target should be the OS Radar ingress endpoint. Radar may recommend and hand off an execution brief; it does not commit resources.

## Factory dispatch

Approved recommendations create an OS execution job assigned to `ai-factory`. The existing OS risk/approval engine still applies. Initial policy is conservative: implementation-class work can require a second execution approval even after the business recommendation itself is approved.

Factory work-order ingress:

`POST https://ai-factory.../api/v2/work-orders`

The OS sends its configured `AI_FACTORY_TOKEN` as a Bearer token. During the first rollout this may be the same secret value already configured as `AI_FACTORY_KEY` in AI Factory.

## Factory results

AI Factory returns a structured result with the original OS execution job ID as `workOrderId`. The OS applies it to the existing execution job, stores the full Factory result and updates the recommendation state.

## Secrets / connection values

No secret values belong in GitHub.

- `RADAR_INGRESS_TOKEN` — optional dedicated Radar -> OS token; `RADAR_SYNC_TOKEN` is accepted as an initial fallback.
- `AI_FACTORY_TOKEN` — OS -> Factory bearer token. Initial rollout can reuse the existing AI Factory key.
- `FACTORY_RESULT_TOKEN` — Factory -> OS result token; `OS_CALLBACK_TOKEN` is accepted by OS as a fallback.
- `REVENUE_HUNTER_INGRESS_TOKEN` — only needed for push-based Revenue Hunter ingress. Scheduled read-only export polling does not require it when the export is public.

## DesignLab V3 and DevCouncil

The OS does not dispatch directly into incomplete specialist systems. AI Factory owns those executor contracts. Until their V3/engineering machine interfaces are ready, Factory records work orders as blocked rather than claiming execution succeeded.
