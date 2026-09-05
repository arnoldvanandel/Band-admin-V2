// ============================================================================
//  Band Admin Cloud Functions
//
//  deepgramToken
//  -------------
//  Geeft de browser een tijdelijk Deepgram-token (JWT), zodat gebruikers
//  live spraakherkenning kunnen gebruiken zónder dat de Deepgram API-key
//  in de frontend staat. De API-key leeft uitsluitend als Firebase-secret:
//
//      firebase functions:secrets:set DEEPGRAM_API_KEY
//
//  De bestaande functie `fetchSpotifySong` wordt hier NIET aangeraakt;
//  deze file voegt alleen een nieuwe functie toe.
// ============================================================================

const { onRequest } = require("firebase-functions/v2/https");

/** CORS-headers zodat de functie vanuit beide hosting-sites aanroepbaar is. */
function setCorsHeaders(res) {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
}

exports.deepgramToken = onRequest(
  {
    region: "us-central1",
    memory: "256MiB",
    secrets: ["DEEPGRAM_API_KEY"], // maakt process.env.DEEPGRAM_API_KEY beschikbaar
  },
  async (req, res) => {
    setCorsHeaders(res);

    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }
    if (req.method !== "GET") {
      res.status(405).send("Method Not Allowed");
      return;
    }

    let apiKey = (process.env.DEEPGRAM_API_KEY || "").trim();

    // Herstel een veelvoorkomende plakfout: dezelfde 40-teken key staat er
    // twee keer achter elkaar (80 tekens). Gebruik dan de eerste helft.
    if (apiKey.length === 80 && apiKey.slice(0, 40) === apiKey.slice(40)) {
      console.warn("DEEPGRAM_API_KEY lijkt dubbel opgeslagen; eerste helft wordt gebruikt.");
      apiKey = apiKey.slice(0, 40);
    }

    if (!apiKey) {
      res.status(500).send("Deepgram API key niet geconfigureerd (DEEPGRAM_API_KEY).");
      return;
    }

    // Tijdelijk token: standaard 60 seconden geldig (genoeg voor de handshake).
    const requestedTtl = Number(req.query.ttl_seconds) || 60;
    const ttlSeconds = Math.max(5, Math.min(300, requestedTtl));

    try {
      const grant = await fetch("https://api.deepgram.com/v1/auth/grant", {
        method: "POST",
        headers: {
          Authorization: `Token ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ttl_seconds: ttlSeconds }),
      });

      if (!grant.ok) {
        const body = await grant.text();
        console.error("Deepgram auth/grant mislukt:", grant.status, body);
        res.status(502).send("Deepgram-token aanmaken mislukt.");
        return;
      }

      const data = await grant.json();
      const token = data && (data.token || data.access_token);
      if (!token) {
        res.status(502).send("Deepgram gaf geen token terug.");
        return;
      }

      res.set("Content-Type", "text/plain");
      res.send(token);
    } catch (ex) {
      console.error("deepgramToken fout:", ex);
      res.status(500).send("Interne fout bij het aanmaken van het Deepgram-token.");
    }
  }
);
