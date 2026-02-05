const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function toTitleCase(sign) {
  if (!sign || typeof sign !== "string") return "";
  return sign.charAt(0).toUpperCase() + sign.slice(1).toLowerCase();
}

async function fetchJson(url, opts) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) {}

  if (!res.ok) {
    const msg = (json && (json.error || json.message)) || text || `Request failed (${res.status})`;
    throw new Error(msg);
  }
  return json;
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

    const ASTROAPI_KEY = process.env.ASTROAPI_KEY;
    const KIT_API_KEY = process.env.KIT_API_KEY;
    const KIT_TAG_MAP_JSON = process.env.KIT_TAG_MAP_JSON;

    if (!ASTROAPI_KEY) {
      return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: "Missing ASTROAPI_KEY env var" }) };
    }
    if (!KIT_API_KEY) {
      return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: "Missing KIT_API_KEY env var" }) };
    }
    if (!KIT_TAG_MAP_JSON) {
      return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: "Missing KIT_TAG_MAP_JSON env var" }) };
    }

    let tagMap;
    try {
      tagMap = JSON.parse(KIT_TAG_MAP_JSON);
    } catch {
      return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: "KIT_TAG_MAP_JSON is not valid JSON" }) };
    }

    const { firstName, email, dob, tob, birthplace, timezone } =
      JSON.parse(event.body || "{}");

    if (!email || !dob || !tob || !birthplace || !timezone) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({
          error: "Missing required fields",
          details: { email: !!email, dob: !!dob, tob: !!tob, birthplace: !!birthplace, timezone: !!timezone },
        }),
      };
    }

    // 1) Geocode birthplace → lat/lng (AstroAPI geocoding)
    const geoUrl = `https://api.astroapi.cloud/api/geocoding/search?q=${encodeURIComponent(birthplace)}&limit=1`;
    const geo = await fetchJson(geoUrl, {
      method: "GET",
      headers: { "X-Api-Key": ASTROAPI_KEY },
    });

    const place = geo?.data?.[0];
    if (!place?.latitude || !place?.longitude) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({
          error: "Could not find that birthplace. Try 'City, Country' (e.g., Melbourne, Australia).",
        }),
      };
    }

    // 2) Natal chart (Western astrology) — set Placidus explicitly
    const datetime = `${dob}T${tob}:00`;

    const natal = await fetchJson("https://api.astroapi.cloud/api/calc/natal", {
      method: "POST",
      headers: {
        "X-Api-Key": ASTROAPI_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        datetime,
        latitude: place.latitude,
        longitude: place.longitude,
        timezone,
        houseSystem: "placidus",
      }),
    });

    // AstroAPI response structure: natal.data.attributes...
    const attrs = natal?.data?.attributes || {};
    const planets = attrs?.planets || {};
    const houses = attrs?.houses || {};
    const aspects = attrs?.aspects || [];

    const sun = toTitleCase(planets?.sun?.sign);
    const moon = toTitleCase(planets?.moon?.sign);
    const rising = toTitleCase(houses?.["1"]?.sign);

    if (!sun || !moon || !rising) {
      return {
        statusCode: 500,
        headers: corsHeaders,
        body: JSON.stringify({
          error: "Natal chart calculated but could not extract Sun/Moon/Rising. Check AstroAPI response format.",
        }),
      };
    }

    // 3) Kit: create subscriber (v4)
    const sub = await fetchJson("https://api.kit.com/v4/subscribers", {
      method: "POST",
      headers: {
        "X-Kit-Api-Key": KIT_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        first_name: firstName || "",
        email_address: email,
        state: "active",
      }),
    });

    const subscriberId = sub?.subscriber?.id;
    if (!subscriberId) {
      return {
        statusCode: 500,
        headers: corsHeaders,
        body: JSON.stringify({ error: "Kit subscriber created but no subscriber ID returned." }),
      };
    }

    // 4) Tag subscriber (SUN/MOON/RISING)
    const tagKeys = [`SUN_${sun}`, `MOON_${moon}`, `RISING_${rising}`];

    for (const key of tagKeys) {
      const tagId = tagMap[key];
      if (!tagId) continue; // skip if not mapped
      await fetchJson(`https://api.kit.com/v4/tags/${tagId}/subscribers/${subscriberId}`, {
        method: "POST",
        headers: {
          "X-Kit-Api-Key": KIT_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      });
    }

    // 5) Return Big 3 + fuller chart object (for later use)
    // NOTE: This includes detailed birth-data-derived info. Only display what you intend to show publicly.
    const chart = {
      houseSystem: "placidus",
      datetime,
      timezone,
      location: {
        query: birthplace,
        name: place?.name || place?.displayName || birthplace,
        latitude: place.latitude,
        longitude: place.longitude,
      },
      planets,   // full planetary data
      houses,    // house cusps incl 1st house (Asc)
      aspects,   // aspects array (if provided by AstroAPI plan)
    };

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        ok: true,
        placements: { sun, moon, rising },
        chart,
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: err?.message || "Server error" }),
    };
  }
};