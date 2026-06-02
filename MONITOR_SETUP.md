# Award Seat Monitor Setup

This repository checks Seats.aero every 10 minutes for Qantas award availability from Melbourne (`MEL`) to Jakarta (`CGK`) on `2026-08-21`. It logs the watched cabin availability, but only sends an ntfy push when an alert cabin is available.

## Required GitHub secrets

| Secret | Purpose |
| --- | --- |
| `SEATSAERO_API_KEY` | Your Seats.aero Pro API key |
| `NTFY_TOPIC` | Your ntfy topic name |
| `NTFY_TOKEN` | Optional, only needed if your ntfy topic/server requires auth |

The workflow also accepts these aliases: `SEATS_AERO_API_KEY` or `API_KEY` for the Seats.aero key, and `TOPIC` for the ntfy topic.

## Defaults

| Setting | Default |
| --- | --- |
| Origin | `MEL` |
| Destination | `CGK` |
| Date | `2026-08-21` |
| Source | `qantas` |
| Carrier | `QF` |
| Seats | `1` |
| Cabins checked | `business,economy` |
| Cabins that trigger ntfy | `business` |
| Search mode | cached search |
| ntfy server | `https://ntfy.sh` |

The default is cached Seats.aero search because live search requires a separate commercial agreement with Seats.aero. Do not set `USE_LIVE_SEARCH=true` unless your API key has live-search access.

## Changing The Flight

To monitor a different flight in future, change repository variables in:

`Settings -> Secrets and variables -> Actions -> Variables`

Useful variables:

| Variable | Example |
| --- | --- |
| `ORIGIN_AIRPORT` | `MEL` |
| `DESTINATION_AIRPORT` | `CGK` |
| `DEPARTURE_DATE` | `2026-08-21` |
| `SOURCE` | `qantas` |
| `CARRIER` | `QF` |
| `SEAT_COUNT` | `1` |
| `CABINS` | `business,economy` |
| `ALERT_CABINS` | `business` |
| `ONLY_DIRECT` | `true` |

`CABINS` controls what the monitor searches and logs. `ALERT_CABINS` controls what sends a push notification. For example, leave `CABINS=business,economy` and `ALERT_CABINS=business` if you want economy in the run log but only want your phone to buzz for business class.

## Running It

The workflow runs automatically every 10 minutes. You can also run it manually from:

`Actions -> Check Qantas award seat -> Run workflow`

If you want a test notification even when no alert cabin is found, create a repository variable named `NOTIFY_WHEN_EMPTY` with value `true`, run the workflow manually, then set it back to `false`.
