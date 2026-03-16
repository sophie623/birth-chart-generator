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
// ---------------- Utilities ----------------

function normalizeDeg(deg) {
let d = Number(deg);
@@ -30,255 +21,138 @@ function degreeToSign(deg) {
"Libra","Scorpio","Sagittarius","Capricorn","Aquarius","Pisces"
];
const d = normalizeDeg(deg);
  const idx = Math.floor(d / 30);
  return signs[idx];
  return signs[Math.floor(d / 30)];
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
function ordinal(n) {
  const s = ["th","st","nd","rd"], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

  // Build segments from cusp i to cusp i+1 (wrapping)
  for (let i = 0; i < cusps.length; i++) {
    const start = cusps[i].degree;
    const end = cusps[(i + 1) % cusps.length].degree;
    const houseNum = cusps[i].house;
// ---------------- Geocoding ----------------

    // Normal segment (no wrap)
    if (start <= end) {
      if (p >= start && p < end) return houseNum;
    } else {
      // Wrap segment (e.g. 350 -> 20)
      if (p >= start || p < end) return houseNum;
    }
  }
// Forward geocode (City → lat/lon)
async function forwardGeocode(birthplace) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(birthplace)}`;

  // Fallback
  return 1;
}
  const res = await fetch(url, {
    headers: {
      "User-Agent": "romance-and-the-stars-chart-tool/1.0"
    }
  });

/**
 * AstrologyAPI Basic Auth:
 * - Either provide ASTROAPI_USER_ID + ASTROAPI_KEY
 * - Or provide ASTROAPI_KEY as "USERID:APIKEY"
 */
function getAstroAuthHeader(){

  const userId=process.env.ASTROLOGY_API_USER_ID;
  const apiKey=process.env.ASTROLOGY_API_KEY;

  const auth = Buffer.from(`${userId}:${apiKey}`).toString("base64");

  return `Basic ${auth}`;

}
  if (!res.ok) {
    throw new Error(`Geocode failed (${res.status})`);
}

  // If they stored as "userId:apiKey" in ASTROAPI_KEY:
  if (apiKey.includes(":")) {
    const auth = Buffer.from(apiKey).toString("base64");
    return `Basic ${auth}`;
  const data = await res.json();
  if (!Array.isArray(data) || !data.length) {
    throw new Error("Birthplace not found. Try 'City, Country' (e.g. Melbourne, Australia).");
}

  throw new Error("Missing AstrologyAPI credentials. Set ASTROAPI_USER_ID + ASTROAPI_KEY (or ASTROAPI_KEY as USERID:APIKEY).");
  return {
    lat: Number(data[0].lat),
    lon: Number(data[0].lon)
  };
}

async function bdcGeocode(birthplace) {
// Timezone from lat/lon
async function getTimezone(lat, lon) {
const key = process.env.BDC_TIMEZONE_KEY;
if (!key) throw new Error("Missing BDC_TIMEZONE_KEY env var");

  const url = `https://api-bdc.net/data/geocode-city?city=${encodeURIComponent(
    birthplace
  )}&key=${encodeURIComponent(key)}&localityLanguage=en`;

  const url = `https://api-bdc.net/data/timezone-by-location?latitude=${lat}&longitude=${lon}&key=${key}`;
const res = await fetch(url);
  if (!res.ok) throw new Error(`BigDataCloud geocode failed (${res.status})`);
  const data = await res.json();

  // Heuristic: pick first result that has lat/lng
  const loc = (data?.data && data.data[0]) || data;
  const lat = loc?.latitude ?? loc?.lat;
  const lon = loc?.longitude ?? loc?.lng ?? loc?.lon;

  if (typeof lat !== "number" || typeof lon !== "number") {
    throw new Error("Birthplace not found. Try 'City, Country' (e.g. Melbourne, Australia).");
  if (!res.ok) {
    throw new Error(`Timezone lookup failed (${res.status})`);
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
    data?.utcOffsetSeconds;

if (typeof offsetSeconds !== "number") {
    throw new Error("Could not auto-derive timezone from birthplace.");
    throw new Error("Could not derive timezone.");
}

  const tzone = offsetSeconds / 3600;
  return { tzone, timezoneId: data?.ianaTimeId || data?.timeZoneId || "" };
  return offsetSeconds / 3600;
}

async function astrologyApiWesternHoroscope({ day, month, year, hour, min, lat, lon, tzone }) {
  const authHeader = getAstroAuth();
// ---------------- Astrology API ----------------

function getAstroAuthHeader() {
  const userId = process.env.ASTROAPI_USER_ID;
  const apiKey = process.env.ASTROAPI_KEY;

  if (!userId || !apiKey) {
    throw new Error("Missing ASTROAPI_USER_ID or ASTROAPI_KEY env var");
  }

  const auth = Buffer.from(`${userId}:${apiKey}`).toString("base64");
  return `Basic ${auth}`;
}

async function fetchWesternHoroscope(params) {
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
      authorization: getAstroAuthHeader(),
"Content-Type": "application/json",
"Accept-Language": "en",
},
    body: JSON.stringify(body),
    body: JSON.stringify({
      ...params,
      house_type: "placidus",
      is_asteroids: false
    }),
});

const json = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(`AstrologyAPI error (${res.status}): ${JSON.stringify(json)}`);
  }
  if (json?.status === false) {
  if (!res.ok || json?.status === false) {
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
// Determine house from cusp array
function getHouseFromCusps(deg, houses) {
  const p = normalizeDeg(deg);

    const sign = p.sign || "";
    const house = Number(p.house) || (p.full_degree != null ? getHouseFromCusps(p.full_degree, houses) : null);

    // Label Node nicely
    const label =
      nm === "Node" ? "North Node" : nm;
  const cusps = houses
    .map(h => ({ house: Number(h.house), degree: normalizeDeg(h.degree) }))
    .sort((a, b) => a.house - b.house);

    list.push({
      name: label,
      sign,
      house,
    });
  }
  for (let i = 0; i < cusps.length; i++) {
    const start = cusps[i].degree;
    const end = cusps[(i + 1) % cusps.length].degree;
    const houseNum = cusps[i].house;

  if (southNode) {
    list.push({
      name: "South Node",
      sign: southNode.sign,
      house: southNode.house,
    });
    if (start <= end) {
      if (p >= start && p < end) return houseNum;
    } else {
      if (p >= start || p < end) return houseNum;
    }
}

  return {
    big3: {
      sun: (sun?.sign || "").toLowerCase(),
      moon: (moon?.sign || "").toLowerCase(),
      rising: (risingSign || "").toLowerCase(),
    },
    list, // array of {name, sign, house}
  };
  return 1;
}

// ---------------- Main Handler ----------------

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
    const { firstName, email, dob, tob, birthplace } =
      JSON.parse(event.body || "{}");

if (!email || !dob || !tob || !birthplace) {
return {
@@ -288,39 +162,93 @@ exports.handler = async (event) => {
};
}

    // Parse date + time
    const [yearStr, monthStr, dayStr] = String(dob).split("-");
    const [hourStr, minStr] = String(tob).split(":");
    const [year, month, day] = dob.split("-").map(Number);
    const [hour, min] = tob.split(":").map(Number);

    const { lat, lon } = await forwardGeocode(birthplace);
    const tzone = await getTimezone(lat, lon);

    const horoscope = await fetchWesternHoroscope({
      day,
      month,
      year,
      hour,
      min,
      lat,
      lon,
      tzone,
    });

    const day = Number(dayStr);
    const month = Number(monthStr);
    const year = Number(yearStr);
    const hour = Number(hourStr);
    const min = Number(minStr);
    const planets = horoscope.planets || [];
    const houses = horoscope.houses || [];

    // Geocode + timezone from BigDataCloud
    const { lat, lon } = await bdcGeocode(birthplace);
    const { tzone } = await bdcTimezone(lat, lon);
    const getPlanet = name =>
      planets.find(p => p.name?.toLowerCase() === name.toLowerCase());

    // AstrologyAPI western_horoscope (Placidus)
    const wh = await astrologyApiWesternHoroscope({ day, month, year, hour, min, lat, lon, tzone });
    const sun = getPlanet("Sun");
    const moon = getPlanet("Moon");
    const node = getPlanet("Node");   // North Node
    const chiron = getPlanet("Chiron");
    const ascendant = getPlanet("Ascendant");

    const placements = buildPlacements(wh);
    const risingSign =
      ascendant?.sign ||
      degreeToSign(horoscope.ascendant);

    // Calculate South Node (opposite of North Node)
    let southNode = null;
    if (node?.full_degree != null) {
      const southDeg = normalizeDeg(Number(node.full_degree) + 180);
      southNode = {
        name: "South Node",
        sign: degreeToSign(southDeg),
        house: getHouseFromCusps(southDeg, houses)
      };
    }

    // Build full list
    const orderedNames = [
      "Sun","Moon","Mercury","Venus","Mars","Jupiter","Saturn",
      "Uranus","Neptune","Pluto","Chiron","Node"
    ];

    const list = [];

    for (const name of orderedNames) {
      const p = getPlanet(name);
      if (!p) continue;

      const label = name === "Node" ? "North Node" : name;

      list.push({
        name: label,
        sign: p.sign,
        house: p.house || getHouseFromCusps(p.full_degree, houses)
      });
    }

    if (southNode) list.push(southNode);

    // Return what Squarespace needs
return {
statusCode: 200,
headers: { ...corsHeaders, "Content-Type": "application/json" },
body: JSON.stringify({
        ok: true,
        placements,
        placements: {
          big3: {
            sun: sun?.sign?.toLowerCase(),
            moon: moon?.sign?.toLowerCase(),
            rising: risingSign?.toLowerCase()
          },
          list
        }
}),
};

} catch (err) {
return {
statusCode: 500,
headers: corsHeaders,
      body: JSON.stringify({ error: err?.message || "Unknown error" }),
      body: JSON.stringify({ error: err.message || "Unknown error" }),
};
}
};