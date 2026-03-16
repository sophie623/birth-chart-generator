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

  const res = await fetch(url,{
    headers:{ "User-Agent":"chart-tool" }
  });

  if(!res.ok) throw new Error("Geocode failed");

  const data = await res.json();

  if(!data.length) throw new Error("Birthplace not found");

  return {
    lat:Number(data[0].lat),
    lon:Number(data[0].lon)
  };

}

async function getTimezone(lat,lon){

  const key = process.env.BDC_TIMEZONE_KEY;

  const url=`https://api-bdc.net/data/timezone-by-location?latitude=${lat}&longitude=${lon}&key=${key}`;

  const res = await fetch(url);

  if(!res.ok) throw new Error("Timezone lookup failed");

  const data = await res.json();

  const offset =
    data?.localTimeOffset?.currentLocalTimeOffset ??
    data?.utcOffsetSeconds;

  return offset/3600;

}

function getAstroAuthHeader(){

  const userId=process.env.ASTROLOGY_API_USER_ID;
  const apiKey=process.env.ASTROLOGY_API_KEY;

  const auth = Buffer.from(`${userId}:${apiKey}`).toString("base64");

  return `Basic ${auth}`;

}

async function fetchWesternHoroscope(params){

  const res = await fetch(
    "https://json.astrologyapi.com/v1/western_horoscope",
    {
      method:"POST",
      headers:{
        authorization:getAstroAuthHeader(),
        "Content-Type":"application/json"
      },
      body:JSON.stringify({
        ...params,
        house_type:"placidus",
        is_asteroids:false
      })
    }
  );

  const json = await res.json();

  if(!res.ok) throw new Error("Astrology API error");

  return json;

}

function getHouseFromCusps(deg,houses){

  const p = normalizeDeg(deg);

  const cusps = houses
    .map(h=>({house:Number(h.house),degree:normalizeDeg(h.degree)}))
    .sort((a,b)=>a.house-b.house);

  for(let i=0;i<cusps.length;i++){

    const start=cusps[i].degree;
    const end=cusps[(i+1)%cusps.length].degree;

    if(start<=end){
      if(p>=start && p<end) return cusps[i].house;
    }else{
      if(p>=start || p<end) return cusps[i].house;
    }

  }

  return 1;

}

async function createKitSubscriber(email,firstName){

  try{

    const res = await fetch(
      "https://api.kit.com/v4/subscribers",
      {
        method:"POST",
        headers:{
          "X-Kit-Api-Key":process.env.KIT_API_KEY,
          "Content-Type":"application/json"
        },
        body:JSON.stringify({
          email_address:email,
          first_name:firstName || "",
          state:"active"
        })
      }
    );

    const json = await res.json();

    return json?.subscriber?.id;

  }catch(e){
    console.log("Kit subscriber error",e);
    return null;
  }

}

async function tagKitSubscriber(subscriberId,tagId){

  try{

    await fetch(
      `https://api.kit.com/v4/tags/${tagId}/subscribers/${subscriberId}`,
      {
        method:"POST",
        headers:{
          "X-Kit-Api-Key":process.env.KIT_API_KEY,
          "Content-Type":"application/json"
        }
      }
    );

  }catch(e){
    console.log("Kit tag error",e);
  }

}

exports.handler = async(event)=>{

  try{

    if(event.httpMethod==="OPTIONS"){
      return {statusCode:204,headers:corsHeaders,body:""};
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
    body: JSON.stringify({ error: "Missing required fields" }),
  };
}

const [year, month, day] = String(dob).split("-").map(Number);
const [hour, min] = String(tob).split(":").map(Number);

    const {lat,lon}=await forwardGeocode(birthplace);

    const tzone=await getTimezone(lat,lon);

    const horoscope=await fetchWesternHoroscope({
      day,month,year,hour,min,lat,lon,tzone
    });

    const planets=horoscope.planets||[];
    const houses=horoscope.houses||[];

    const getPlanet=n=>planets.find(p=>p.name?.toLowerCase()===n.toLowerCase());

    const sun=getPlanet("Sun");
    const moon=getPlanet("Moon");
    const node=getPlanet("Node");
    const asc=getPlanet("Ascendant");

    const rising=asc?.sign || degreeToSign(horoscope.ascendant);

    let southNode=null;

    if(node?.full_degree!=null){

      const deg=normalizeDeg(Number(node.full_degree)+180);

      southNode={
        name:"South Node",
        sign:degreeToSign(deg),
        house:getHouseFromCusps(deg,houses)
      };

    }

    const order=[
      "Sun","Moon","Mercury","Venus","Mars",
      "Jupiter","Saturn","Uranus","Neptune",
      "Pluto","Chiron","Node"
    ];

    const list=[];

    for(const name of order){

      const p=getPlanet(name);
      if(!p) continue;

      const label=name==="Node"?"North Node":name;

      list.push({
        name:label,
        sign:p.sign,
        house:p.house||getHouseFromCusps(p.full_degree,houses)
      });

    }

    if(southNode) list.push(southNode);

    const subscriberId = await createKitSubscriber(email,firstName);

    try{

      const tagMap=JSON.parse(process.env.KIT_TAG_MAP_JSON||"{}");

      const tags=[
        `SUN_${sun?.sign}`,
        `MOON_${moon?.sign}`,
        `RISING_${rising}`
      ];

      for(const t of tags){

        const tagId=tagMap[t];

        if(tagId && subscriberId){
          await tagKitSubscriber(subscriberId,tagId);
        }

      }

    }catch(e){
      console.log("Tag map error",e);
    }

    return{
      statusCode:200,
      headers:{...corsHeaders,"Content-Type":"application/json"},
      body:JSON.stringify({
        placements:{
          big3:{
            sun:sun?.sign?.toLowerCase(),
            moon:moon?.sign?.toLowerCase(),
            rising:rising?.toLowerCase()
          },
          list:list
        }
      })
    };

  }

  catch(err){

    return{
      statusCode:500,
      headers:corsHeaders,
      body:JSON.stringify({error:err.message})
    };

  }

};