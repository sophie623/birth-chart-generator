const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

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
  return signs[Math.floor(normalizeDeg(deg) / 30)];
}

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
  if (!key) throw new Error("Missing BDC_TIMEZONE_KEY env var");

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

function getAstroAuthHeader() {
  const userId = process.env.ASTROLOGY_API_USER_ID;
  const apiKey = process.env.ASTROLOGY_API_KEY;

  if (!userId || !apiKey) {
    throw new Error("Missing ASTROLOGY_API_USER_ID or ASTROLOGY_API_KEY env var");
  }

  return `Basic ${Buffer.from(`${userId}:${apiKey}`).toString("base64")}`;
}

async function fetchWesternHoroscope(params) {
  const res = await fetch("https://json.astrologyapi.com/v1/western_horoscope", {
    method: "POST",
    headers: {
      authorization: getAstroAuthHeader(),
      "Content-Type": "application/json",
      "Accept-Language": "en"
    },
    body: JSON.stringify({
      ...params,
      house_type: "placidus",
      is_asteroids: false
    })
  });

  const json = await res.json().catch(() => ({}));

  if (!res.ok || json?.status === false) {
    throw new Error(`AstrologyAPI error: ${JSON.stringify(json)}`);
  }

  return json;
}

function getHouseFromCusps(deg, houses) {
  const p = normalizeDeg(deg);

  const cusps = (houses || [])
    .map(h => ({
      house: Number(h.house),
      degree: normalizeDeg(h.degree)
    }))
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

function findPlanet(planets, name) {
  return (planets || []).find(
    p => String(p?.name || "").toLowerCase() === String(name).toLowerCase()
  );
}

async function createKitSubscriber(email, firstName) {
  try {
    const res = await fetch("https://api.kit.com/v4/subscribers", {
      method: "POST",
      headers: {
        "X-Kit-Api-Key": process.env.KIT_API_KEY,
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify({
        email_address: email,
        first_name: firstName || "",
        state: "active"
      })
    });

    const json = await res.json().catch(() => ({}));
    return json?.subscriber?.id || null;
  } catch (e) {
    console.log("Kit subscriber error:", e);
    return null;
  }
}

async function tagKitSubscriber(subscriberId, tagId) {
  try {
    await fetch(`https://api.kit.com/v4/tags/${tagId}/subscribers/${subscriberId}`, {
      method: "POST",
      headers: {
        "X-Kit-Api-Key": process.env.KIT_API_KEY,
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify({})
    });
  } catch (e) {
    console.log("Kit tag error:", e);
  }
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
        body: JSON.stringify({ error: "Method not allowed" })
      };
    }

    const body = JSON.parse(event.body || "{}");
    const firstName = body.firstName;
    const email = body.email;
    const dob = body.dob;
    const tob = body.tob;
    const birthplace = body.birthplace;

    if (!email || !dob || !tob || !birthplace) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ error: "Missing required fields" })
      };
    }

    const [year, month, day] = String(dob).split("-").map(Number);
    const [hour, min] = String(tob).split(":").map(Number);

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
      tzone
    });

    const planets = horoscope.planets || [];
    const houses = horoscope.houses || [];

    const sun = findPlanet(planets, "Sun") || findPlanet(planets, "sun");
    const moon = findPlanet(planets, "Moon") || findPlanet(planets, "moon");
    const node = findPlanet(planets, "Node") || findPlanet(planets, "node");
    const ascendant = findPlanet(planets, "Ascendant") || findPlanet(planets, "ascendant");

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
      "Sun","Moon","Mercury","Venus","Mars",
      "Jupiter","Saturn","Uranus","Neptune",
      "Pluto","Chiron","Node"
    ];

    const list = [];

    for (const name of orderedNames) {
      const p =
        findPlanet(planets, name) ||
        findPlanet(planets, name.toLowerCase());

      if (!p) continue;

      const label = name === "Node" ? "North Node" : name;

      list.push({
        name: label,
        sign: p.sign,
        house: p.house || getHouseFromCusps(p.full_degree, houses)
      });
    }

    if (southNode) list.push(southNode);

    // Kit should never break the chart
    const subscriberId = await createKitSubscriber(email, firstName);

    try {
      const tagMap = JSON.parse(process.env.KIT_TAG_MAP_JSON || "{}");

      const tagKeys = [
        sun?.sign ? `SUN_${sun.sign}` : null,
        moon?.sign ? `MOON_${moon.sign}` : null,
        risingSign ? `RISING_${risingSign}` : null
      ].filter(Boolean);

      for (const key of tagKeys) {
        const tagId = tagMap[key];
        if (tagId && subscriberId) {
          await tagKitSubscriber(subscriberId, tagId);
        }
      }
    } catch (e) {
      console.log("Tag map error:", e);
    }

    return {
      statusCode: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        placements: {
          big3: {
            sun: sun?.sign?.toLowerCase() || "",
            moon: moon?.sign?.toLowerCase() || "",
            rising: risingSign?.toLowerCase() || ""
          },
          list: list
        }
      })
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({
        error: err.message || "Unknown error"
      })
    };
  }
};