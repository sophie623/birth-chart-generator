// netlify/functions/generate-chart.js

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ---------------- Utilities ----------------

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
  return signs[Math.floor(d / 30)];
}

// ---------------- Geocoding ----------------

async function forwardGeocode(birthplace) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(birthplace)}`;

  const res = await fetch(url, {
    headers: {
      "User-Agent": "romance-and-the-stars-chart-tool/1.0"
    }
  });

  if (!res.ok) {
    throw new Error(`Geocode failed (${res.status})`);
  }

  const data = await res.json();

  if (!Array.isArray(data) || !data.length) {
    throw new Error("Birthplace not found. Try 'City, Country' (e.g. Melbourne, Australia).");
  }

  return {
    lat: Number(data[0].lat),
    lon: Number(data[0].lon)
  };
}

async function getTimezone(lat, lon) {
  const key = process.env.BDC_TIMEZONE_KEY;

  if (!key) {
    throw new Error("Missing BDC_TIMEZONE_KEY env var");
  }

  const url = `https://api-bdc.net/data/timezone-by-location?latitude=${lat}&longitude=${lon}&key=${key}`;

  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`Timezone lookup failed (${res.status})`);
  }

  const data = await res.json();

  const offsetSeconds =
    data?.localTimeOffset?.currentLocalTimeOffset ??
    data?.utcOffsetSeconds;

  if (typeof offsetSeconds !== "number") {
    throw new Error("Could not derive timezone.");
  }

  return offsetSeconds / 3600;
}

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

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: getAstroAuthHeader(),
      "Content-Type": "application/json",
      "Accept-Language": "en",
    },
    body: JSON.stringify({
      ...params,
      house_type: "placidus",
      is_asteroids: false
    }),
  });

  const json = await res.json().catch(() => ({}));

  if (!res.ok || json?.status === false) {
    throw new Error(`AstrologyAPI error: ${JSON.stringify(json)}`);
  }

  return json;
}

function getHouseFromCusps(deg, houses) {
  const p = normalizeDeg(deg);

  const cusps = houses
    .map(h => ({ house: Number(h.house), degree: normalizeDeg(h.degree) }))
    .sort((a, b) => a.house - b.house);

  for (let i = 0; i < cusps.length; i++) {

    const start = cusps[i].degree;
    const end = cusps[(i + 1) % cusps.length].degree;
    const houseNum = cusps[i].house;

    if (start <= end) {
      if (p >= start && p < end) return houseNum;
    } else {
      if (p >= start || p < end) return houseNum;
    }

  }

  return 1;
}

// ---------------- Kit helpers ----------------

async function kitCreateOrUpdateSubscriber({ email, firstName }) {

  const apiKey = process.env.KIT_API_KEY;

  if (!apiKey) {
    throw new Error("Missing KIT_API_KEY env var");
  }

  const res = await fetch("https://api.kit.com/v4/subscribers", {

    method: "POST",

    headers: {
      "X-Kit-Api-Key": apiKey,
      "Content-Type": "application/json",
      "Accept": "application/json",
    },

    body: JSON.stringify({
      email_address: email,
      first_name: firstName || "",
      state: "active",
    }),

  });

  const text = await res.text();

  let json = null;

  try {
    json = text ? JSON.parse(text) : null;
  } catch {}

  if (!res.ok) {
    throw new Error(`Kit subscribe error: ${text}`);
  }

  const subscriberId = json?.subscriber?.id;

  if (!subscriberId) {
    throw new Error(`Kit subscribe failed (no subscriber id). Response: ${text}`);
  }

  return subscriberId;
}

async function kitTagSubscriber({ subscriberId, tagId }) {

  const apiKey = process.env.KIT_API_KEY;

  if (!apiKey) {
    throw new Error("Missing KIT_API_KEY env var");
  }

  await fetch(

    `https://api.kit.com/v4/tags/${tagId}/subscribers/${subscriberId}`,

    {
      method: "POST",
      headers: {
        "X-Kit-Api-Key": apiKey,
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify({})
    }

  );
}

// ---------------- Main Handler ----------------

exports.handler = async (event) => {

  try {

    if (event.httpMethod === "OPTIONS") {
      return { statusCode: 204, headers: corsHeaders, body: "" };
    }

    const { firstName, email, dob, tob, birthplace } =
      JSON.parse(event.body || "{}");

    if (!email || !dob || !tob || !birthplace) {

      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ error: "Missing required fields" }),
      };

    }

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

    const planets = horoscope.planets || [];
    const houses = horoscope.houses || [];

    const getPlanet = name =>
      planets.find(p => p.name?.toLowerCase() === name.toLowerCase());

    const sun = getPlanet("Sun");
    const moon = getPlanet("Moon");
    const node = getPlanet("Node");
    const ascendant = getPlanet("Ascendant");

    const risingSign =
      ascendant?.sign ||
      degreeToSign(horoscope.ascendant);

    let southNode = null;

    if (node?.full_degree != null) {

      const southDeg = normalizeDeg(Number(node.full_degree) + 180);

      southNode = {
        name: "South Node",
        sign: degreeToSign(southDeg),
        house: getHouseFromCusps(southDeg, houses)
      };

    }

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

    // ---------------- Kit Subscriber ----------------

    const subscriberId = await kitCreateOrUpdateSubscriber({
      email,
      firstName,
    });

    let tagMap = {};

    try {
      tagMap = JSON.parse(process.env.KIT_TAG_MAP_JSON || "{}");
    } catch {}

    const sunKey = sun?.sign ? `SUN_${sun.sign}` : null;
    const moonKey = moon?.sign ? `MOON_${moon.sign}` : null;
    const risingKey = risingSign ? `RISING_${risingSign}` : null;

    const tagKeys = [sunKey, moonKey, risingKey].filter(Boolean);

    for (const key of tagKeys) {

      const tagId = tagMap[key];

      if (!tagId) continue;

      await kitTagSubscriber({
        subscriberId,
        tagId
      });

    }

    return {
      statusCode: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        placements: {
          big3: {
            sun: sun?.sign?.toLowerCase(),
            moon: moon?.sign?.toLowerCase(),
            rising: risingSign?.toLowerCase()
          },
          list: list
        }
      }),
    };

  }

  catch (err) {

    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({
        error: err.message || "Unknown error"
      }),
    };

  }

};