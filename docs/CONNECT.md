# Connections checklist

The repository is deliberately usable before these are connected. These steps unlock the automated version.

## Cloudflare

1. Connect the GitHub repository to Cloudflare or run Wrangler from an authenticated environment.
2. Deploy once; Wrangler can provision the declared D1 binding automatically.
3. Apply migrations: `npm run db:remote`.
4. For private access, change `REQUIRE_AUTH` to `true` and add `OS_ACCESS_TOKEN` as a Worker secret.
5. Optional: set `AI_MODE` to `workers-ai` to allow selected prompts to use the Workers AI binding.

## GitHub auto-capture

In any repository you want observed:

- Webhook URL: `https://YOUR-OS-DOMAIN/webhooks/github`
- Content type: `application/json`
- Secret: create a strong value and save the same value as Worker secret `GITHUB_WEBHOOK_SECRET`.
- Events: Pushes, Pull requests, Issues.

Those events become evidence, then flow through the same intelligence pipeline as manual captures.

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
