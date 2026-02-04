// ================== IMPORTS ==================
const express = require("express");
const axios = require("axios");
const { google } = require("googleapis");

// ================== APP ==================
const app = express();
app.use(express.json());
 
// ✅ Fonction pour lire une vente envoyée par message
function parseVente(text) {
  const parts = text.split(",");

  // On attend : Nom, Modèle, Prix
  if (parts.length < 3) return null;

  return {
    nom: parts[0].trim(),
    modele: parts[1].trim(),
    prix: Number(parts[2].trim()),
  };
}

app.get("/", (req, res) => {
  res.send("✅ Serveur Telegram IA actif");
});

// ================== VARIABLES D’ENV ==================
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || "";
const OPENAI_KEY = process.env.OPENAI_KEY || "";
const SHEET_ID = process.env.SHEET_ID || "";
const GOOGLE_CREDENTIALS = process.env.GOOGLE_CREDENTIALS || "";

// ================== GOOGLE SHEETS (SAFE INIT) ==================
let sheets = null;

if (GOOGLE_CREDENTIALS) {
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(GOOGLE_CREDENTIALS),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  sheets = google.sheets({ version: "v4", auth });
}

// ================== WEBHOOK TELEGRAM ==================
app.post("/webhook", async (req, res) => {
    console.log("📩 Webhook appelé !");
console.log(JSON.stringify(req.body, null, 2));

  try {
    const message = req.body.message;
    if (!message || !message.text) {
      return res.sendStatus(200);
    }

    const chatId = message.chat.id;
    const userText = message.text;
    await axios.post(
  `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
  {
    chat_id: chatId,
    text: "✅ Message reçu : " + userText,
  }
);

        // ✅ TEST VENTE SIMPLE
    if (text.includes(",")) {

      const vente = parseVente(text);

      if (!vente) {
        await axios.post(
          `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
          {
            chat_id: chatId,
            text: "❌ Format invalide. Exemple : Melissa, Blue Céline, 20000"
          }
        );
        return res.sendStatus(200);
      }

      await axios.post(
        `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
        {
          chat_id: chatId,
          text: `✅ Vente reçue : ${vente.nom} / ${vente.modele} / ${vente.prix} FCFA`
        }
      );

      return res.sendStatus(200);
    }

    // ===== IA =====
    let extractedText = userText;

    if (OPENAI_KEY) {
      const aiResponse = await axios.post(
        "https://api.openai.com/v1/chat/completions",
        {
          model: "gpt-4o-mini",
          messages: [
            {
              role: "system",
              content:
                "Tu es un assistant professionnel. Tu aides à structurer des informations pour un Google Sheet.",
            },
            { role: "user", content: userText },
          ],
        },
        {
          headers: {
            Authorization: `Bearer ${OPENAI_KEY}`,
            "Content-Type": "application/json",
          },
        }
      );

      extractedText = aiResponse.data.choices[0].message.content;
    }

    // ===== GOOGLE SHEET (SI CONFIGURÉ) =====
    if (sheets && SHEET_ID) {
      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: "Sheet1!A1",
        valueInputOption: "RAW",
        requestBody: {
          values: [[new Date().toISOString(), extractedText]],
        },
      });
    }

    // ===== RÉPONSE TELEGRAM =====
    if (TELEGRAM_TOKEN) {
      await axios.post(
        `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
        {
          chat_id: chatId,
          text: "✅ Information bien reçue et traitée.",
        }
      );
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("ERREUR :", err.message);
    res.sendStatus(500);
  }
});

// ================== START SERVER ==================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Serveur démarré sur le port ${PORT}`);
});

