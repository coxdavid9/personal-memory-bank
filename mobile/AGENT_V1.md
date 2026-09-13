# David's Personal Agent — V1

## Core architecture

The mobile app is the private client. The Render service is the agent backend. Postgres stores personal memory, project context, and conversation history.

## V1 capabilities

- Memory: persistent personal context and reminders.
- ClearCFO: project context in the personal agent; customer financial data stays in ClearCFO and will be accessed through a controlled API integration.
- Job Search: remembered job-search preferences and, in the next integration step, live job research plus application-history filtering.
- Calendar: permissioned iPhone Calendar/Reminders access is planned as a native capability.

## Security boundary

Never copy ClearCFO customer financial databases into the personal-agent database. The future ClearCFO connector should use a server-to-server credential stored in Render environment variables and return only the minimum data needed for the requested task.

Never put API keys in GitHub, the mobile bundle, or source-controlled configuration.

## Mobile build

The project uses Expo/React Native. EAS Build can produce iOS binaries in Expo's cloud infrastructure. A physical iPhone development build requires an Apple Developer account and appropriate signing credentials; a simulator build can be used without a device developer account.
