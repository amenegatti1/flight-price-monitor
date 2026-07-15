# flight-price-monitor

Award seat watcher for Seats.aero with push notifications via Telegram, driven by a GitHub Actions schedule and configured through a web dashboard.

- **Dashboard** (`docs/index.html`): a seats.aero-style UI to change origin, destinations, travel window, carriers, cabins, alert rules and notification behaviour. Saving pushes the config straight to this repo.
- **Config** (`config/monitor-config.json`): single source of truth read by every run.
- **Workflow** (`.github/workflows/check-award-seat.yml`): runs every 5 minutes, plus manual runs with one-off overrides.
- **Monitor** (`scripts/check-award-seat.mjs`): queries Seats.aero and sends formatted Telegram notifications with flight numbers, departure/arrival times, duration, stops, aircraft, seat counts, points and taxes.

See [MONITOR_SETUP.md](MONITOR_SETUP.md) for full setup instructions.

## Notification example

> **Telegram alert**
> ```
> ✈️ Award seats found
> Search: MEL → SIN · Qantas
>
> ✈️ Airline: Qantas
> Route: MEL → SIN
> Departure date: Fri, 21 Aug
> Cabins:
> • Business — 2 seats · 68,400 pts · 86 AUD taxes
> • Economy — 5 seats · 31,800 pts · 52 AUD taxes
> Flight number: QF35
> Departure/arrival: 09:35 → 15:05
> Duration: 7h 30m
> ```
>
> By default repeat pushes are skipped while availability is unchanged ("Only alert when availability changes" in the dashboard).
