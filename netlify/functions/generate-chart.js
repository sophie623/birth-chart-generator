// netlify/functions/generate-chart.js

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function titleCase(s) {
  if (!s) return "";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function ordinal(n) {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function normalizeDeg(deg) {
  let d = Number(deg);
  while (d < 0) d += 360;
  while (d >= 360) d -= 360;
  return d;
}

function degreeToSign(deg) {
  const signs = [
    "Aries","Taurus","Gemini","Cancer","Leo","Virgo",
    "Libra","Scorpio","Sagittarius","Capricorn","Aquarius","Pisces"
  ];
  const d = normalizeDeg(deg);
  const idx = Math.floor(d / 30);
  return signs[idx];
}

/**
 * Given house cusps in full zodiac degrees (0..360), determine house for a point degree.
 * `houses` should be an array like [{house:1, degree:240.7}, ... {house:12, degree:216.5}]
 */
function getHouseFromCusps(pointDeg, houses) {
  const p = normalizeDeg(pointDeg);
  const cusps = houses
    .map(h => ({ house: Number(h.house), degree: normalizeDeg(h.degree) }))
    .sort((a, b) => a.house - b.house); // 1..12

  // Build segments from cusp i to cusp i+1 (wrapping)
  for (let i = 0; i < cusps.length; i++) {
    const start = cusps[i].degree;
    const end = cusps[(i + 1) % cusps.length].degree;
    const houseNum = cusps[i].house;

    // Normal segment (no wrap)
    if (start <= end) {
      if (p >= start && p < end) return houseNum;
    } else {
      // Wrap segment (e.g. 350 -> 20)
      if (p >= start || p < end) return houseNum;
    }
  }

  // Fallback
  return 1;
}

/**
 * AstrologyAPI Basic Auth:
 * - Either provide ASTROAPI_USER_ID + ASTROAPI_KEY
 * - Or provide ASTROAPI_KEY as "USERID:APIKEY"
 */
function getAstroAuth() {
  const userId = process.env.ASTROAPI_USER_ID || "";
  const apiKey = process.env.ASTROAPI_KEY || "";

  if (userId && apiKey && !apiKey.includes(":")) {
    const auth = Buffer.from(`${userId}:${apiKey}`).toString("base64");
    return `Basic ${auth}`;
  }

  // If they stored as "userId:apiKey" in ASTROAPI_KEY:
  if (apiKey.includes(":")) {
    const auth = Buffer.from(apiKey).toString("base64");
    return `Basic ${auth}`;
  }

  throw new Error("Missing AstrologyAPI credentials. Set ASTROAPI_USER_ID + ASTROAPI_KEY (or ASTROAPI_KEY as USERID:APIKEY).");
}

async function bdcGeocode(birthplace) {
  const key = process.env.BDC_TIMEZONE_KEY;
  if (!key) throw new Error("Missing BDC_TIMEZONE_KEY env var");

  const url = `https://api-bdc.net/data/geocode-city?city=${encodeURIComponent(
    birthplace
  )}&key=${encodeURIComponent(key)}&localityLanguage=en`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`BigDataCloud geocode failed (${res.status})`);
  const data = await res.json();

  // Heuristic: pick first result that has lat/lng
  const loc = (data?.data && data.data[0]) || data;
  const lat = loc?.latitude ?? loc?.lat;
  const lon = loc?.longitude ?? loc?.lng ?? loc?.lon;

  if (typeof lat !== "number" || typeof lon !== "number") {
    throw new Error("Birthplace not found. Try 'City, Country' (e.g. Melbourne, Australia).");
  }
  return { lat, lon };
}

async function bdcTimezone(lat, lon) {
  const key = process.env.BDC_TIMEZONE_KEY;
  if (!key) throw new Error("Missing BDC_TIMEZONE_KEY env var");

  const url = `https://api-bdc.net/data/timezone-by-location?latitude=${encodeURIComponent(
    lat
  )}&longitude=${encodeURIComponent(lon)}&key=${encodeURIComponent(key)}`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`BigDataCloud timezone failed (${res.status})`);
  const data = await res.json();

  // BigDataCloud returns offset in seconds; we convert to hours decimal (e.g., 11.0)
  const offsetSeconds =
    data?.localTimeOffset?.currentLocalTimeOffset ??
    data?.localTimeOffset?.localTimeOffset ??
    data?.utcOffsetSeconds ??
    null;

  if (typeof offsetSeconds !== "number") {
    throw new Error("Could not auto-derive timezone from birthplace.");
  }

  const tzone = offsetSeconds / 3600;
  return { tzone, timezoneId: data?.ianaTimeId || data?.timeZoneId || "" };
}

async function astrologyApiWesternHoroscope({ day, month, year, hour, min, lat, lon, tzone }) {
  const authHeader = getAstroAuth();

  const endpoint = "https://json.astrologyapi.com/v1/western_horoscope";
  const body = {
    day,
    month,
    year,
    hour,
    min,
    lat,
    lon,
    tzone,
    house_type: "placidus",
    // keep asteroids off for now; western_horoscope already includes Node/Chiron in planets list per docs
    is_asteroids: false,
  };

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: authHeader,
      "Content-Type": "application/json",
      "Accept-Language": "en",
    },
    body: JSON.stringify(body),
  });

  const json = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(`AstrologyAPI error (${res.status}): ${JSON.stringify(json)}`);
  }
  if (json?.status === false) {
    throw new Error(`AstrologyAPI error: ${JSON.stringify(json)}`);
  }

  return json;
}

function pickPlanet(planets, name) {
  return planets.find(p => (p?.name || "").toLowerCase() === name.toLowerCase());
}

function buildPlacements(westernHoroscopeJson) {
  const planets = Array.isArray(westernHoroscopeJson?.planets)
    ? westernHoroscopeJson.planets
    : [];

  const houses = Array.isArray(westernHoroscopeJson?.houses)
    ? westernHoroscopeJson.houses
    : [];

  // Big 3
  const sun = pickPlanet(planets, "Sun");
  const moon = pickPlanet(planets, "Moon");

  // Rising: AstrologyAPI may include Ascendant as planet OR provide `ascendant` numeric degree
  const ascPlanet = pickPlanet(planets, "Ascendant");
  const ascDeg =
    ascPlanet?.full_degree ??
    ascPlanet?.fullDegree ??
    westernHoroscopeJson?.ascendant ??
    null;

  const risingSign = ascPlanet?.sign || (ascDeg != null ? degreeToSign(ascDeg) : "");
  const risingHouse = 1; // by definition

  // Node / Chiron
  const node = pickPlanet(planets, "Node");     // North Node (per docs example)
  const chiron = pickPlanet(planets, "Chiron");

  // South Node = opposite point
  const nodeFullDeg = node?.full_degree ?? node?.fullDegree ?? null;
  const southDeg = nodeFullDeg != null ? normalizeDeg(Number(nodeFullDeg) + 180) : null;

  const southNode = southDeg != null
    ? {
        name: "South Node",
        full_degree: southDeg,
        sign: degreeToSign(southDeg),
        house: getHouseFromCusps(southDeg, houses),
      }
    : null;

  // Main list order (you can change this anytime)
  const order = [
    "Sun","Moon","Mercury","Venus","Mars","Jupiter","Saturn","Uranus","Neptune","Pluto",
    "Chiron","Node" // Node = North Node
  ];

  const list = [];

  for (const nm of order) {
    const p = pickPlanet(planets, nm);
    if (!p) continue;

    const sign = p.sign || "";
    const house = Number(p.house) || (p.full_degree != null ? getHouseFromCusps(p.full_degree, houses) : null);

    // Label Node nicely
    const label =
      nm === "Node" ? "North Node" : nm;

    list.push({
      name: label,
      sign,
      house,
    });
  }

  if (southNode) {
    list.push({
      name: "South Node",
      sign: southNode.sign,
      house: southNode.house,
    });
  }

  return {
    big3: {
      sun: (sun?.sign || "").toLowerCase(),
      moon: (moon?.sign || "").toLowerCase(),
      rising: (risingSign || "").toLowerCase(),
    },
    list, // array of {name, sign, house}
  };
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod === "OPTIONS") {
      return { statusCode: 204, headers: corsHeaders, body: "" };
    }
    if (event.httpMethod !== "POST") {
      return {
        statusCode: 405,
        headers: corsHeaders,
        body: JSON.stringify({ error: "Method not allowed" }),
      };
    }

    const { firstName, email, dob, tob, birthplace } = JSON.parse(event.body || "{}");

    if (!email || !dob || !tob || !birthplace) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ error: "Missing required fields" }),
      };
    }

    // Parse date + time
    const [yearStr, monthStr, dayStr] = String(dob).split("-");
    const [hourStr, minStr] = String(tob).split(":");

    const day = Number(dayStr);
    const month = Number(monthStr);
    const year = Number(yearStr);
    const hour = Number(hourStr);
    const min = Number(minStr);

    // Geocode + timezone from BigDataCloud
    const { lat, lon } = await bdcGeocode(birthplace);
    const { tzone } = await bdcTimezone(lat, lon);

    // AstrologyAPI western_horoscope (Placidus)
    const wh = await astrologyApiWesternHoroscope({ day, month, year, hour, min, lat, lon, tzone });

    const placements = buildPlacements(wh);

    // Return what Squarespace needs
    return {
      statusCode: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        ok: true,
        placements,
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: err?.message || "Unknown error" }),
    };
  }
};