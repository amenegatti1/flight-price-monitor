import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import path from "node:path";

const CONFIG_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "config", "monitor-config.json");
const ALERT_MODES = {
  business: ["business"],
  economy: ["economy"],
  both: ["business", "economy"],
  any: null, // resolved to searchCabins below
};

const AIRLINE_NAMES = {
  QF: "Qantas", VA: "Virgin Australia", JQ: "Jetstar", NZ: "Air New Zealand",
  EK: "Emirates", SQ: "Singapore Airlines", CX: "Cathay Pacific",
  MH: "Malaysia Airlines", TG: "Thai Airways", GA: "Garuda Indonesia",
  JL: "Japan Airlines", NH: "ANA", UA: "United", AA: "American", DL: "Delta",
};

function airlineName(code) { return AIRLINE_NAMES[code] ?? code; }

const fileConfig = await loadFileConfig();
const config = buildConfig(fileConfig);

if (!config.enabled) {
  console.log("Monitoring is disabled in config/monitor-config.json (enabled: false). Skipping checks.");
  process.exit(0);
}

const routes = config.carriers.flatMap((carrier) =>
  config.destinations.map((destinationAirport) => ({
    carrier: carrier.code,
    source: carrier.source,
    destinationAirport,
  }))
);

const tripRangesStr = config.trips.map((t) => (t.start === t.end ? t.start : `${t.start}–${t.end}`)).join(", ");
console.log(
  `Checking ${routes.length} route(s) × ${config.trips.length} trip(s): ${config.origin} → ${config.destinations.join(", ")} | ` +
    `trips: ${tripRangesStr} | ` +
    `cabins: ${config.searchCabins.join("/")} | alerts: ${config.alertCabins.join("/")} (${config.alertMode})`
);

try {
  const allAlertRoutes = [];

  for (const trip of config.trips) {
    const tripConfig = { ...config, startDate: trip.start, endDate: trip.end };

    for (const route of routes) {
      const rc = { ...tripConfig, ...route };
      const tripTag = config.trips.length > 1 ? ` [${trip.start}]` : "";
      try {
        const response = rc.useLiveSearch ? await liveSearch(rc) : await cachedSearch(rc);
        const flights = await findMatchingFlights(response, rc);
        const alertFlights = flights.filter((f) => hasAlertCabin(f, rc));

        if (alertFlights.length > 0) {
          allAlertRoutes.push({ route, flights: alertFlights, tripStart: trip.start, tripEnd: trip.end });
          console.log(`ALERT ${route.carrier} ${config.origin}-${route.destinationAirport}${tripTag}: ${alertFlights.length} flight(s) match.`);
        } else if (flights.length > 0) {
          console.log(`${route.carrier} ${config.origin}-${route.destinationAirport}${tripTag}: availability found but no ${config.alertCabins.join("/")} match.`);
        } else {
          console.log(`${route.carrier} ${config.origin}-${route.destinationAirport}${tripTag}: no ${config.searchCabins.join("/")} seats.`);
        }
      } catch (err) {
        console.error(`Error checking ${route.carrier} ${config.origin}-${route.destinationAirport}${tripTag}: ${err.message}`);
      }
    }
  }

  if (allAlertRoutes.length > 0) {
    const fingerprint = fingerprintOf(allAlertRoutes);
    const state = await readState();

    if (config.notifyOnChangeOnly && state.fingerprint === fingerprint) {
      console.log(`Availability unchanged since last alert (${state.alertedAt ?? "earlier"}) — push skipped. Disable "Only alert when availability changes" to always notify.`);
    } else {
      const message = buildConsolidatedMessage(allAlertRoutes, config);
      await publishTelegram(buildTelegramMessages(allAlertRoutes, config));
      await writeState({ fingerprint, alertedAt: new Date().toISOString() });
      console.log(`\n${message}`);
    }
  } else {
    // Reset state so seats that disappear and come back trigger a fresh alert.
    const state = await readState();
    if (state.fingerprint && state.fingerprint !== "none") {
      await writeState({ fingerprint: "none", alertedAt: state.alertedAt });
    }
    if (config.notifyWhenEmpty) {
      const tripRanges = config.trips.map((t) => formatTripRange(t.start, t.end)).join(", ");
      const message = `No ${config.alertCabins.join("/")} award seats: ${config.origin} → ${config.destinations.join("/")} (${tripRanges}).`;
      await publishTelegram([buildEmptyTelegramMessage(message, config)]);
      console.log(message);
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

async function loadFileConfig() {
  try {
    return JSON.parse(await readFile(CONFIG_PATH, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw new Error(`Could not parse ${CONFIG_PATH}: ${err.message}`);
  }
}

function buildConfig(file) {
  const searchCabins = cabinList("CABINS", (file.searchCabins ?? ["economy", "business"]).join(","));
  const alertModeRaw = envSet("ALERT_MODE")
    ? env("ALERT_MODE", "")
    : envSet("ALERT_CABINS")
      ? env("ALERT_CABINS", "")
      : file.alertMode ?? "business";
  const alertMode = normalizeAlertMode(alertModeRaw);
  const alertCabins = (ALERT_MODES[alertMode] ?? searchCabins).filter((cabin) => searchCabins.includes(cabin));

  const fileCarriers = Array.isArray(file.carriers) ? file.carriers : [];
  const carrierCodes = multiEnv("CARRIERS", fileCarriers.map((c) => c.code).join(",") || "QF").map((c) => c.toUpperCase());
  const carrierSources = multiEnv("SOURCES", fileCarriers.map((c) => c.source).join(",") || "qantas");

  // Build trips: env var overrides for one-off runs; file.trips takes priority over file.dateRange
  let trips;
  if (envSet("START_DATE") || envSet("DEPARTURE_DATE")) {
    const start = env("START_DATE", env("DEPARTURE_DATE", "2026-08-21"));
    const end = env("END_DATE", start);
    trips = [{ start, end: end < start ? start : end }];
  } else if (Array.isArray(file.trips) && file.trips.length > 0) {
    trips = file.trips.slice(0, 4).map((t) => {
      const start = t.start ?? "2026-08-21";
      const end = t.end ?? start;
      return { start, end: end < start ? start : end };
    });
  } else {
    const start = file.dateRange?.start ?? "2026-08-21";
    const end = file.dateRange?.end ?? start;
    trips = [{ start, end: end < start ? start : end }];
  }
  const startDate = trips[0].start;

  return {
    seatsAeroApiKey: requiredEnv("SEATSAERO_API_KEY"),
    telegramBotToken: requiredEnv("TELEGRAM_BOT_TOKEN"),
    telegramChatId: requiredEnv("TELEGRAM_CHAT_ID"),
    enabled: boolEnv("MONITOR_ENABLED", file.enabled ?? true),
    origin: env("ORIGIN_AIRPORT", file.origin ?? "MEL").toUpperCase(),
    destinations: multiEnv("DESTINATION_AIRPORTS", (file.destinations ?? ["CGK"]).join(",")).map((d) => d.toUpperCase()),
    trips,
    startDate,
    endDate: trips[0].end,
    carriers: carrierCodes.map((code, i) => ({ code, source: carrierSources[i] ?? carrierSources[0] })),
    seatCount: numberEnv("SEAT_COUNT", file.seatCount ?? 1),
    searchCabins,
    alertMode,
    alertCabins: alertCabins.length > 0 ? alertCabins : searchCabins,
    onlyDirect: boolEnv("ONLY_DIRECT", file.onlyDirect ?? true),
    useLiveSearch: boolEnv("USE_LIVE_SEARCH", file.useLiveSearch ?? false),
    notifyWhenEmpty: boolEnv("NOTIFY_WHEN_EMPTY", file.notifyWhenEmpty ?? false),
    notifyOnChangeOnly: boolEnv("NOTIFY_ON_CHANGE_ONLY", file.notifyOnChangeOnly ?? true),
    stateFile: env("STATE_FILE", ".state/last-alert.json"),
    maxPointsPerCabin: file.maxPointsPerCabin ?? {},
  };
}

function normalizeAlertMode(mode) {
  const normalized = String(mode).trim().toLowerCase();
  if (normalized in ALERT_MODES) return normalized;
  // Legacy comma list (e.g. ALERT_CABINS="business,economy").
  const cabins = normalized.split(",").map((s) => s.trim()).filter(Boolean);
  if (cabins.includes("business") && cabins.includes("economy")) return "both";
  if (cabins.includes("economy")) return "economy";
  return "business";
}

async function liveSearch(c) {
  const results = [];
  for (const date of datesInRange(c.startDate, c.endDate, 14)) {
    results.push(
      await seatsAeroFetch("https://seats.aero/partnerapi/live", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          origin_airport: c.origin,
          destination_airport: c.destinationAirport,
          departure_date: date,
          source: c.source,
          disable_filters: false,
          show_dynamic_pricing: false,
          seat_count: c.seatCount,
        }),
      })
    );
  }
  return results;
}

async function cachedSearch(c) {
  const params = new URLSearchParams({
    origin_airport: c.origin,
    destination_airport: c.destinationAirport,
    start_date: c.startDate,
    end_date: c.endDate,
    take: "200",
    only_direct_flights: String(c.onlyDirect),
    carriers: c.carrier,
    sources: c.source,
    cabins: c.searchCabins.join(","),
    include_trips: "true",
    minify_trips: "false",
  });

  return seatsAeroFetch(`https://seats.aero/partnerapi/search?${params}`);
}

async function seatsAeroFetch(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      accept: "application/json",
      "Partner-Authorization": config.seatsAeroApiKey,
      ...(options.headers ?? {}),
    },
  });

  const text = await res.text();
  const data = parseJson(text);

  if (!res.ok) {
    throw new Error(`Seats.aero returned HTTP ${res.status}: ${JSON.stringify(data).slice(0, 1000)}`);
  }

  return data;
}

async function findMatchingFlights(payload, c) {
  const items = flattenObjects(payload);

  // Preferred path: trip records carry flight numbers, times, seats and pricing.
  let trips = items
    .filter(isTrip)
    .map(parseTrip)
    .filter((trip) => tripMatches(trip, c));

  // The cached search often omits embedded trip records; ask the trips
  // endpoint for the detail before settling for bare day-level data.
  if (trips.length === 0) trips = await fetchTripDetails(items, c);

  if (trips.length > 0) return groupTripsIntoFlights(trips, c);

  // Last resort: per-day availability objects with cabin-level heuristics.
  const dates = datesInRange(c.startDate, c.endDate, 60);
  const flights = items
    .filter((item) => hasRoute(item, c))
    .filter((item) => dates.some((date) => JSON.stringify(item).includes(date)))
    .filter((item) => JSON.stringify(item).toUpperCase().includes(c.carrier))
    .map((item) => summarizeFlight(item, c))
    .filter((flight) => flight.cabins.some((cabin) => cabin.available));

  if (flights.length > 0) {
    console.log(`  (no trip-level records from Seats.aero for ${c.carrier} ${c.origin}-${c.destinationAirport}; flight numbers/times unavailable)`);
  }

  return mergeFlights(flights);
}

// Availability records carry an ID that can be exchanged for trip-level
// detail (flight numbers, times, points) via GET /partnerapi/trips/{id}.
async function fetchTripDetails(items, c) {
  const dates = datesInRange(c.startDate, c.endDate, 60);
  const ids = [
    ...new Set(
      items
        .filter((item) => isAvailability(item, c, dates))
        .filter((item) => JSON.stringify(item).toUpperCase().includes(c.carrier))
        .map((item) => firstValue(item, ["ID", "Id", "id"]))
    ),
  ].slice(0, 5); // cap extra API calls per route per run

  const trips = [];
  for (const id of ids) {
    try {
      const detail = await seatsAeroFetch(`https://seats.aero/partnerapi/trips/${id}`);
      trips.push(...flattenObjects(detail).filter(isTrip).map(parseTrip).filter((trip) => tripMatches(trip, c)));
    } catch (err) {
      console.error(`  Trip detail lookup failed for ${id}: ${err.message}`);
    }
  }

  if (trips.length > 0) {
    console.log(`  Fetched trip details for ${c.carrier} ${c.origin}-${c.destinationAirport} from the trips endpoint.`);
  }
  return trips;
}

function isAvailability(item, c, dates) {
  const id = firstValue(item, ["ID", "Id", "id"]);
  if (typeof id !== "string" || id.length === 0) return false;
  const date = firstValue(item, ["Date", "date", "ParsedDate", "parsed_date"]);
  if (!date) return false;
  return dates.includes(String(date).slice(0, 10)) && hasRoute(item, c);
}

// The flattened payload often yields several records for the same flight and
// day (e.g. one with seat counts, one without). Merge them, keeping the best
// information for each cabin.
function mergeFlights(flights) {
  const byFlight = new Map();

  for (const flight of flights) {
    const key = `${flight.flightNumber}|${flight.departureDate}`;
    const existing = byFlight.get(key);
    if (!existing) {
      byFlight.set(key, flight);
      continue;
    }
    for (const cabin of flight.cabins) {
      const match = existing.cabins.find((cab) => normalizeCabinName(cab.cabin) === normalizeCabinName(cabin.cabin));
      if (!match) {
        existing.cabins.push(cabin);
        continue;
      }
      match.available = match.available || cabin.available;
      if (cabin.seats !== null && cabin.seats !== undefined && (match.seats === null || match.seats === undefined || cabin.seats > match.seats)) {
        match.seats = cabin.seats;
      }
      if (cabin.points && (!match.points || Number(cabin.points) < Number(match.points))) match.points = cabin.points;
    }
  }

  return [...byFlight.values()];
}

function isTrip(item) {
  return firstValue(item, ["FlightNumbers", "flight_numbers"]) !== undefined && firstValue(item, ["Cabin", "cabin"]) !== undefined;
}

function parseTrip(item) {
  const departsAt = firstValue(item, ["DepartsAt", "departs_at"]);
  return {
    flightNumbers: String(firstValue(item, ["FlightNumbers", "flight_numbers"])).replace(/,\s*/g, " + "),
    departsAt,
    arrivesAt: firstValue(item, ["ArrivesAt", "arrives_at"]),
    date: departsAt ? String(departsAt).slice(0, 10) : undefined,
    durationMinutes: numericFirstValue(item, ["TotalDuration", "total_duration"]),
    stops: numericFirstValue(item, ["Stops", "stops"]),
    aircraft: joinIfArray(firstValue(item, ["Aircraft", "aircraft"])),
    seats: numericFirstValue(item, ["RemainingSeats", "remaining_seats"]),
    points: numericFirstValue(item, ["MileageCost", "mileage_cost"]),
    taxes: numericFirstValue(item, ["TotalTaxes", "total_taxes"]),
    taxCurrency: firstValue(item, ["TaxesCurrency", "taxes_currency"]),
    cabin: normalizeCabinName(firstValue(item, ["Cabin", "cabin"])),
    carriers: String(firstValue(item, ["Carriers", "carriers"]) ?? "").toUpperCase(),
    origin: upperAny(item, ["OriginAirport", "origin_airport"]),
    destination: upperAny(item, ["DestinationAirport", "destination_airport"]),
  };
}

function tripMatches(trip, c) {
  if (!trip.date || trip.date < c.startDate || trip.date > c.endDate) return false;
  if (!c.searchCabins.includes(trip.cabin)) return false;
  if (trip.origin && trip.origin !== c.origin) return false;
  if (trip.destination && trip.destination !== c.destinationAirport) return false;
  if (c.onlyDirect && trip.stops !== null && trip.stops > 0) return false;
  if (trip.carriers && !trip.carriers.includes(c.carrier) && !trip.flightNumbers.toUpperCase().includes(c.carrier)) return false;
  if (trip.seats !== null && trip.seats > 0 && trip.seats < c.seatCount) return false;
  return true;
}

function groupTripsIntoFlights(trips, c) {
  const byFlight = new Map();

  for (const trip of trips) {
    const key = `${trip.flightNumbers}|${trip.date}`;
    if (!byFlight.has(key)) {
      byFlight.set(key, {
        flightNumber: trip.flightNumbers,
        origin: trip.origin ?? c.origin,
        destination: trip.destination ?? c.destinationAirport,
        departureDate: trip.date,
        departsAt: trip.departsAt,
        arrivesAt: trip.arrivesAt,
        durationMinutes: trip.durationMinutes,
        stops: trip.stops,
        aircraft: trip.aircraft,
        cabins: [],
      });
    }
    const flight = byFlight.get(key);
    const existing = flight.cabins.find((cab) => normalizeCabinName(cab.cabin) === trip.cabin);
    const cabin = {
      cabin: capitalize(trip.cabin),
      available: true,
      seats: trip.seats > 0 ? trip.seats : null,
      points: trip.points,
      taxes: trip.taxes,
      taxCurrency: trip.taxCurrency,
    };
    // Keep the cheapest option per cabin.
    if (!existing) flight.cabins.push(cabin);
    else if (cabin.points !== null && (existing.points === null || cabin.points < existing.points)) Object.assign(existing, cabin);
  }

  return [...byFlight.values()].sort((a, b) => String(a.departsAt ?? "").localeCompare(String(b.departsAt ?? "")));
}

function summarizeFlight(item, c) {
  const departureDate = firstValue(item, ["DepartureDate", "departure_date", "Date", "date"]) ?? c.startDate;
  return {
    flightNumber: firstValue(item, ["FlightNumber", "flight_number", "Flight", "flight", "MarketingFlightNumber"]) ?? c.carrier,
    origin: firstValue(item, ["OriginAirport", "origin_airport", "Origin", "origin", "from"]) ?? c.origin,
    destination: firstValue(item, ["DestinationAirport", "destination_airport", "Destination", "destination", "to"]) ?? c.destinationAirport,
    departureDate: String(departureDate).slice(0, 10),
    cabins: c.searchCabins.map((cabin) => summarizeCabin(item, cabin, c.seatCount)),
  };
}

function summarizeCabin(item, cabin, minSeats) {
  const specs = getCabinSpecs();
  const spec = specs[cabin] ?? specs[cabin.toLowerCase()];
  if (!spec) return { cabin, available: false, seats: null, points: null };

  const availableValue = firstValue(item, spec.availableKeys);
  const seats = numericFirstValue(item, spec.seatKeys);
  const points = numericFirstValue(item, spec.pointsKeys) ?? firstValue(item, spec.pointsKeys);
  const text = JSON.stringify(item).toLowerCase();
  const listedCabins = String(firstValue(item, ["AvailableCabins", "available_cabins", "Cabins", "cabins", "Cabin", "cabin"]) ?? "").toLowerCase();

  const explicitlyAvailable = parseAvailability(availableValue);
  const hasEnoughSeats = seats !== null && seats >= minSeats;
  const hasPriceSignal = points !== undefined && points !== null && points !== "" && String(points) !== "0";
  const cabinListed = spec.aliases.some((alias) => listedCabins.includes(alias));
  const cabinNamedAvailable = spec.aliases.some((alias) => text.includes(`${alias}available\":true`) || text.includes(`${alias}_available\":true`));

  return {
    cabin: spec.label,
    available: explicitlyAvailable === true || hasEnoughSeats || hasPriceSignal || cabinListed || cabinNamedAvailable,
    seats,
    points,
  };
}

function hasAlertCabin(flight, c) {
  const alertSet = new Set(c.alertCabins.map(normalizeCabinName));
  return flight.cabins.some((cabin) => {
    if (!cabin.available) return false;
    const name = normalizeCabinName(cabin.cabin);
    if (!alertSet.has(name)) return false;
    const maxPoints = c.maxPointsPerCabin?.[name];
    if (maxPoints && Number(cabin.points) > Number(maxPoints)) return false;
    return true;
  });
}

function buildTitle(allAlertRoutes, c) {
  const carriers = [...new Set(allAlertRoutes.map((r) => r.route.carrier))];
  const names = carriers.map(airlineName).slice(0, 3).join(", ");
  const dests = [...new Set(allAlertRoutes.map((r) => r.route.destinationAirport))];
  const shown = dests.slice(0, 3).join(", ");
  const extra = dests.length > 3 ? ` +${dests.length - 3}` : "";
  return `${c.origin} → ${shown}${extra} · ${names}`;
}

function buildConsolidatedMessage(allAlertRoutes, c) {
  const byCarrier = new Map();
  for (const routeData of allAlertRoutes) {
    const { carrier } = routeData.route;
    if (!byCarrier.has(carrier)) byCarrier.set(carrier, []);
    byCarrier.get(carrier).push(routeData);
  }

  const sections = [];
  for (const [carrier, routes] of byCarrier) {
    const lines = [`**${airlineName(carrier)}**`];

    for (const { route, flights, tripStart, tripEnd } of routes) {
      const tripLabel = tripStart && c.trips && c.trips.length > 1
        ? ` _(${formatTripRange(tripStart, tripEnd)})_`
        : "";
      lines.push(`\n**${route.destinationAirport}**${tripLabel}`);

      const byDate = new Map();
      for (const flight of flights) {
        if (!byDate.has(flight.departureDate)) byDate.set(flight.departureDate, []);
        byDate.get(flight.departureDate).push(flight);
      }

      for (const [date, dayFlights] of byDate) {
        const availCabins = mergeDayCabins(dayFlights);
        if (availCabins.length === 0) continue;

        const best = dayFlights.find((f) => f.departsAt) ?? dayFlights[0];
        const detail = buildFlightDetail(best, route);
        const dateStr = formatDate(date);
        const bullet = detail ? `- ${dateStr} *(${detail})*` : `- ${dateStr}`;

        if (availCabins.length === 1) {
          lines.push(`${bullet} — ${formatCabinLine(availCabins[0])}`);
        } else {
          lines.push(bullet);
          for (const cabin of availCabins) lines.push(`  ${formatCabinLine(cabin)}`);
        }
      }
    }
    sections.push(lines.join("\n"));
  }

  return sections.join("\n\n---\n\n");
}

function mergeDayCabins(flights) {
  const cabinMap = new Map();
  for (const flight of flights) {
    for (const cabin of flight.cabins) {
      if (!cabin.available) continue;
      const key = normalizeCabinName(cabin.cabin);
      const ex = cabinMap.get(key);
      if (!ex) { cabinMap.set(key, { ...cabin }); continue; }
      if (cabin.seats !== null && (ex.seats === null || cabin.seats > ex.seats)) ex.seats = cabin.seats;
      if (cabin.points && (!ex.points || Number(cabin.points) < Number(ex.points))) {
        ex.points = cabin.points; ex.taxes = cabin.taxes; ex.taxCurrency = cabin.taxCurrency;
      }
    }
  }
  return [...cabinMap.values()];
}

function buildFlightDetail(flight, route) {
  const parts = [];
  if (flight.flightNumber && flight.flightNumber !== route.carrier) parts.push(flight.flightNumber);
  if (flight.departsAt) {
    const dep = formatTime(flight.departsAt);
    const arr = flight.arrivesAt ? formatTime(flight.arrivesAt) : "";
    parts.push(arr ? `${dep}–${arr}` : dep);
  }
  if (flight.durationMinutes) parts.push(formatDuration(flight.durationMinutes));
  if (flight.stops === 0) parts.push("nonstop");
  else if (flight.stops > 0) parts.push(`${flight.stops} stop${flight.stops > 1 ? "s" : ""}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

function formatCabinLine(cabin) {
  const name = normalizeCabinName(cabin.cabin) === "business" ? "Business" : "Economy";
  const seats = cabin.seats !== null && cabin.seats !== undefined ? `${cabin.seats} seat${cabin.seats === 1 ? "" : "s"}` : "avail";
  const points = cabin.points ? ` · ${Number(cabin.points).toLocaleString("en-AU")} pts` : "";
  const taxes = cabin.taxes ? ` (+${formatTaxes(cabin.taxes, cabin.taxCurrency)})` : "";
  return `${name} ${seats}${points}${taxes}`;
}

function formatTaxes(amount, currency) {
  const value = Math.round(Number(amount) / 100);
  return `${value} ${currency ?? ""}`.trim();
}

function fingerprintOf(allAlertRoutes) {
  // Summarise per departure date + cabin so equivalent connecting-flight
  // variants don't flip the fingerprint (and re-alert) between runs.
  const stable = allAlertRoutes.map(({ route, flights, tripStart, tripEnd }) => {
    const byDate = new Map();
    for (const flight of flights) {
      const key = flight.departureDate ?? "unknown";
      if (!byDate.has(key)) byDate.set(key, []);
      byDate.get(key).push(flight);
    }
    const days = [...byDate.keys()].sort().map((date) => {
      const cabins = mergeDayCabins(byDate.get(date))
        .map((cab) => `${normalizeCabinName(cab.cabin)}:${cab.seats ?? "?"}:${cab.points ?? "?"}`)
        .sort();
      return `${date}:${cabins.join(",")}`;
    });
    return {
      route: `${route.carrier}-${route.destinationAirport}`,
      tripStart: tripStart ?? null,
      tripEnd: tripEnd ?? null,
      days,
    };
  });
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

async function readState() {
  try {
    return JSON.parse(await readFile(config.stateFile, "utf8"));
  } catch {
    return {};
  }
}

async function writeState(state) {
  try {
    await mkdir(path.dirname(config.stateFile), { recursive: true });
    await writeFile(config.stateFile, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error(`Could not persist alert state: ${err.message}`);
  }
}

function formatTime(isoString) {
  const match = String(isoString).match(/T(\d{2}:\d{2})/);
  return match ? match[1] : String(isoString);
}

function formatDuration(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h${m > 0 ? ` ${m}m` : ""}` : `${m}m`;
}

function formatDate(dateString) {
  const date = new Date(`${dateString}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return dateString;
  return date.toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
}

function formatDateRange(c) {
  return c.startDate === c.endDate ? formatDate(c.startDate) : `${formatDate(c.startDate)} – ${formatDate(c.endDate)}`;
}

function formatTripRange(start, end) {
  if (!start) return "";
  const s = formatDate(start);
  if (!end || end === start) return s;
  return `${s} – ${formatDate(end)}`;
}

function datesInRange(start, end, maxDays) {
  const dates = [];
  const startDate = new Date(`${start}T00:00:00Z`);
  const endDate = new Date(`${end}T00:00:00Z`);
  for (let d = startDate; d <= endDate && dates.length < maxDays; d = new Date(d.getTime() + 86400000)) {
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates.length > 0 ? dates : [start];
}

function buildTelegramMessages(allAlertRoutes, c) {
  const header = [
    "<b>✈️ Award seats found</b>",
    `<i>${escapeHtml(buildTitle(allAlertRoutes, c))}</i>`,
  ].join("\n");
  const blocks = [header];

  for (const { route, flights, tripStart, tripEnd } of allAlertRoutes) {
    // Group by departure date so every day in the trip window is represented,
    // instead of listing every connecting-flight combination on the first day.
    const byDate = new Map();
    for (const flight of flights) {
      const key = flight.departureDate ?? "unknown";
      if (!byDate.has(key)) byDate.set(key, []);
      byDate.get(key).push(flight);
    }

    for (const date of [...byDate.keys()].sort()) {
      const dayFlights = byDate.get(date);
      const cabins = mergeDayCabins(dayFlights);
      if (cabins.length === 0) continue;

      const lines = [formatTelegramDateHeader(date, route, c)];

      const rep = representativeFlight(dayFlights);
      const timing = formatTelegramTiming(rep, route);
      if (timing) lines.push(timing);

      if (tripStart && c.trips && c.trips.length > 1) {
        lines.push(`<i>Trip window: ${escapeHtml(formatTripRange(tripStart, tripEnd))}</i>`);
      }

      for (const cabin of cabins) lines.push(formatTelegramCabinLine(cabin));

      if (dayFlights.length > 1) {
        const extra = dayFlights.length - 1;
        lines.push(`<i>+${extra} more itinerary option${extra > 1 ? "s" : ""}</i>`);
      }

      if (rep.aircraft) lines.push(`<i>${escapeHtml(rep.aircraft)}</i>`);

      blocks.push(lines.join("\n"));
    }
  }

  return chunkTelegramBlocks(blocks);
}

function formatTelegramDateHeader(date, route, c) {
  const dateStr = escapeHtml(formatDate(date));
  const carrier = escapeHtml(airlineName(route.carrier));
  const routeStr = escapeHtml(`${c.origin} → ${route.destinationAirport}`);
  return `<b>${dateStr}</b> · ${carrier} ${routeStr}`;
}

function representativeFlight(dayFlights) {
  // Cheapest award option first, then earliest departure.
  return dayFlights.slice().sort(
    (a, b) => bestPoints(a) - bestPoints(b) || String(a.departsAt ?? "").localeCompare(String(b.departsAt ?? ""))
  )[0] ?? dayFlights[0];
}

function bestPoints(flight) {
  const pts = flight.cabins
    .filter((cabin) => cabin.available && cabin.points)
    .map((cabin) => Number(cabin.points));
  return pts.length ? Math.min(...pts) : Infinity;
}

function formatTelegramTiming(flight, route) {
  const parts = [];
  if (flight.flightNumber && flight.flightNumber !== route.carrier) {
    parts.push(escapeHtml(flight.flightNumber));
  }
  if (flight.departsAt || flight.arrivesAt) {
    const departs = flight.departsAt ? formatTime(flight.departsAt) : "—";
    const arrives = flight.arrivesAt ? formatTime(flight.arrivesAt) : "—";
    parts.push(escapeHtml(`${departs} → ${arrives}`));
  }
  if (flight.durationMinutes) parts.push(escapeHtml(formatDuration(flight.durationMinutes)));
  const stops = formatTelegramStops(flight);
  if (stops) parts.push(stops);
  return parts.length > 0 ? parts.join(" · ") : null;
}

function formatTelegramStops(flight) {
  if (flight.stops === 0) return "nonstop";
  if (flight.stops > 0) return `${flight.stops} stop${flight.stops > 1 ? "s" : ""}`;
  return null;
}

function buildEmptyTelegramMessage(message, c) {
  const tripRanges = c.trips.map((trip) => formatTripRange(trip.start, trip.end)).join(", ");
  return [
    "<b>✈️ Award seat check complete</b>",
    `<i>${escapeHtml(c.origin)} → ${escapeHtml(c.destinations.join("/"))} · ${escapeHtml(c.alertCabins.map(capitalize).join("/"))}</i>`,
    `<i>Trip window: ${escapeHtml(tripRanges)}</i>`,
    "",
    escapeHtml(message),
  ].join("\n");
}

function formatTelegramCabinLine(cabin) {
  const name = normalizeCabinName(cabin.cabin) === "business" ? "Business" : "Economy";
  const seats = cabin.seats !== null && cabin.seats !== undefined ? `${cabin.seats} seat${cabin.seats === 1 ? "" : "s"}` : "available";
  const points = cabin.points ? `${Number(cabin.points).toLocaleString("en-AU")} pts` : "points TBC";
  const taxes = cabin.taxes ? ` (+${escapeHtml(formatTaxes(cabin.taxes, cabin.taxCurrency))})` : "";
  return `• <b>${escapeHtml(name)}</b> — ${escapeHtml(seats)} · ${escapeHtml(points)}${taxes}`;
}

function chunkTelegramBlocks(blocks) {
  const messages = [];
  let current = "";

  for (const block of blocks) {
    const candidate = current ? `${current}\n\n${block}` : block;
    if (candidate.length <= 4000) {
      current = candidate;
      continue;
    }

    if (current) messages.push(current);

    if (block.length <= 4000) {
      current = block;
      continue;
    }

    const lines = block.split("\n");
    current = "";
    for (const line of lines) {
      const next = current ? `${current}\n${line}` : line;
      if (next.length <= 4000) current = next;
      else {
        if (current) messages.push(current);
        current = line;
      }
    }
  }

  if (current) messages.push(current);
  return messages;
}

async function publishTelegram(messages) {
  const url = `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`;

  for (const text of messages) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: config.telegramChatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) throw new Error(`Telegram Bot API returned HTTP ${res.status}: ${await res.text()}`);
  }
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function flattenObjects(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);

  const current = Array.isArray(value) ? [] : [value];
  for (const child of Object.values(value)) current.push(...flattenObjects(child, seen));
  return current;
}

function hasRoute(item, c) {
  const origin = upperAny(item, ["origin_airport", "OriginAirport", "origin", "Origin", "from"]);
  const destination = upperAny(item, ["destination_airport", "DestinationAirport", "destination", "Destination", "to"]);
  const route = JSON.stringify(item).toUpperCase();

  return (origin === c.origin && destination === c.destinationAirport) || (route.includes(c.origin) && route.includes(c.destinationAirport));
}

function multiEnv(name, fallback) {
  return env(name, fallback)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function cabinList(name, fallback) {
  return env(name, fallback)
    .split(",")
    .map((cabin) => cabin.trim().toLowerCase())
    .filter(Boolean);
}

function normalizeCabinName(cabin) {
  return String(cabin).trim().toLowerCase();
}

function capitalize(text) {
  return String(text).charAt(0).toUpperCase() + String(text).slice(1);
}

function joinIfArray(value) {
  if (value === undefined || value === null) return undefined;
  return Array.isArray(value) ? value.join(", ") : String(value);
}

function getCabinSpecs() {
  return {
    economy: {
      label: "Economy",
      aliases: ["economy", "y"],
      availableKeys: ["EconomyAvailable", "economy_available", "economyAvailable", "YAvailable", "y_available", "Y"],
      seatKeys: ["EconomySeats", "economy_seats", "EconomySeatCount", "economy_seat_count", "EconomyRemainingSeats", "YSeats", "YSeatCount", "YRemainingSeats"],
      pointsKeys: ["EconomyMileage", "economy_mileage", "EconomyMiles", "EconomyPoints", "YMileage", "YMiles", "YPoints", "EconomyCost"],
    },
    business: {
      label: "Business",
      aliases: ["business", "j"],
      availableKeys: ["BusinessAvailable", "business_available", "businessAvailable", "JAvailable", "j_available", "J"],
      seatKeys: ["BusinessSeats", "business_seats", "BusinessSeatCount", "business_seat_count", "BusinessRemainingSeats", "JSeats", "JSeatCount", "JRemainingSeats"],
      pointsKeys: ["BusinessMileage", "business_mileage", "BusinessMiles", "BusinessPoints", "JMileage", "JMiles", "JPoints", "BusinessCost"],
    },
  };
}

function parseJson(text) {
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text };
  }
}

function parseAvailability(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value > 0;

  const normalized = String(value).toLowerCase();
  if (["true", "yes", "available", "1"].includes(normalized)) return true;
  if (["false", "no", "unavailable", "0"].includes(normalized)) return false;
  return null;
}

function env(name, fallback) {
  return process.env[name] === undefined || process.env[name] === "" ? fallback : process.env[name];
}

function envSet(name) {
  return process.env[name] !== undefined && process.env[name] !== "";
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}. Check the repository secret name.`);
  return value;
}

function boolEnv(name, fallback) {
  return ["1", "true", "yes", "on"].includes(String(env(name, fallback)).toLowerCase());
}

function numberEnv(name, fallback) {
  const value = Number(env(name, fallback));
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number`);
  return value;
}

function firstValue(item, keys) {
  for (const key of keys) {
    if (item[key] !== undefined && item[key] !== null && item[key] !== "") return item[key];
  }
  return undefined;
}

function numericFirstValue(item, keys) {
  for (const key of keys) {
    const value = Number(item[key]);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function upperAny(item, keys) {
  const value = firstValue(item, keys);
  return value === undefined ? undefined : String(value).toUpperCase();
}
