# Connections checklist

The repository is deliberately usable before these are connected. These steps unlock the automated version.

## Cloudflare

1. Connect the GitHub repository to Cloudflare or run Wrangler from an authenticated environment.
2. Deploy once; Wrangler can provision the declared D1 binding automatically.
3. Apply migrations: `npm run db:remote`.
4. For private access, change `REQUIRE_AUTH` to `true` and add `OS_ACCESS_TOKEN` as a Worker secret.
5. Optional: set `AI_MODE` to `workers-ai` to allow selected prompts to use the Workers AI binding.

## Opportunity Radar bridge

The OS can now act as Radar's internal source of truth instead of making the owner re-enter projects and demonstrated capabilities by hand.

`RADAR_URL` is committed as the public Radar origin. The credential is deliberately separate from every other token:

1. Generate one long random value (32+ characters).
2. Save it in Opportunity Radar as `RADAR_OS_SYNC_TOKEN`.
3. Save the exact same value in this Worker as secret `RADAR_SYNC_TOKEN`.
4. Deploy both sides.
5. Trigger `POST /api/radar/sync` once, or wait for a GitHub/manual event. New work also causes a background sync automatically.

What syncs automatically:

- OS projects → Radar reusable assets.
- Project goals → Radar goals.
- Capabilities supported by real code/milestone records → Radar capabilities with evidence references and conservative confidence.
- Optional OS settings `radar.resources` and `radar.goals` → Radar resources/goals.

What does **not** happen:

- OS records never become external market evidence, so they cannot inflate Radar confidence or independent-source counts.
- The bridge does not invent production maturity. Automatically inferred capabilities are capped at `working` until stronger evidence or owner review promotes them.
- Missing resources remain unknown rather than being guessed as zero.

Diagnostics:

- `GET /api/health` includes `radarSyncConfigured`.
- `GET /api/radar/snapshot` shows exactly what the OS would send, without sending it.
- `POST /api/radar/sync` performs an immediate sync and returns Radar's response.

## GitHub auto-capture

In any repository you want observed:

- Webhook URL: `https://YOUR-OS-DOMAIN/webhooks/github`
- Content type: `application/json`
- Secret: create a strong value and save the same value as Worker secret `GITHUB_WEBHOOK_SECRET`.
- Events: Pushes, Pull requests, Issues.

Those events become evidence, then flow through the same intelligence pipeline as manual captures. When the Radar bridge is configured, the updated internal picture is pushed to Radar after the webhook batch is processed.

## GitHub Actions deployment

Repository settings → Actions secrets/variables:

- Secret `CLOUDFLARE_API_TOKEN`
- Secret `CLOUDFLARE_ACCOUNT_ID`
- Variable `CLOUDFLARE_DEPLOY_ENABLED=true`

Until that variable is set, the deploy workflow intentionally does nothing.

## Later connectors

Recommended order:

1. GitHub — highest signal for builds.
2. Calendar — commitments and time context.
3. Gmail — decisions, requests and follow-ups (user-selected scope only).
4. Drive/docs — specifications and durable source documents.
5. Voice capture — fastest mobile input.
6. R2 uploads — screenshots, images, audio, video and transcripts.
7. Vector search — only after the corpus is large enough to need semantic retrieval.
