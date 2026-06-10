import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const CONFIG_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "config", "monitor-config.json");
const ALERT_MODES = {
  business: ["business"],
  economy: ["economy"],
  both: ["business", "economy"],
  any: null, // resolved to searchCabins below
};

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

console.log(
  `Checking ${routes.length} route(s): ${config.origin} → ${config.destinations.join(", ")} | ` +
    `${config.startDate}${config.endDate !== config.startDate ? ` to ${config.endDate}` : ""} | ` +
    `cabins: ${config.searchCabins.join("/")} | alerts: ${config.alertCabins.join("/")} (${config.alertMode})`
);

try {
  const allAlertRoutes = [];

  for (const route of routes) {
    const rc = { ...config, ...route };
    try {
      const response = rc.useLiveSearch ? await liveSearch(rc) : await cachedSearch(rc);
      const flights = findMatchingFlights(response, rc);
      const alertFlights = flights.filter((f) => hasAlertCabin(f, rc));

      if (alertFlights.length > 0) {
        allAlertRoutes.push({ route, flights: alertFlights });
        console.log(`ALERT ${route.carrier} ${config.origin}-${route.destinationAirport}: ${alertFlights.length} flight(s) match.`);
      } else if (flights.length > 0) {
        console.log(`${route.carrier} ${config.origin}-${route.destinationAirport}: availability found but no ${config.alertCabins.join("/")} match.`);
      } else {
        console.log(`${route.carrier} ${config.origin}-${route.destinationAirport}: no ${config.searchCabins.join("/")} seats.`);
      }
    } catch (err) {
      console.error(`Error checking ${route.carrier} ${config.origin}-${route.destinationAirport}: ${err.message}`);
    }
  }

  if (allAlertRoutes.length > 0) {
    const message = buildConsolidatedMessage(allAlertRoutes, config);
    await publishNtfy({
      title: buildTitle(allAlertRoutes, config),
      message,
      priority: "urgent",
      tags: "airplane,tada",
    });
    console.log(`\n${message}`);
  } else if (config.notifyWhenEmpty) {
    const message = `No ${config.alertCabins.join("/")} award seats: ${config.origin} → ${config.destinations.join("/")} (${formatDateRange(config)}).`;
    await publishNtfy({ title: "Award seat check complete", message, priority: "low", tags: "airplane" });
    console.log(message);
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

  const startDate = env("START_DATE", env("DEPARTURE_DATE", file.dateRange?.start ?? "2026-08-21"));

  return {
    seatsAeroApiKey: requiredEnv("SEATSAERO_API_KEY"),
    ntfyTopic: requiredEnv("NTFY_TOPIC"),
    ntfyServer: env("NTFY_SERVER", "https://ntfy.sh").replace(/\/$/, ""),
    ntfyToken: env("NTFY_TOKEN", ""),
    enabled: boolEnv("MONITOR_ENABLED", file.enabled ?? true),
    origin: env("ORIGIN_AIRPORT", file.origin ?? "MEL").toUpperCase(),
    destinations: multiEnv("DESTINATION_AIRPORTS", (file.destinations ?? ["CGK"]).join(",")).map((d) => d.toUpperCase()),
    startDate,
    endDate: env("END_DATE", file.dateRange?.end ?? startDate),
    carriers: carrierCodes.map((code, i) => ({ code, source: carrierSources[i] ?? carrierSources[0] })),
    seatCount: numberEnv("SEAT_COUNT", file.seatCount ?? 1),
    searchCabins,
    alertMode,
    alertCabins: alertCabins.length > 0 ? alertCabins : searchCabins,
    onlyDirect: boolEnv("ONLY_DIRECT", file.onlyDirect ?? true),
    useLiveSearch: boolEnv("USE_LIVE_SEARCH", file.useLiveSearch ?? false),
    notifyWhenEmpty: boolEnv("NOTIFY_WHEN_EMPTY", file.notifyWhenEmpty ?? false),
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
    minify_trips: "true",
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

function findMatchingFlights(payload, c) {
  const items = flattenObjects(payload);

  // Preferred path: trip records carry flight numbers, times, seats and pricing.
  const trips = items
    .filter(isTrip)
    .map(parseTrip)
    .filter((trip) => tripMatches(trip, c));

  if (trips.length > 0) return groupTripsIntoFlights(trips, c).slice(0, 10);

  // Fallback: per-day availability objects with cabin-level heuristics.
  const dates = datesInRange(c.startDate, c.endDate, 60);
  const flights = items
    .filter((item) => hasRoute(item, c))
    .filter((item) => dates.some((date) => JSON.stringify(item).includes(date)))
    .filter((item) => JSON.stringify(item).toUpperCase().includes(c.carrier))
    .map((item) => summarizeFlight(item, c))
    .filter((flight) => flight.cabins.some((cabin) => cabin.available));

  return dedupeFlights(flights).slice(0, 10);
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
  const summaries = allAlertRoutes.map((r) => `${r.route.carrier}→${r.route.destinationAirport}`);
  const shown = summaries.slice(0, 3).join(", ");
  const extra = summaries.length > 3 ? ` +${summaries.length - 3} more` : "";
  return `Award seats found: ${shown}${extra}`;
}

function buildConsolidatedMessage(allAlertRoutes, c) {
  const lines = [`${c.origin} award seats · ${formatDateRange(c)}`];

  for (const { route, flights } of allAlertRoutes) {
    lines.push("", `${route.carrier} ${c.origin} → ${route.destinationAirport}`);
    for (const flight of flights) {
      lines.push(`✈ ${flight.flightNumber} · ${formatDate(flight.departureDate)}${formatTimesLine(flight)}`);
      for (const cabin of flight.cabins.filter((cab) => cab.available)) {
        lines.push(`   ${formatCabinLine(cabin, c)}`);
      }
    }
  }

  return lines.join("\n");
}

function formatTimesLine(flight) {
  const parts = [];
  if (flight.departsAt) {
    const dep = formatTime(flight.departsAt);
    const arr = flight.arrivesAt ? formatTime(flight.arrivesAt) : "";
    parts.push(arr ? `${dep} → ${arr}` : dep);
  }
  if (flight.durationMinutes) parts.push(formatDuration(flight.durationMinutes));
  if (flight.stops !== null && flight.stops !== undefined) parts.push(flight.stops === 0 ? "direct" : `${flight.stops} stop${flight.stops > 1 ? "s" : ""}`);
  if (flight.aircraft) parts.push(flight.aircraft);
  return parts.length > 0 ? ` · ${parts.join(" · ")}` : "";
}

function formatCabinLine(cabin, c) {
  const emoji = normalizeCabinName(cabin.cabin) === "business" ? "💺" : "🪑";
  const seats = cabin.seats !== null && cabin.seats !== undefined ? `${cabin.seats} seat${cabin.seats === 1 ? "" : "s"}` : "seats n/a";
  const points = cabin.points ? ` · ${Number(cabin.points).toLocaleString("en-AU")} pts` : "";
  const taxes = cabin.taxes ? ` + ${formatTaxes(cabin.taxes, cabin.taxCurrency)}` : "";
  return `${emoji} ${cabin.cabin}: ${seats}${points}${taxes}`;
}

function formatTaxes(amount, currency) {
  const value = Number(amount) / 100;
  return `${value.toFixed(2)} ${currency ?? ""}`.trim();
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

function datesInRange(start, end, maxDays) {
  const dates = [];
  const startDate = new Date(`${start}T00:00:00Z`);
  const endDate = new Date(`${end}T00:00:00Z`);
  for (let d = startDate; d <= endDate && dates.length < maxDays; d = new Date(d.getTime() + 86400000)) {
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates.length > 0 ? dates : [start];
}

async function publishNtfy({ title, message, priority, tags }) {
  // Use ntfy's JSON publish endpoint: HTTP headers only allow Latin-1, which
  // breaks titles containing arrows/emoji. The JSON body is full UTF-8.
  const headers = { "content-type": "application/json" };
  if (config.ntfyToken) headers.Authorization = `Bearer ${config.ntfyToken}`;

  const payload = {
    topic: config.ntfyTopic,
    title,
    message,
    priority: { min: 1, low: 2, default: 3, high: 4, urgent: 5 }[priority] ?? 3,
    tags: tags.split(","),
  };
  if (process.env.GITHUB_RUN_ID && process.env.GITHUB_REPOSITORY) {
    payload.click = `${process.env.GITHUB_SERVER_URL ?? "https://github.com"}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`;
  }

  const res = await fetch(config.ntfyServer, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  if (!res.ok) throw new Error(`ntfy returned HTTP ${res.status}: ${await res.text()}`);
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

function dedupeFlights(flights) {
  const seen = new Set();
  return flights.filter((flight) => {
    const key = `${flight.flightNumber}|${flight.origin}|${flight.destination}|${flight.departureDate}|${flight.cabins.map((c) => `${c.cabin}:${c.available}:${c.seats}:${c.points}`).join("|")}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
