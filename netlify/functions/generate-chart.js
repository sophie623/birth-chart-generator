export default async (req) => {
  try {
    // Only allow POST requests
    if (req.method !== "POST") {
      return new Response(
        JSON.stringify({ error: "Method not allowed" }),
        { status: 405 }
      );
    }

    const { firstName, email, dob, tob, birthplace, timezone } =
      await req.json();

    if (!email || !dob || !tob || !birthplace || !timezone) {
      return new Response(
        JSON.stringify({ error: "Missing required fields" }),
        { status: 400 }
      );
    }

    const ASTROAPI_KEY = process.env.ASTROAPI_KEY;

    /* ----------------------------------------
       1. SUBSCRIBE USER TO KIT (ConvertKit)
    -----------------------------------------*/

    const subscriberRes = await fetch("https://api.kit.com/v4/subscribers", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Kit-Api-Key": process.env.KIT_API_KEY,
      },
      body: JSON.stringify({
        email_address: email,
        first_name: firstName || null,
        state: "active",
      }),
    });

    const subscriberJson = await subscriberRes.json();

    if (!subscriberRes.ok) {
      return new Response(
        JSON.stringify({ error: "Kit subscriber failed", details: subscriberJson }),
        { status: 500 }
      );
    }

    const subscriberId = subscriberJson.subscriber.id;

    /* ----------------------------------------
       2. GEOCODE BIRTHPLACE → LAT / LNG
    -----------------------------------------*/

    const geoRes = await fetch(
      `https://api.astroapi.cloud/api/geocoding/search?q=${encodeURIComponent(
        birthplace
      )}&limit=1`,
      {
        headers: {
          "X-Api-Key": ASTROAPI_KEY,
        },
      }
    );

    const geoJson = await geoRes.json();
    const place = geoJson?.data?.[0];

    if (!place?.latitude || !place?.longitude) {
      return new Response(
        JSON.stringify({
          error:
            "Could not find that birthplace. Please try City, Country format.",
        }),
        { status: 400 }
      );
    }

    /* ----------------------------------------
       3. CALCULATE NATAL CHART (PLACIDUS)
    -----------------------------------------*/

    const natalRes = await fetch(
      "https://api.astroapi.cloud/api/calc/natal",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Api-Key": ASTROAPI_KEY,
        },
        body: JSON.stringify({
          datetime: `${dob}T${tob}:00`,
          latitude: place.latitude,
          longitude: place.longitude,
          timezone,
          houseSystem: "placidus",
        }),
      }
    );

    const natalJson = await natalRes.json();

    if (!natalRes.ok) {
      return new Response(
        JSON.stringify({
          error: "Natal chart calculation failed",
          details: natalJson,
        }),
        { status: 500 }
      );
    }

    /* ----------------------------------------
       4. EXTRACT SUN / MOON / RISING
    -----------------------------------------*/

    const planets = natalJson?.data?.attributes?.planets || {};
    const ascendant = natalJson?.data?.attributes?.ascendant;

    const sunSign = planets?.sun?.sign;
    const moonSign = planets?.moon?.sign;
    const risingSign = ascendant?.sign;

    if (!sunSign || !moonSign || !risingSign) {
      return new Response(
        JSON.stringify({ error: "Could not extract Big 3 placements" }),
        { status: 500 }
      );
    }

    /* ----------------------------------------
       5. TAG SUBSCRIBER IN KIT
    -----------------------------------------*/

    const TAGS = JSON.parse(process.env.KIT_TAG_MAP_JSON);

    const tagKeys = [
      `SUN_${sunSign}`,
      `MOON_${moonSign}`,
      `RISING_${risingSign}`,
    ];

    await Promise.all(
      tagKeys.map((key) => {
        const tagId = TAGS[key];
        if (!tagId) return;

        return fetch(
          `https://api.kit.com/v4/tags/${tagId}/subscribers/${subscriberId}`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Kit-Api-Key": process.env.KIT_API_KEY,
            },
            body: JSON.stringify({}),
          }
        );
      })
    );

    /* ----------------------------------------
       6. RETURN CHART DATA TO SQUARESPACE
    -----------------------------------------*/

    return new Response(
      JSON.stringify({
        ok: true,
        placements: {
          sun: sunSign,
          moon: moonSign,
          rising: risingSign,
        },
        chart: natalJson,
      }),
      { status: 200 }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message || "Server error" }),
      { status: 500 }
    );
  }
};
