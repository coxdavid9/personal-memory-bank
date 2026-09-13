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
