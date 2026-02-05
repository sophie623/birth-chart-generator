const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function basicAuth(userId, apiKey) {
  return "Basic " + Buffer.from(`${userId}:${apiKey}`).toString("base64");
}

async function astro(endpoint, auth, payload) {
  const res = await fetch(`https://json.astrologyapi.com/v1/${endpoint}`, {
    method: "POST",
    headers: {
      Authorization: auth,
      "Content-Type": "application/json",
      "Accept-Language": "en",
    },
    body: JSON.stringify(payload),
  });

  const text = await res.text();

  // Try to parse JSON if possible, but keep raw text for debugging
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}

  if (!res.ok) {
    // Include raw text so you see the real AstroAPI error in Netlify logs
    throw new Error(`AstrologyAPI ${endpoint} error: ${text}`);
  }

  return json;
}

function mmddyyyyFromIso(iso) {
  // iso: YYYY-MM-DD  ->  MM-DD-YYYY
  const [y, m, d] = String(iso).split("-");
  if (!y || !m || !d) throw new Error("dob must be YYYY-MM-DD");
  return `${m}-${d}-${y}`;
}

function parseDobTob(dob, tob) {
  const [y, m, d] = String(dob).split("-").map(Number);
  const [hh, mm] = String(tob).split(":").map(Number);
  if (![y, m, d, hh, mm].every(Number.isFinite)) {
    throw new Error("dob must be YYYY-MM-DD and tob must be HH:MM");
  }
  return { year: y, month: m, day: d, hour: hh, min: mm };
}

function titleCase(s) {
  if (!s || typeof s !== "string") return "";
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function getPlanetSign(planets, name) {
  const p = (planets || []).find((x) => x?.name === name);
  return titleCase(p?.sign);
}

function getRisingSignFromHouses(houseCusps) {
  const h1 = (houseCusps?.houses || []).find((h) => Number(h?.house) === 1);
  return titleCase(h1?.sign);
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

    const body = JSON.parse(event.body || "{}");
    const { firstName, email, dob, tob, birthplace } = body;

    if (!email || !dob || !tob || !birthplace) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ error: "Missing required fields (email, dob, tob, birthplace)" }),
      };
    }

    const { year, month, day, hour, min } = parseDobTob(dob, tob);
    const auth = basicAuth(ASTROLOGY_API_USER_ID, ASTROLOGY_API_KEY);

    // ---- GEO DETAILS with fallbacks ----
    const attempts = [
      String(birthplace).trim(),
      String(birthplace).split(",")[0].trim(),
      `${String(birthplace).split(",")[0].trim()}, Australia`,
    ];

    let geo = null;
    let lastGeoError = null;

    for (const place of attempts) {
      try {
        geo = await astro("geo_details", auth, { place, maxRows: 1 });
        if (geo?.geonames?.length) break;
      } catch (e) {
        lastGeoError = e;
      }
    }

    const g0 = geo?.geonames?.[0];
    const lat = Number(g0?.latitude);
    const lon = Number(g0?.longitude);

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      // Surface what we tried so you can debug quickly
      throw new Error(
        `Birthplace not found. Tried: ${attempts.join(" → ")}${lastGeoError ? " | " + lastGeoError.message : ""}`
      );
    }

    // ---- TIMEZONE WITH DST ----
    const tz = await astro("timezone_with_dst", auth, {
      latitude: lat,
      longitude: lon,
      date: mmddyyyyFromIso(dob),
    });

    const tzone = Number(tz?.timezone);
    if (!Number.isFinite(tzone)) {
      throw new Error("Timezone lookup failed (no timezone returned)");
    }

    // Base payload for chart endpoints
    const base = {
      day,
      month,
      year,
      hour,
      min,
      lat,
      lon,
      tzone,
      house_type: "placidus",
    };

    // ---- PLANETS + HOUSE CUSPS (authorised on Starter plan) ----
    const planets = await astro("planets/tropical", auth, base);
    const houseCusps = await astro("house_cusps/tropical", auth, base);

    const sun = getPlanetSign(planets, "Sun");
    const moon = getPlanetSign(planets, "Moon");
    const rising = getRisingSignFromHouses(houseCusps);

    if (!sun || !moon || !rising) {
      throw new Error("Could not extract Sun/Moon/Rising from AstrologyAPI responses");
    }

    // ---- KIT subscribe ----
    const kitSubRes = await fetch("https://api.kit.com/v4/subscribers", {
      method: "POST",
      headers: {
        "X-Kit-Api-Key": KIT_API_KEY,
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify({
        email_address: email,
        first_name: firstName || "",
        state: "active",
      }),
    });

    const kitText = await kitSubRes.text();
    let kitJson = null;
    try { kitJson = kitText ? JSON.parse(kitText) : null; } catch {}

    if (!kitSubRes.ok) {
      throw new Error(`Kit subscribe error: ${kitText}`);
    }

    const subscriberId = kitJson?.subscriber?.id;
    if (!subscriberId) {
      throw new Error(`Kit subscribe failed (no subscriber id). Response: ${kitText}`);
    }

    // ---- KIT tags ----
    const tagKeys = [`SUN_${sun}`, `MOON_${moon}`, `RISING_${rising}`];

    for (const key of tagKeys) {
      const tagId = tagMap?.[key];
      if (!tagId) continue;

      const tagRes = await fetch(`https://api.kit.com/v4/tags/${tagId}/subscribers/${subscriberId}`, {
        method: "POST",
        headers: { "X-Kit-Api-Key": KIT_API_KEY, "Accept": "application/json" },
      });

      if (!tagRes.ok) {
        const tagText = await tagRes.text();
        // Don’t hard-fail the entire request if tagging fails; just log details
        console.warn(`Kit tag failed for ${key} (${tagId}): ${tagText}`);
      }
    }

    // ✅ IMPORTANT: return chart data so Squarespace can list planet+house
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        ok: true,
        placements: { sun, moon, rising },
        chart: {
          planets,
          houseCusps,
          meta: { house_type: "placidus", lat, lon, tzone },
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