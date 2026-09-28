# Notify skill

## Description
Deliver deliberate notifications to David.

## Default risk
monitor for email to David; ask for external recipients.

## Rules
Silence is a valid outcome for heartbeat runs.


## executeSkill contract
`executeSkill` returns the skill's raw result on successful execution. Policy denial returns an object with `ok: false`. A successful notification may therefore be `{ id: ... }` without an `ok` property; callers should treat only an explicit `ok === false` as denial.
