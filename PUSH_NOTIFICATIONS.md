# Jarvis notifications

Open Jarvis from its iPhone Home Screen icon (iOS 16.4 or later), then More → Settings → Enable notifications. Permission is requested only from the enable tap. Send test asks the push service to deliver a test; its acceptance is not proof of arrival on the device.

New future reminders saved through chat or the Memory API are read from the existing memories table. The GitHub reminders workflow wakes Render and checks due reminders every five minutes. GitHub schedules and Render startup can be delayed, so this free implementation is best effort, not exact-time delivery. Keep calendar alerts for interviews and other precise commitments. The workflow can be disabled after 60 days of repository inactivity; check its Actions status and the notification configuration's lastTick.

The workflow uses a short-lived GitHub OIDC token restricted to this repository's main branch, this exact workflow, and schedule/workflow_dispatch events. No repository secret or Render billing change is needed. Standard hosted runners are free for this public repository. An active five-minute wake-up schedule affects database idle time; do not assume a future Neon migration will fit its free compute allowance unchanged.

VAPID keys are generated once and encrypted in Postgres using the existing session secret. Subscriptions are encrypted too. Preserve PERSONAL_AGENT_SESSION_SECRET and these tables when migrating the database; changing that secret requires deliberately re-enrolling devices. No private keys, subscriptions, reminder text or database credentials belong in repository files or scheduler logs.

Each reminder/time/device delivery is tracked durably. Concurrent workers use a Postgres advisory lock, completed/deleted reminders are checked under a row lock, successful sends are not repeated, and failures have bounded retries. Expired subscriptions are removed. Reminders due before a device opted in or more than 24 hours ago are not sent as a stale backlog. A process crash after provider acceptance but before the database commit can still retry; a stable notification tag reduces duplicate visible alerts but this is not an exactly-once guarantee.

This version delivers explicit saved reminders. Proactive calendar/email/market signal notifications remain a separate integration; do not claim they are enabled by this feature.

Acceptance: enable on the installed iPhone app, send a test, confirm receipt with the app closed, then save a future reminder and confirm one lock-screen notification after a scheduler run. Verify completing/deleting a reminder before it is due prevents that delivery.
