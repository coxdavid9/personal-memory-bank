# Render Ops Skill

## Purpose
Private deployment operations for David's Personal Agent.

## Tools
- `render_deploy_status` — safe latest deploy read.
- `render_logs` — safe recent log read.
- `render_redeploy` — ask tier; triggers a Render deploy.

## Rules
- Never redeploy without an explicit approval tap.
- Never expose the Render API key.
- Report the actual Render status returned by the API.
