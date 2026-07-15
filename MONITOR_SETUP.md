# Award Seat Monitor Setup

This repository checks Seats.aero every 5 minutes for award availability and sends a Telegram notification when seats matching your alert rules appear. Everything is configured from a web dashboard — no more editing repository variables.

## 1. Required GitHub secrets

`Settings → Secrets and variables → Actions → Secrets`

| Secret | Purpose |
| --- | --- |
| `SEATSAERO_API_KEY` | Your Seats.aero Pro API key (aliases accepted: `SEATS_AERO_API_KEY`, `API_KEY`) |
| `TELEGRAM_BOT_TOKEN` | Bot token from [@BotFather](https://t.me/BotFather) |
| `TELEGRAM_CHAT_ID` | Chat or group ID that should receive alerts |

### Creating the Telegram credentials

1. In Telegram, open [@BotFather](https://t.me/BotFather) and run `/newbot`.
2. Follow the prompts, then copy the bot token into the `TELEGRAM_BOT_TOKEN` GitHub secret.
3. Start a chat with your bot (or add it to a group) and send at least one message.
4. Open `https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates` in a browser and find the `chat.id` value for the conversation you want to notify.
5. Save that numeric value as the `TELEGRAM_CHAT_ID` GitHub secret.

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

Alerts are consolidated into Telegram messages per run and include, per flight: airline, route, departure date, cabin availability, seat counts, points cost, taxes, flight number, departure → arrival times, duration, stops, and aircraft type. When the cached search response doesn't embed those trip details, the monitor fetches them from the Seats.aero trips endpoint (a few extra API calls per route); only if that also returns nothing does the push fall back to date + seat count alone.

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
