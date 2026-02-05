const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function toTitleCase(sign) {
  if (!sign || typeof sign !== "string") return "";
  return sign.charAt(0).toUpperCase() + sign.slice(1).toLowerCase();
}

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (_) {
    // not JSON
  }

  if (!res.ok) {
    const msg =
      (json && (json.error || json.message)) ||
      text ||
      `Request failed (${res.status})`;
    const err = new Error(msg);
    err.status = res.status;
    err.raw = json || text;
    throw err;
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

    // Env vars
    const ASTROAPI_KEY = process.env.ASTROAPI_KEY;
    const KIT_API_KEY = process.env.KIT_API_KEY;
    const KIT_TAG_MAP_JSON = process.env.KIT_TAG_MAP_JSON;
    const BDC_TIMEZONE_KEY = process.env.BDC_TIMEZONE_KEY;

    if (!ASTROAPI_KEY) {
      return {
        statusCode: 500,
        headers: corsHeaders,
        body: JSON.stringify({ error: "Missing ASTROAPI_KEY env var" }),
      };
    }
    if (!KIT_API_KEY) {
      return {
        statusCode: 500,
        headers: corsHeaders,
        body: JSON.stringify({ error: "Missing KIT_API_KEY env var" }),
      };
    }
    if (!KIT_TAG_MAP_JSON) {
      return {
        statusCode: 500,
        headers: corsHeaders,
        body: JSON.stringify({ error: "Missing KIT_TAG_MAP_JSON env var" }),
      };
    }
    if (!BDC_TIMEZONE_KEY) {
      return {
        statusCode: 500,
        headers: corsHeaders,
        body: JSON.stringify({ error: "Missing BDC_TIMEZONE_KEY env var" }),
      };
    }

    let tagMap;
    try {
      tagMap = JSON.parse(KIT_TAG_MAP_JSON);
    } catch {
      return {
        statusCode: 500,
        headers: corsHeaders,
        body: JSON.stringify({ error: "KIT_TAG_MAP_JSON is not valid JSON" }),
      };
    }

    // Parse request body (timezone NOT required anymore)
    const { firstName, email, dob, tob, birthplace } = JSON.parse(
      event.body || "{}"
    );

    if (!email || !dob || !tob || !birthplace) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({
          error: "Missing required fields",
          details: {
            email: !!email,
            dob: !!dob,
            tob: !!tob,
            birthplace: !!birthplace,
          },
        }),
      };
    }

    // 1) AstroAPI geocode birthplace -> lat/lng
    const geoUrl = `https://api.astroapi.cloud/api/geocoding/search?q=${encodeURIComponent(
      birthplace
    )}&limit=1`;

    let geo;
    try {
      geo = await fetchJson(geoUrl, {
        method: "GET",
        headers: { "X-Api-Key": ASTROAPI_KEY },
      });
    } catch (e) {
      // This is where you'd see "Unauthorized" if ASTROAPI_KEY is wrong
      throw new Error(`AstroAPI geocode: ${e.message}`);
    }

    const place = geo?.data?.[0];
    if (!place?.latitude || !place?.longitude) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({
          error:
            "Could not find that birthplace. Try 'City, Country' (e.g., Melbourne, Australia).",
        }),
      };
    }

    // 2) BigDataCloud timezone lookup -> ianaTimeId
    const tzUrl =
      `https://api-bdc.net/data/timezone-by-location?latitude=${encodeURIComponent(
        place.latitude
      )}` +
      `&longitude=${encodeURIComponent(place.longitude)}` +
      `&key=${encodeURIComponent(BDC_TIMEZONE_KEY)}`;

    let tz;
    try {
      tz = await fetchJson(tzUrl, { method: "GET" });
    } catch (e) {
      // This is where you'd see "Unauthorized" if BDC_TIMEZONE_KEY is wrong
      throw new Error(`BigDataCloud timezone: ${e.message}`);
    }

    const timezone = tz?.ianaTimeId;
    if (!timezone) {
      return {
        statusCode: 500,
        headers: corsHeaders,
        body: JSON.stringify({
          error: "Could not resolve timezone from location.",
          details: tz || null,
        }),
      };
    }

    // 3) AstroAPI natal chart (Placidus)
    const datetime = `${dob}T${tob}:00`;

    let natal;
    try {
      natal = await fetchJson("https://api.astroapi.cloud/api/calc/natal", {
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
    } catch (e) {
      throw new Error(`AstroAPI natal: ${e.message}`);
    }

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
          error: "Chart calculated but could not extract Sun/Moon/Rising.",
          details: { sun, moon, rising },
        }),
      };
    }

    // 4) Kit create subscriber
    let sub;
    try {
      sub = await fetchJson("https://api.kit.com/v4/subscribers", {
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
    } catch (e) {
      // This is where you'd see "Unauthorized" if KIT_API_KEY is wrong / wrong key type
      throw new Error(`Kit create subscriber: ${e.message}`);
    }

    const subscriberId = sub?.subscriber?.id;
    if (!subscriberId) {
      return {
        statusCode: 500,
        headers: corsHeaders,
        body: JSON.stringify({
          error: "Kit subscriber created but no subscriber ID returned.",
          details: sub || null,
        }),
      };
    }

    // 5) Apply tags (Sun/Moon/Rising)
    const tagKeys = [`SUN_${sun}`, `MOON_${moon}`, `RISING_${rising}`];

    for (const key of tagKeys) {
      const tagId = tagMap[key];
      if (!tagId) continue; // skip if mapping missing

      try {
        await fetchJson(
          `https://api.kit.com/v4/tags/${tagId}/subscribers/${subscriberId}`,
          {
            method: "POST",
            headers: {
              "X-Kit-Api-Key": KIT_API_KEY,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({}),
          }
        );
      } catch (e) {
        throw new Error(`Kit tag (${key}): ${e.message}`);
      }
    }

    // 6) Return Big 3 + fuller chart object (for later use)
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        ok: true,
        placements: { sun, moon, rising },
        chart: {
          houseSystem: "placidus",
          datetime,
          timezone,
          location: {
            query: birthplace,
            displayName: place?.displayName || place?.name || birthplace,
            latitude: place.latitude,
            longitude: place.longitude,
          },
          planets,
          houses,
          aspects,
        },
      }),
    };
  } catch (err) {
    // If we hit Unauthorized again, you will now see WHICH service caused it.
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({
        error: err?.message || "Server error",
      }),
    };
  }
};