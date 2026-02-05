const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function basicAuthHeader(userId, apiKey) {
  return "Basic " + Buffer.from(`${userId}:${apiKey}`).toString("base64");
}

function toTitleCase(s) {
  if (!s || typeof s !== "string") return "";
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

async function fetchJson(url, { method = "POST", headers = {}, bodyObj } = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      ...headers,
      "Content-Type": "application/json",
    },
    body: bodyObj ? JSON.stringify(bodyObj) : undefined,
  });

  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }
  return json;
}

function formatMMDDYYYY(yyyyMmDd) {
  // input: YYYY-MM-DD
  const [y, m, d] = String(yyyyMmDd).split("-");
  if (!y || !m || !d) return "";
  return `${m}-${d}-${y}`; // mm-dd-yyyy (AstrologyAPI expects this)  [oai_citation:0‡astrologyapi.com](https://astrologyapi.com/docs/api-ref/92/timezone_with_dst)
}

function parseDobTob(dob, tob) {
  // dob: YYYY-MM-DD, tob: HH:MM
  const [yStr, mStr, dStr] = String(dob).split("-");
  const [hhStr, mmStr] = String(tob).split(":");
  const year = Number(yStr);
  const month = Number(mStr);
  const day = Number(dStr);
  const hour = Number(hhStr);
  const min = Number(mmStr);

  if (![year, month, day, hour, min].every((n) => Number.isFinite(n))) {
    throw new Error("dob must be YYYY-MM-DD and tob must be HH:MM");
  }
  return { year, month, day, hour, min };
}

function getPlanetSign(planetsArray, planetName) {
  const p = (planetsArray || []).find((x) => x?.name === planetName);
  return toTitleCase(p?.sign);
}

function getRisingSignFromHouses(houseCuspsResponse) {
  // house_cusps/tropical response has "houses": [{house:1, sign:"Cancer", degree:...}, ...]  [oai_citation:1‡astrologyapi.com](https://www.astrologyapi.com/western-api-docs/api-ref/123/house_cusps/tropical)
  const h1 = (houseCuspsResponse?.houses || []).find((h) => Number(h?.house) === 1);
  return toTitleCase(h1?.sign);
}

exports.handler = async (event) => {
  try {
    // CORS preflight
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

    // ENV VARS
    const ASTROLOGY_API_USER_ID = process.env.ASTROLOGY_API_USER_ID;
    const ASTROLOGY_API_KEY = process.env.ASTROLOGY_API_KEY;

    const KIT_API_KEY = process.env.KIT_API_KEY;
    const KIT_TAG_MAP_JSON = process.env.KIT_TAG_MAP_JSON;

    if (!ASTROLOGY_API_USER_ID) throw new Error("Missing ASTROLOGY_API_USER_ID env var");
    if (!ASTROLOGY_API_KEY) throw new Error("Missing ASTROLOGY_API_KEY env var");
    if (!KIT_API_KEY) throw new Error("Missing KIT_API_KEY env var");
    if (!KIT_TAG_MAP_JSON) throw new Error("Missing KIT_TAG_MAP_JSON env var");

    let tagMap;
    try {
      tagMap = JSON.parse(KIT_TAG_MAP_JSON);
    } catch {
      throw new Error("KIT_TAG_MAP_JSON is not valid JSON (check commas/quotes)");
    }

    // BODY
    const body = JSON.parse(event.body || "{}");
    const { firstName, email, dob, tob, birthplace } = body;

    if (!email || !dob || !tob || !birthplace) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({
          error: "Missing required fields (email, dob, tob, birthplace)",
        }),
      };
    }

    const { year, month, day, hour, min } = parseDobTob(dob, tob);

    // AUTH for astrologyapi.com
    const auth = basicAuthHeader(ASTROLOGY_API_USER_ID, ASTROLOGY_API_KEY);

    // 1) GEO DETAILS (birthplace -> lat/lon)
    async function lookupGeo(place) {
  return fetchJson("https://json.astrologyapi.com/v1/geo_details", {
    headers: { Authorization: auth, "Accept-Language": "en" },
    bodyObj: { place, maxRows: 1 },
  });
}

let geo;
let geoPlaceTried = [];

// 1) Try exactly as entered
try {
  geo = await lookupGeo(birthplace);
  geoPlaceTried.push(birthplace);
} catch {}

// 2) Try city only (before comma)
if (!geo?.geonames?.length) {
  const cityOnly = birthplace.split(",")[0].trim();
  try {
    geo = await lookupGeo(cityOnly);
    geoPlaceTried.push(cityOnly);
  } catch {}
}

// 3) Try city + Australia
if (!geo?.geonames?.length) {
  const cityOnly = birthplace.split(",")[0].trim();
  const ausFallback = `${cityOnly}, Australia`;
  try {
    geo = await lookupGeo(ausFallback);
    geoPlaceTried.push(ausFallback);
  } catch {}
}

const g0 = geo?.geonames?.[0];
const lat = Number(g0?.latitude);
const lon = Number(g0?.longitude);

if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
  throw new Error(
    `Birthplace not found. Tried: ${geoPlaceTried.join(" → ")}`
  );
} //  [oai_citation:2‡astrologyapi.com](https://astrologyapi.com/docs/api-ref/1/geo_details?utm_source=chatgpt.com)

    const g0 = geo?.geonames?.[0];
    const lat = Number(g0?.latitude);
    const lon = Number(g0?.longitude);

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({
          error: "Birthplace not found. Try 'City, Country' (e.g. Melbourne, Australia).",
        }),
      };
    }

    // 2) TIMEZONE WITH DST (date must be mm-dd-yyyy)
    const tz = await fetchJson("https://json.astrologyapi.com/v1/timezone_with_dst", {
      headers: { Authorization: auth, "Accept-Language": "en" },
      bodyObj: {
        latitude: lat,
        longitude: lon,
        date: formatMMDDYYYY(dob),
      },
    }); //  [oai_citation:3‡astrologyapi.com](https://astrologyapi.com/docs/api-ref/92/timezone_with_dst)

    const tzone = Number(tz?.timezone);
    if (!Number.isFinite(tzone)) {
      throw new Error("Timezone lookup failed (no timezone returned)");
    }

    const basePayload = {
      day,
      month,
      year,
      hour,
      min,
      lat,
      lon,
      tzone,
      house_type: "placidus", // default is placidus, set explicitly  [oai_citation:4‡astrologyapi.com](https://www.astrologyapi.com/western-api-docs/api-ref/74/planets/tropical)
    };

    // 3) PLANETS (tropical) -> Sun/Moon signs + full planet list
    const planets = await fetchJson("https://json.astrologyapi.com/v1/planets/tropical", {
      headers: { Authorization: auth, "Accept-Language": "en" },
      bodyObj: basePayload,
    }); //  [oai_citation:5‡astrologyapi.com](https://www.astrologyapi.com/western-api-docs/api-ref/74/planets/tropical)

    // 4) HOUSE CUSPS (tropical) -> Rising sign + house cusps
    const houseCusps = await fetchJson("https://json.astrologyapi.com/v1/house_cusps/tropical", {
      headers: { Authorization: auth, "Accept-Language": "en" },
      bodyObj: basePayload,
    }); //  [oai_citation:6‡astrologyapi.com](https://www.astrologyapi.com/western-api-docs/api-ref/123/house_cusps/tropical)

    const sun = getPlanetSign(planets, "Sun");
    const moon = getPlanetSign(planets, "Moon");
    const rising = getRisingSignFromHouses(houseCusps);

    if (!sun || !moon || !rising) {
      throw new Error("Could not extract Sun/Moon/Rising from AstrologyAPI responses");
    }

    // 5) KIT subscribe
    const kitSub = await fetchJson("https://api.kit.com/v4/subscribers", {
      method: "POST",
      headers: {
        "X-Kit-Api-Key": KIT_API_KEY,
        "Accept": "application/json",
      },
      bodyObj: {
        email_address: email,
        first_name: firstName || "",
        state: "active",
      },
    });

    const subscriberId = kitSub?.subscriber?.id;
    if (!subscriberId) throw new Error("Kit subscribe failed (no subscriber id returned)");

    // 6) KIT tags (SUN_*, MOON_*, RISING_*)
    const keys = [`SUN_${sun}`, `MOON_${moon}`, `RISING_${rising}`];

    for (const k of keys) {
      const tagId = tagMap?.[k];
      if (!tagId) continue;

      await fetchJson(`https://api.kit.com/v4/tags/${tagId}/subscribers/${subscriberId}`, {
        method: "POST",
        headers: {
          "X-Kit-Api-Key": KIT_API_KEY,
          "Accept": "application/json",
        },
        bodyObj: {}, // Kit accepts empty JSON for this call
      });
    }

    // Return full chart object for later use
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        ok: true,
        placements: { sun, moon, rising },
        chart: {
          geo: g0,
          timezone: tz,
          planets,
          houseCusps,
          meta: { house_type: "placidus" },
        },
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({
        error: err?.message || "Unknown error",
      }),
    };
  }
};