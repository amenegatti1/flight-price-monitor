# Award Seat Monitor Setup

This repository checks Seats.aero every 5 minutes for award availability and sends an ntfy push when seats matching your alert rules appear. Everything is configured from a web dashboard — no more editing repository variables.

## 1. Required GitHub secrets

`Settings → Secrets and variables → Actions → Secrets`

| Secret | Purpose |
| --- | --- |
| `SEATSAERO_API_KEY` | Your Seats.aero Pro API key (aliases accepted: `SEATS_AERO_API_KEY`, `API_KEY`) |
| `NTFY_TOPIC` | Your ntfy topic name (alias: `TOPIC`) |
| `NTFY_TOKEN` | Optional, only if your ntfy topic/server requires auth |

Optional repository **variable**: `NTFY_SERVER` (defaults to `https://ntfy.sh`).

## 2. The dashboard

The dashboard lives at `docs/index.html`. Two ways to use it:

1. **GitHub Pages (recommended):** `Settings → Pages → Source: Deploy from a branch → Branch: main, folder: /docs`. Your dashboard will be at `https://<username>.github.io/flight-price-monitor/`.
2. **Locally:** just open `docs/index.html` in a browser — it talks directly to the GitHub API, no server needed.

### Connecting

The dashboard needs a **fine-grained personal access token** so it can read/write the config and trigger runs:

1. GitHub → Settings → Developer settings → Fine-grained tokens → Generate new token.
2. Repository access: **only this repository**.
3. Permissions: **Contents: Read and write**, **Actions: Read and write**.
4. Paste it into the dashboard. It is stored only in your browser's localStorage.

### What you can control

| Setting | What it does |
| --- | --- |
| Monitoring enabled | Master switch. When off, scheduled runs exit immediately — no API calls, no pushes. |
| Origin / Destinations | One origin, any number of destination airports. |
| Travel window | A start and end date — the monitor searches the whole range. |
| Carriers & programs | Airline code paired with the Seats.aero mileage program to search (e.g. QF/qantas, VA/velocity). |
| Seats needed | Minimum seat count; flights with fewer known seats are skipped. |
| Cabins to search | What gets queried and shown in run logs (Economy, Business). |
| Alert mode | What actually buzzes your phone: **Business only**, **Economy only**, **Business & Economy**, or **Any cabin found**. |
| Max points caps | Optional per-cabin cap — no alert if the award costs more points than this. |
| Only alert when availability changes | On by default. Skips repeat pushes while the exact same seats stay available; re-alerts whenever flights, seat counts or points change, or seats disappear and come back. |
| Notify when empty | Low-priority "check complete" push on every run (useful for testing). |
| Direct flights only / Live search | Search behaviour. Only enable live search if your Seats.aero key includes it. |

Clicking **Save & push to GitHub** commits `config/monitor-config.json`; the next scheduled run (within 5 minutes) picks it up. **Run check now** dispatches the workflow immediately, and the dashboard shows recent run results.

## 3. Notifications

Alerts are consolidated into a single push per run and include, per flight: flight number, departure → arrival times, duration, stops, aircraft type, and per-cabin seat counts, points cost and taxes (when Seats.aero provides them). Tapping the notification opens the workflow run logs.

## 4. Manual runs with overrides

`Actions → Check award seats → Run workflow` lets you do a one-off check with different values (origin, destinations, dates, alert mode, notify-when-empty) without changing the saved config.

## 5. Editing the config by hand

`config/monitor-config.json` can also be edited directly:

```json
{
  "enabled": true,
  "origin": "MEL",
  "destinations": ["SIN", "KUL", "AMD", "CGK"],
  "dateRange": { "start": "2026-08-21", "end": "2026-08-21" },
  "carriers": [
    { "code": "QF", "source": "qantas" },
    { "code": "VA", "source": "velocity" }
  ],
  "seatCount": 1,
  "searchCabins": ["economy", "business"],
  "alertMode": "business",
  "onlyDirect": true,
  "useLiveSearch": false,
  "notifyWhenEmpty": false,
  "maxPointsPerCabin": { "economy": null, "business": null }
}
```

`alertMode` accepts `business`, `economy`, `both`, or `any`.

## Notes

- The default is cached Seats.aero search; live search requires a separate commercial agreement with Seats.aero.
- Legacy repository variables (`ORIGIN_AIRPORT`, `ALERT_CABINS`, etc.) are no longer read by the scheduled workflow — the config file is the source of truth. The same names still work as environment variables when running `npm run check` locally.
