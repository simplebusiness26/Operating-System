# Orchestration Contract

The three systems have one authority model:

- **Opportunity Radar** observes, investigates and recommends.
- **Operating System** owns state, policy, approval and work-order issuance.
- **AI Factory** plans and executes approved work orders, then reports results.

No integration may bypass the Operating System for execution authority.

## Recommendation envelope

Radar may POST any JSON execution brief to `POST /api/integrations/radar/handoffs`.
The OS stores the original payload unchanged and derives only safe routing metadata.

A recommendation has these OS-owned states:

`received -> approved | rejected -> dispatched -> completed | failed`

Receiving a recommendation never grants execution authority.

## Work order

The OS issues a normalized work order to the Factory:

```json
{
  "id": "work_...",
  "recommendationId": "rec_...",
  "projectId": "project_...",
  "projectName": "ClipMine",
  "repository": "simplebusiness26/ClipMine",
  "objective": "Run an isolated benchmark",
  "constraints": ["do not modify main"],
  "acceptanceCriteria": ["report baseline and candidate results"],
  "authority": {
    "mayCreateBranch": true,
    "mayOpenPullRequest": true,
    "mayMerge": false,
    "mayDeployProduction": false
  },
  "source": {
    "system": "opportunity-radar",
    "externalId": "..."
  }
}
```

Factory execution must be idempotent by work-order ID.

## Execution result

Factory reports to `POST /api/integrations/factory/results`:

```json
{
  "workOrderId": "work_...",
  "status": "completed",
  "summary": "Benchmark completed",
  "branch": "agent/work_...",
  "pullRequestUrl": null,
  "artifacts": [],
  "metrics": {},
  "evidence": [],
  "error": null
}
```

The OS records the result as timeline evidence and, when configured, forwards outcome feedback to Radar.

## Security

- User-facing OS APIs continue to use `OS_ACCESS_TOKEN` when auth is enabled.
- Radar ingress uses `RADAR_INGRESS_TOKEN`.
- Factory result ingress uses `FACTORY_RESULT_TOKEN`.
- OS -> Factory uses `FACTORY_WRITE_TOKEN`.
- OS -> Radar feedback uses `RADAR_FEEDBACK_TOKEN`.
- Tokens are never stored in event metadata or returned by export.

## Initial autonomy policy

The first release is deliberately conservative:

- Radar recommendations require OS approval before dispatch.
- Factory may create isolated branches and run verification.
- Factory may open pull requests when a suitable executor is connected.
- Factory may not merge or deploy production from an automatically generated work order.

These limits can be relaxed later through explicit OS policy, not by changing Radar or Factory independently.
