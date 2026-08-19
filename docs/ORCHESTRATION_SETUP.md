# Orchestration setup

The code path is:

`Opportunity Radar -> Operating System -> AI Factory -> Operating System -> Opportunity Radar`

## 1. Apply the Operating System migration

Run the normal OS D1 migration command after this branch is deployed:

```bash
npm run db:remote
```

This creates `recommendations`, `work_orders` and `execution_results`.

## 2. Create four shared secret pairs

Use long random values. The same value must appear at both ends of each connection.

### Radar -> OS

- OS: `RADAR_INGRESS_TOKEN`
- Radar execution delivery bearer token: same value
- Radar execution URL: `https://<os-host>/api/integrations/radar/handoffs`

### OS -> Factory

- OS: `FACTORY_WRITE_TOKEN`
- Factory: `FACTORY_WRITE_TOKEN` (or reuse its existing `AI_FACTORY_KEY`)
- OS: `FACTORY_URL=https://<factory-host>`

### Factory -> OS

- OS: `FACTORY_RESULT_TOKEN`
- Factory: `OS_RESULT_TOKEN` = same value
- Factory: `OS_RESULT_URL=https://<os-host>/api/integrations/factory/results`

### OS -> Radar feedback

- Radar: `RADAR_FEEDBACK_TOKEN`
- OS: `RADAR_FEEDBACK_TOKEN` = same value
- OS: `RADAR_FEEDBACK_URL=https://<radar-host>/api/v1/execution/feedback`

## 3. Verify each service

OS:

```text
GET /api/orchestration/status
```

Factory:

```text
GET /api/orchestration/status
```

Both status endpoints show whether their outbound/inbound connections are configured.

## 4. First end-to-end acceptance test

1. Have Radar create or hand off one low-risk recommendation.
2. Confirm it appears in `GET /api/recommendations` with `status=received`.
3. Approve it with `POST /api/recommendations/<id>/approve`.
4. Confirm the OS reports `dispatch.delivered=true`.
5. Confirm the Factory shows it in `GET /api/work-orders` as `queued` with a deterministic capability plan.
6. Start it through `POST /api/work-orders/<id>/start` when an executor is connected.
7. Report a result through `POST /api/work-orders/<id>/result`.
8. Confirm the OS timeline records the result and Radar receives feedback.

## Current execution boundary

The bridge and work queue are real. The Factory currently plans and queues work but still needs an executor adapter to perform arbitrary coding jobs unattended. That adapter can later route engineering jobs to DevCouncil/Codex-style execution, design jobs to DesignLabV2, and release jobs to the release tooling.

Until an executor is connected, work orders stop safely at `queued` rather than pretending work has been done.
