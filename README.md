# David's Personal Agent

A private personal AI agent that remembers what matters, understands David's projects and goals, and gains new capabilities through modular tools.

## V1 direction

The original Memory Bank is now the memory layer rather than the whole product.

### Core
- Persistent personal memory
- Agent conversation with recent context
- Projects and goals as first-class context
- Capability registry so new tools can be added without rebuilding the core
- Existing email/ntfy reminder infrastructure

### V1 capabilities
- **ClearCFO** — project knowledge lives in the agent; ClearCFO customer financial data stays in the ClearCFO backend and will be accessed through a controlled API integration.
- **Job Search** — remembers David's accounting/finance preferences, application history and exclusions, then becomes the interface for future job-search tools.
- **iPhone Calendar / Reminders** — planned permissioned device capability.

## Architecture

```text
                 David's Personal Agent
                         |
          +--------------+--------------+
          |              |              |
       Memory         Projects      Capabilities
          |              |              |
          +--------------+--------------+
                         |
                    Agent / AI
                         |
        +----------------+----------------+
        |                                 |
     Job Search                        ClearCFO
        |                                 |
     web/tools                     ClearCFO API
                                          |
                                   ClearCFO database
```

Personal-agent memory and ClearCFO customer financial data are intentionally separate.

## Server environment variables

Required for AI:
- `OPENAI_API_KEY`
- Optional: `OPENAI_MODEL` (defaults to `gpt-5.6-luna`)

Optional ClearCFO integration placeholder:
- `CLEARCFO_API_URL`

Private Engineering agent GitHub integration:
- `GITHUB_TOKEN` — GitHub token stored in Render only; never commit it to the repo.
- `GITHUB_REPO` — optional `owner/repository` override; defaults to `coxdavid9/personal-memory-bank`.

The GitHub integration is read-only in this first step. It lets the private Engineering agent inspect repository status, open pull requests, individual PRs, and issues before we add controlled write actions.

Optional portfolio market-data fallback:
- `TWELVEDATA_API_KEY` — Twelve Data API key stored in Render only; never commit it to the repo.

Existing reminder variables remain supported:
- `DATABASE_URL`
- `RESEND_API_KEY`
- `REMINDER_EMAIL`
- `REMINDER_FROM`
- `APP_URL`
- `NTFY_TOPIC`

Never commit API keys, database credentials, or customer financial data to GitHub.

## iPhone app

The `mobile/` folder contains the Expo/React Native iPhone app foundation. It connects to the Render backend through `EXPO_PUBLIC_API_URL` and is designed to grow into the native app rather than remain a mobile webpage.

Apple Calendar and Reminders access will be added as explicit, permissioned capabilities rather than uploading the entire device calendar to the server.


## Private Engineering repo ops

V1 gives the private Engineering specialist conversational GitHub and Render operations.

Render-only environment variables:
- `GITHUB_TOKEN` — fine-grained GitHub PAT scoped to this repository.
- `GITHUB_REPO` — optional `owner/repository`; defaults to `coxdavid9/personal-memory-bank`.
- `RENDER_API_KEY` — Render API key restricted to David's agent service(s).
- `RENDER_SERVICE_ID` — optional; defaults to the Personal Agent service.
- `RENDER_OWNER_ID` — Render workspace/owner ID required for log queries.
- `GITHUB_WEBHOOK_SECRET` — secret used to verify GitHub webhook HMAC signatures.

Reads are safe. GitHub PR creation and Render redeploys are ask-tier writes requiring an explicit approval tap. The agent never merges, force-pushes, rewrites history, or deploys without approval.
