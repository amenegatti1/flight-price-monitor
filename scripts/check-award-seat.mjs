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
  cabin: env("CABIN", "").toLowerCase(),
  onlyDirect: boolEnv("ONLY_DIRECT", true),
  useLiveSearch: boolEnv("USE_LIVE_SEARCH", true),
  notifyWhenEmpty: boolEnv("NOTIFY_WHEN_EMPTY", false),
};

try {
  const response = config.useLiveSearch
    ? await liveSearch(config)
    : await cachedSearch(config);

  const matches = findMatches(response, config);

  if (matches.length > 0) {
    const message = buildFoundMessage(matches, config);
    await publishNtfy({
      title: "Qantas award seat found",
      message,
      priority: "urgent",
      tags: "airplane,tada",
    });
    console.log(message);
  } else {
    const message = `No matching ${config.carrier} award seat found for ${config.originAirport}-${config.destinationAirport} on ${config.departureDate}.`;
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
  const body = {
    origin_airport: c.originAirport,
    destination_airport: c.destinationAirport,
    departure_date: c.departureDate,
    source: c.source,
    disable_filters: false,
    show_dynamic_pricing: false,
    seat_count: c.seatCount,
  };

  return seatsAeroFetch("https://seats.aero/partnerapi/live", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
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
    include_trips: "true",
    minify_trips: "true",
  });

  if (c.cabin) params.set("cabins", c.cabin);

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
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    throw new Error(`Seats.aero returned HTTP ${res.status}: ${JSON.stringify(data).slice(0, 1000)}`);
  }

  return data;
}

function findMatches(payload, c) {
  const objects = flattenObjects(payload);

  return objects
    .filter((item) => hasRoute(item, c))
    .filter((item) => hasDepartureDate(item, c.departureDate))
    .filter((item) => hasCarrier(item, c.carrier))
    .filter((item) => !c.cabin || hasCabin(item, c.cabin))
    .filter((item) => hasSeatAvailability(item, c.seatCount))
    .slice(0, 10);
}

function flattenObjects(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);

  const current = Array.isArray(value) ? [] : [value];
  for (const child of Object.values(value)) {
    if (child && typeof child === "object") {
      current.push(...flattenObjects(child, seen));
    }
  }
  return current;
}

function hasRoute(item, c) {
  const origin = upperAny(item, ["origin_airport", "OriginAirport", "origin", "Origin", "from"]);
  const destination = upperAny(item, ["destination_airport", "DestinationAirport", "destination", "Destination", "to"]);
  const route = JSON.stringify(item).toUpperCase();

  return (
    (origin === c.originAirport && destination === c.destinationAirport) ||
    (route.includes(c.originAirport) && route.includes(c.destinationAirport))
  );
}

function hasDepartureDate(item, date) {
  const text = JSON.stringify(item);
  return text.includes(date);
}

function hasCarrier(item, carrier) {
  const text = JSON.stringify(item).toUpperCase();
  return text.includes(`"${carrier}"`) || text.includes(carrier);
}

function hasCabin(item, cabin) {
  const text = JSON.stringify(item).toLowerCase();
  return text.includes(cabin);
}

function hasSeatAvailability(item, minSeats) {
  const text = JSON.stringify(item).toLowerCase();
  const unavailableSignals = ["false", "\"available\":false", "\"available_seats\":0", "\"seat_count\":0"];
  const hasUnavailableSignal = unavailableSignals.some((signal) => text.includes(signal));
  const hasPositiveSeatCount = Object.entries(item).some(([key, value]) => {
    const normalizedKey = key.toLowerCase();
    return normalizedKey.includes("seat") && Number(value) >= minSeats;
  });

  return hasPositiveSeatCount || !hasUnavailableSignal;
}

function buildFoundMessage(matches, c) {
  const summaries = matches.map((match, index) => {
    const flightNumber = firstValue(match, ["flight_number", "FlightNumber", "flight", "Flight"]) ?? c.carrier;
    const cabin = (firstValue(match, ["cabin", "Cabin", "AvailableCabin", "available_cabin"]) ?? c.cabin) || "award";
    const seats = firstValue(match, ["seat_count", "SeatCount", "seats", "Seats", "available_seats"]) ?? "available";
    const mileage = firstValue(match, ["mileage", "Mileage", "points", "Points", "cost", "Cost"]);
    const cost = mileage ? `, ${mileage} points` : "";
    return `${index + 1}. ${flightNumber} ${c.originAirport}-${c.destinationAirport} ${c.departureDate}: ${seats} ${cabin} seat(s)${cost}`;
  });

  return summaries.join("\n");
}

async function publishNtfy({ title, message, priority, tags }) {
  const headers = {
    Title: title,
    Priority: priority,
    Tags: tags,
  };

  if (config.ntfyToken) {
    headers.Authorization = `Bearer ${config.ntfyToken}`;
  }

  const url = `${config.ntfyServer}/${encodeURIComponent(config.ntfyTopic)}`;
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: message,
  });

  if (!res.ok) {
    throw new Error(`ntfy returned HTTP ${res.status}: ${await res.text()}`);
  }
}

function env(name, fallback) {
  return process.env[name] === undefined || process.env[name] === "" ? fallback : process.env[name];
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}. Check the repository secret name.`);
  }
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

function upperAny(item, keys) {
  const value = firstValue(item, keys);
  return value === undefined ? undefined : String(value).toUpperCase();
}
