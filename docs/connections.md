# Yahoo and iCloud access

Jarvis already supports reading, searching, and opening Yahoo email using IMAP. It supports reading upcoming events and creating approved events in the configured iCloud calendar using CalDAV.

## Render environment

| Variable | Value |
| --- | --- |
| YAHOO_IMAP_USER | Full Yahoo email address |
| YAHOO_IMAP_PASS | Generated Yahoo app password |
| CALDAV_BASE_URL | https://caldav.icloud.com/ |
| CALDAV_USERNAME | Apple Account email address |
| CALDAV_PASSWORD | Apple app-specific password |
| CALDAV_CALENDAR_NAME | Agent |

Create a calendar named Agent in iCloud Calendar. Jarvis reads and writes only the configured calendar; it does not read every calendar on an iPhone. Calendars stored only on the phone are not available through iCloud.

Use generated app passwords rather than normal account login passwords. Keep them in Render environment variables, never chat or repository files. Updating an environment variable requires the service to restart/deploy to load it.

Apple setup: https://support.apple.com/en-us/102654
Yahoo setup: https://help.yahoo.com/kb/SLN15241.html

## Test after deployment

Ask Jarvis: "Test my Yahoo email and iCloud calendar connections."

This performs an inbox login and an upcoming-event read. It does not fetch email bodies, change read flags, send mail, or create events. Results distinguish not configured, connected, authentication failed, calendar missing, and connection failed. A configured value alone is not proof that a login works.

Then ask: "Show my unread Yahoo emails."
Then ask: "Show upcoming calendar events."

Calendar creation still requires approval. Recording an interview workflow does not automatically add an iCloud calendar event. Request calendar creation separately.
