# Jarvis event/workflow V1

Confirmed job and interview changes create durable events and scheduled steps in PostgreSQL. No external scheduler or new environment variable is required. The server polls every 30 seconds and checks overdue work on startup.

## Use in chat

1. Tell Jarvis you applied to an exact role/company and approve the existing application tracking action.
2. Tell it the interview date/time and format. It looks up the application id and requests approval for `record_interview`.
3. Prep appears in chat, followed by a 7am Chicago briefing (when still upcoming), a 30-minute reminder, and a debrief prompt two hours after the scheduled start.
4. Report the outcome and promised response date. Completing the interview schedules a follow-up draft; default is seven days from the recorded completion.
5. Report a response, cancellation, reschedule, or rejection. Superseded pending steps are cancelled and managed current-state notes are retired.

`get_workflows` and authenticated `GET /api/workflows` expose the current event and task statuses. The conversation prompt treats this state as authoritative over historical reminders.

## Scope

V1 prepares a deterministic checklist from tracked details. Company research and tailored interview analysis are available through normal chat on request. Automatic delivery is in Jarvis chat: it does not send email, create calendar events, submit applications, poll email/calendar, or initiate paid background model calls. Jarvis must not infer “no response” from a timer.

## Persistence and safety

- Source changes, events, cancellation, steps, and note freshness commit atomically.
- Event keys include run, entity, and normalized payload; duplicate updates retain the existing due date.
- Application locks serialize record changes and worker delivery across server instances.
- Chat delivery and completion commit in the same transaction. Restart/retry cannot duplicate a committed message.
- Expired interview prep/reminders/debriefs are skipped on recovery. Due follow-up drafts remain useful.
- `record_interview` keeps the existing ASK approval gate. `get_workflows` is SAFE. Local chat delivery uses the MONITOR policy gate and tool audit. An ASK delivery policy suspends the exact task; approval resumes it only while the task is still current. Denied or expired approvals are terminal.
- Disabling Job Search pauses worker delivery. Previously scheduled steps remain stored.
- Database failures roll back delivery and retry at one-minute intervals, up to five attempts. Failed steps are visible through workflow status. No secrets are stored in diagnostic messages.
- Managed note prefixes are declared in `INVALIDATES`; unrelated memories are untouched.
- Render service downtime delays chat messages until recovery. This does not provide push alerts while Jarvis is closed.

## Validation

`npm test` runs unit and existing regression tests. Set `TEST_WORKFLOW_DATABASE_URL` to an isolated PostgreSQL instance to run persistence/concurrency tests too; CI provisions PostgreSQL 16 and runs those checks automatically. The tests create a unique schema and remove it afterward.
