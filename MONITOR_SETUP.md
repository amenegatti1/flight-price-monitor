# Award Seat Monitor Setup

This repository checks Seats.aero every 10 minutes for Qantas award availability from Melbourne (`MEL`) to Jakarta (`CGK`) on `2026-08-21`, then sends an ntfy push notification when a match appears.

## Required GitHub secrets

The workflow expects these repository secrets:

| Secret | Purpose |
| --- | --- |
| `SEATSAERO_API_KEY` | Your Seats.aero Pro API key |
| `NTFY_TOPIC` | Your ntfy topic name |
| `NTFY_TOKEN` | Optional, only needed if your ntfy topic/server requires auth |

## Defaults

| Setting | Default |
| --- | --- |
| Origin | `MEL` |
| Destination | `CGK` |
| Date | `2026-08-21` |
| Source | `qantas` |
| Carrier | `QF` |
| Seats | `1` |
| ntfy server | `https://ntfy.sh` |

You can override these by adding repository variables in GitHub Actions settings, such as `SEAT_COUNT`, `CABIN`, `DEPARTURE_DATE`, or `NOTIFY_WHEN_EMPTY`.

## Running it

The workflow runs automatically every 10 minutes. You can also run it manually from:

`Actions -> Check Qantas award seat -> Run workflow`

If you want a test notification even when no seats are found, create a repository variable named `NOTIFY_WHEN_EMPTY` with value `true`, run the workflow manually, then set it back to `false`.
