const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ---------- helpers ----------
function toTitleCase(s) {
  if (!s || typeof s !== "string") return "";
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

async function fetchText(url, opts = {}) {
  const res = await fetch(url, opts);
  const text = await res.text();
  return { res, text };
}

function basicAuthHeader(userId, apiKey) {
  return (
    "Basic " +
    Buffer.from(`${userId}:${apiKey}`).toString("base64")
  );
}

// ---------- handler ----------
exports.handler = async (event) => {
  try {
    // CORS
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
    const {
      ASTROLOGY_API_USER_ID,
      ASTROLOGY_API_KEY,
      BDC_TIMEZONE_KEY,
      KIT_API_KEY,
      KIT_TAG_MAP_JSON,
    } = process.env;

    if (!ASTROLOGY_API_USER_ID) throw new Error("Missing ASTROLOGY_API_USER_ID");
    if (!ASTROLOGY_API_KEY) throw new Error("Missing ASTROLOGY_API_KEY");
    if (!BDC_TIMEZONE_KEY) throw new Error("Missing BDC_TIMEZONE_KEY");
    if (!KIT_API_KEY) throw new Error("Missing KIT_API_KEY");
    if (!KIT_TAG_MAP_JSON) throw new Error("Missing KIT_TAG_MAP_JSON");

    const tagMap = JSON.parse(KIT_TAG_MAP_JSON);

    // BODY
    const { firstName, email, dob, tob, birthplace } = JSON.parse(event.body || "{}");
    if (!email || !dob || !tob || !birthplace) {
      throw new Error("Missing required fields");
    }

    // Parse date/time
    const [year, month, day] = dob.split("-").map(Number);
    const [hour, min] = tob.split(":").map(Number);

    // ---------- 1) GEOCODE (Nominatim) ----------
    const geoUrl =
      `https://nominatim.openstreetmap.org/search` +
      `?q=${encodeURIComponent(birthplace)}` +
      `&format=json&limit=1`;

    const { res: geoRes, text: geoText } = await fetchText(geoUrl, {
      headers: {
        "User-Agent": "SophieMaxwell-Astrology/1.0 (iceandthestars.com)",
      },
    });

    if (!geoRes.ok) throw new Error("Geocoding failed");

    const geo = JSON.parse(geoText)[0];
    if (!geo) throw new Error("Birthplace not found");

    const lat = Number(geo.lat);
    const lon = Number(geo.lon);

    // ---------- 2) TIMEZONE (BigDataCloud) ----------
    const tzUrl =
      `https://api-bdc.net/data/timezone-by-location` +
      `?latitude=${lat}&longitude=${lon}&key=${BDC_TIMEZONE_KEY}`;

    const { res: tzRes, text: tzText } = await fetchText(tzUrl);
    if (!tzRes.ok) throw new Error("Timezone lookup failed");

    const tz = JSON.parse(tzText);
    const timeZoneId = tz.ianaTimeId;
    if (!timeZoneId) throw new Error("Timezone not resolved");

    // ---------- 3) UTC OFFSET AT BIRTH ----------
    const utcGuess = Math.floor(Date.UTC(year, month - 1, day, hour, min) / 1000);

    const tzInfoUrl =
      `https://api-bdc.net/data/timezone-info` +
      `?timeZoneId=${encodeURIComponent(timeZoneId)}` +
      `&utcReference=${utcGuess}` +
      `&key=${BDC_TIMEZONE_KEY}`;

    const { res: tzInfoRes, text: tzInfoText } = await fetchText(tzInfoUrl);
    if (!tzInfoRes.ok) throw new Error("Timezone offset failed");

    const offsetSeconds = JSON.parse(tzInfoText).utcOffsetSeconds;
    const tzone = offsetSeconds / 3600;

    // ---------- 4) ASTROLOGYAPI (WESTERN / PLACIDUS) ----------
    const auth = basicAuthHeader(
      ASTROLOGY_API_USER_ID,
      ASTROLOGY_API_KEY
    );

    const astrologyRes = await fetch(
      "https://json.astrologyapi.com/v1/western_chart_data",
      {
        method: "POST",
        headers: {
          Authorization: auth,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          day,
          month,
          year,
          hour,
          min,
          lat,
          lon,
          tzone,
          house_type: "placidus",
        }),
      }
    );

    const astrologyText = await astrologyRes.text();
    if (!astrologyRes.ok) {
      throw new Error(`AstrologyAPI error: ${astrologyText}`);
    }

    const natal = JSON.parse(astrologyText);

    // ---------- 5) EXTRACT BIG 3 ----------
    const sun = toTitleCase(natal.planets?.Sun?.sign);
    const moon = toTitleCase(natal.planets?.Moon?.sign);
    const rising = toTitleCase(natal.houses?.["1"]?.sign);

    if (!sun || !moon || !rising) {
      throw new Error("Could not extract Sun / Moon / Rising");
    }

    // ---------- 6) KIT SUBSCRIBE ----------
    const kitRes = await fetch("https://api.kit.com/v4/subscribers", {
      method: "POST",
      headers: {
        "X-Kit-Api-Key": KIT_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email_address: email,
        first_name: firstName || "",
        state: "active",
      }),
    });

    const kitText = await kitRes.text();
    if (!kitRes.ok) throw new Error(`Kit error: ${kitText}`);

    const subscriberId = JSON.parse(kitText).subscriber.id;

    // ---------- 7) TAG ----------
    for (const key of [`SUN_${sun}`, `MOON_${moon}`, `RISING_${rising}`]) {
      const tagId = tagMap[key];
      if (!tagId) continue;

      await fetch(
        `https://api.kit.com/v4/tags/${tagId}/subscribers/${subscriberId}`,
        {
          method: "POST",
          headers: {
            "X-Kit-Api-Key": KIT_API_KEY,
            "Content-Type": "application/json",
          },
          body: "{}",
        }
      );
    }

    // ---------- DONE ----------
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        ok: true,
        placements: { sun, moon, rising },
        chart: natal,
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: err.message }),
    };
  }
};