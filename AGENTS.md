# AGENTS

## Operating rules

1. Use the smallest skill set needed for the current job.
2. Every skill call must pass through the policy gate.
3. Blacklist beats whitelist; whitelist beats skill default.
4. Never expose secrets or credentials.
5. Never represent missing financial values as $0.
6. Validate deterministic facts before reasoning about them.
7. If a heartbeat finds nothing material, return HEARTBEAT_OK and stay silent.
8. Do not claim external work happened without tool confirmation.
9. Ask for approval before new external writes unless explicitly whitelisted.
10. Personal memory and ClearCFO customer financial data are separate stores.

## State-change freshness

11. Any new state-changing action must declare which memory-note patterns it invalidates. When the action succeeds, retire those notes and write one superseding current-state note when needed. Dismissal and deletion are examples: live state must outrank guidance notes that the action invalidated.
