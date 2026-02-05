const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

exports.handler = async (event) => {
  try {
    // Handle CORS preflight
    if (event.httpMethod === "OPTIONS") {
      return {
        statusCode: 204,
        headers: corsHeaders,
        body: ""
      };
    }

    // Only allow POST
    if (event.httpMethod !== "POST") {
      return {
        statusCode: 405,
        headers: corsHeaders,
        body: JSON.stringify({ error: "Method not allowed" })
      };
    }

    // Parse request body
    const { firstName, email, dob, tob, birthplace, timezone } =
      JSON.parse(event.body || "{}");

    // Basic validation
    if (!email || !dob || !tob || !birthplace || !timezone) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ error: "Missing required fields" })
      };
    }

    // 🔹 TEMPORARY TEST RESPONSE
    // Confirms Squarespace → Netlify → browser works
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        ok: true,
        placements: {
          sun: "Virgo",
          moon: "Scorpio",
          rising: "Capricorn"
        }
      })
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: err.message || "Server error" })
    };
  }
};