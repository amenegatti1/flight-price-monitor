# flight-price-monitor

Award seat watcher for Seats.aero with push notifications via [ntfy](https://ntfy.sh), driven by a GitHub Actions schedule and configured through a web dashboard.

- **Dashboard** (`docs/index.html`): a seats.aero-style UI to change origin, destinations, travel window, carriers, cabins, alert rules and notification behaviour. Saving pushes the config straight to this repo.
- **Config** (`config/monitor-config.json`): single source of truth read by every run.
- **Workflow** (`.github/workflows/check-award-seat.yml`): runs every 5 minutes, plus manual runs with one-off overrides.
- **Monitor** (`scripts/check-award-seat.mjs`): queries Seats.aero and sends rich ntfy pushes with flight numbers, departure/arrival times, duration, stops, aircraft, seat counts, points and taxes.

See [MONITOR_SETUP.md](MONITOR_SETUP.md) for full setup instructions.

## Notification example

> **Award seats found: QF→SIN**
> ```
> MEL award seats · Fri, 21 Aug
>
> QF MEL → SIN
> ✈ QF35 · Fri, 21 Aug · 09:35 → 15:05 · 7h 30m · direct · Airbus A380
>    💺 Business: 2 seats · 68,400 pts + 86.10 AUD
>    🪑 Economy: 5 seats · 31,800 pts + 52.40 AUD
> ```

Tapping the push opens the GitHub Actions run that produced it.
