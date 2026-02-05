const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function authHeader() {
  return (
    "Basic " +
    Buffer.from(
      `${process.env.ASTROLOGY_API_USER_ID}:${process.env.ASTROLOGY_API_KEY}`
    ).toString("base64")
  );
}

async function callAstroAPI(endpoint, payload) {
  const res = await fetch(`https://json.astrologyapi.com/v1/${endpoint}`, {
    method: "POST",
    headers: {
      Authorization: authHeader(),
      "Content-Type": "application/json",
      "Accept-Language": "en",
    },
    body: JSON.stringify(payload),
  });

  const text = await res.text();

  if (!res.ok) {
    throw new Error(`AstrologyAPI ${endpoint}: ${text}`);
  }

  return JSON.parse(text);
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod === "OPTIONS") {
      return { statusCode: 204, headers: corsHeaders };
    }

    if (event.httpMethod !== "POST") {
      return {
        statusCode: 405,
        headers: corsHeaders,
        body: JSON.stringify({ error: "Method not allowed" }),
      };
    }

    // ENV CHECK
    if (!process.env.ASTROLOGY_API_USER_ID)
      throw new Error("Missing ASTROLOGY_API_USER_ID");
    if (!process.env.ASTROLOGY_API_KEY)
      throw new Error("Missing ASTROLOGY_API_KEY");
    if (!process.env.KIT_API_KEY)
      throw new Error("Missing KIT_API_KEY");
    if (!process.env.KIT_TAG_MAP_JSON)
      throw new Error("Missing KIT_TAG_MAP_JSON");

    const TAG_MAP = JSON.parse(process.env.KIT_TAG_MAP_JSON);

    const { firstName, email, dob, tob, birthplace } = JSON.parse(
      event.body || "{}"
    );

    if (!email || !dob || !tob || !birthplace) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ error: "Missing required fields" }),
      };
    }

    // DOB + TOB
    const [year, month, day] = dob.split("-").map(Number);
    const [hour, min] = tob.split(":").map(Number);

    // GEO LOOKUP (robust)
    let geo;
    const attempts = [
      birthplace,
      birthplace.split(",")[0].trim(),
      `${birthplace.split(",")[0].trim()}, Australia`,
    ];

    for (const place of attempts) {
      try {
        geo = await callAstroAPI("geo_details", {
          place,
          maxRows: 1,
        });
        if (geo?.geonames?.length) break;
      } catch {}
    }

    const loc = geo?.geonames?.[0];
    if (!loc) throw new Error("Birthplace not found");

    const lat = Number(loc.latitude);
    const lon = Number(loc.longitude);

    // TIMEZONE (DST SAFE)
    const tz = await callAstroAPI("timezone_with_dst", {
      latitude: lat,
      longitude: lon,
      date: `${month}-${day}-${year}`,
    });

    const tzone = Number(tz.timezone);

    // PLANETS
    const planets = await callAstroAPI("planets/tropical", {
      day,
      month,
      year,
      hour,
      min,
      lat,
      lon,
      tzone,
      house_type: "placidus",
    });

    // HOUSES
    const houses = await callAstroAPI("house_cusps/tropical", {
      day,
      month,
      year,
      hour,
      min,
      lat,
      lon,
      tzone,
      house_type: "placidus",
    });

    const sun = planets.find((p) => p.name === "Sun")?.sign;
    const moon = planets.find((p) => p.name === "Moon")?.sign;
    const rising = houses.houses.find((h) => h.house === 1)?.sign;

    if (!sun || !moon || !rising)
      throw new Error("Failed to calculate placements");

    // KIT SUBSCRIBE
    const kitRes = await fetch("https://api.kit.com/v4/subscribers", {
      method: "POST",
      headers: {
        "X-Kit-Api-Key": process.env.KIT_API_KEY,
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

    const subscriberId = JSON.parse(kitText)?.subscriber?.id;

    // TAGS
    const tags = [
      `SUN_${sun}`,
      `MOON_${moon}`,
      `RISING_${rising}`,
    ];

    for (const tag of tags) {
      const tagId = TAG_MAP[tag];
      if (!tagId) continue;

      await fetch(
        `https://api.kit.com/v4/tags/${tagId}/subscribers/${subscriberId}`,
        {
          method: "POST",
          headers: {
            "X-Kit-Api-Key": process.env.KIT_API_KEY,
          },
        }
      );
    }

return {
  statusCode: 200,
  headers: corsHeaders,
  body: JSON.stringify({
    ok: true,
    placements: { sun, moon, rising },
    chart: {
      planets,
      houseCusps
    }
  })
};
  } catch (err) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: err.message }),
    };
  }
};