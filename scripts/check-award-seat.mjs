const config = {
  seatsAeroApiKey: requiredEnv("SEATSAERO_API_KEY"),
  ntfyTopic: requiredEnv("NTFY_TOPIC"),
  ntfyServer: env("NTFY_SERVER", "https://ntfy.sh").replace(/\/$/, ""),
  ntfyToken: env("NTFY_TOKEN", ""),
  originAirport: env("ORIGIN_AIRPORT", "MEL").toUpperCase(),
  destinationAirport: env("DESTINATION_AIRPORT", "CGK").toUpperCase(),
  departureDate: env("DEPARTURE_DATE", "2026-08-21"),
  source: env("SOURCE", "qantas"),
  carrier: env("CARRIER", "QF").toUpperCase(),
  seatCount: numberEnv("SEAT_COUNT", 1),
  cabins: cabinList("CABINS", env("CABIN", "business,economy")),
  alertCabins: cabinList("ALERT_CABINS", "business"),
  onlyDirect: boolEnv("ONLY_DIRECT", true),
  useLiveSearch: boolEnv("USE_LIVE_SEARCH", false),
  notifyWhenEmpty: boolEnv("NOTIFY_WHEN_EMPTY", false),
};

try {
  const response = config.useLiveSearch
    ? await liveSearch(config)
    : await cachedSearch(config);

  const flights = findMatchingFlights(response, config);
  const alertFlights = flights.filter((flight) => hasAlertCabin(flight, config));

  if (alertFlights.length > 0) {
    const message = buildAvailabilityMessage(alertFlights, config);
    await publishNtfy({
      title: `${config.carrier} ${config.alertCabins.join("/")} award seat found`,
      message,
      priority: "urgent",
      tags: "airplane,tada",
    });
    console.log(message);
  } else {
    const message = flights.length > 0
      ? `${buildAvailabilityMessage(flights, config)}\nNo alert sent because ${config.alertCabins.join("/")} is not available.`
      : `No ${config.cabins.join("/")} ${config.carrier} award seats found for ${config.originAirport}-${config.destinationAirport} on ${config.departureDate}.`;
    console.log(message);

    if (config.notifyWhenEmpty) {
      await publishNtfy({
        title: "Award seat check complete",
        message,
        priority: "low",
        tags: "airplane",
      });
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

async function liveSearch(c) {
  return seatsAeroFetch("https://seats.aero/partnerapi/live", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      origin_airport: c.originAirport,
      destination_airport: c.destinationAirport,
      departure_date: c.departureDate,
      source: c.source,
      disable_filters: false,
      show_dynamic_pricing: false,
      seat_count: c.seatCount,
    }),
  });
}

async function cachedSearch(c) {
  const params = new URLSearchParams({
    origin_airport: c.originAirport,
    destination_airport: c.destinationAirport,
    start_date: c.departureDate,
    end_date: c.departureDate,
    take: "100",
    only_direct_flights: String(c.onlyDirect),
    carriers: c.carrier,
    sources: c.source,
    cabins: c.cabins.join(","),
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
  const flights = flattenObjects(payload)
    .filter((item) => hasRoute(item, c))
    .filter((item) => JSON.stringify(item).includes(c.departureDate))
    .filter((item) => JSON.stringify(item).toUpperCase().includes(c.carrier))
    .map((item) => summarizeFlight(item, c))
    .filter((flight) => flight.cabins.some((cabin) => cabin.available));

  return dedupeFlights(flights).slice(0, 10);
}

function summarizeFlight(item, c) {
  return {
    flightNumber: firstValue(item, ["FlightNumber", "flight_number", "Flight", "flight", "MarketingFlightNumber"]) ?? c.carrier,
    origin: firstValue(item, ["OriginAirport", "origin_airport", "Origin", "origin", "from"]) ?? c.originAirport,
    destination: firstValue(item, ["DestinationAirport", "destination_airport", "Destination", "destination", "to"]) ?? c.destinationAirport,
    departureDate: firstValue(item, ["DepartureDate", "departure_date", "Date", "date"]) ?? c.departureDate,
    cabins: c.cabins.map((cabin) => summarizeCabin(item, cabin, c.seatCount)),
  };
}

function summarizeCabin(item, cabin, minSeats) {
  const specs = getCabinSpecs();
  const spec = specs[cabin] ?? specs[cabin.toLowerCase()];
  if (!spec) return { cabin, available: false, seats: null, points: null };

  const availableValue = firstValue(item, spec.availableKeys);
  const seats = numericFirstValue(item, spec.seatKeys);
  const points = firstValue(item, spec.pointsKeys);
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
  return flight.cabins.some((cabin) => cabin.available && alertSet.has(normalizeCabinName(cabin.cabin)));
}

function buildAvailabilityMessage(flights, c) {
  const lines = [`${c.carrier} ${c.originAirport}-${c.destinationAirport} ${c.departureDate}`];

  for (const flight of flights) {
    lines.push(`${flight.flightNumber}:`);
    for (const cabin of flight.cabins) {
      const status = cabin.available ? "available" : "not available";
      const seats = cabin.available ? `, seats: ${cabin.seats ?? "not provided"}` : "";
      const points = cabin.points ? `, points: ${cabin.points}` : "";
      lines.push(`- ${cabin.cabin}: ${status}${seats}${points}`);
    }
  }

  return lines.join("\n");
}

async function publishNtfy({ title, message, priority, tags }) {
  const headers = { Title: title, Priority: priority, Tags: tags };
  if (config.ntfyToken) headers.Authorization = `Bearer ${config.ntfyToken}`;

  const res = await fetch(`${config.ntfyServer}/${encodeURIComponent(config.ntfyTopic)}`, {
    method: "POST",
    headers,
    body: message,
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

  return (origin === c.originAirport && destination === c.destinationAirport) || (route.includes(c.originAirport) && route.includes(c.destinationAirport));
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

function cabinList(name, fallback) {
  return env(name, fallback)
    .split(",")
    .map((cabin) => cabin.trim().toLowerCase())
    .filter(Boolean);
}

function normalizeCabinName(cabin) {
  return String(cabin).trim().toLowerCase();
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
