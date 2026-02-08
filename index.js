// ===============================
// ✅ TELEGRAM BOT + GOOGLE SHEET + GPT
// ===============================

require("dotenv").config();
const express = require("express");
const axios = require("axios");
const OpenAI = require("openai");

const app = express();
app.use(express.json());

// ===============================
// ✅ VARIABLES ENV
// ===============================
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// URL Apps Script
const SCRIPT_URL =
  "https://script.google.com/macros/s/AKfycbwBJjWvypfxR_Z2ZOaOLQyOV0js2r3pLrUwEG_FFV4sYQGTnrRwFuIdb4djrWuiIuUwNA/exec";

// ===============================
// ✅ OPENAI CLIENT
// ===============================
const client = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

// ===============================
// ✅ SEND TELEGRAM MESSAGE
// ===============================
async function sendTelegram(chatId, text) {
  return axios.post(
    `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
    {
      chat_id: chatId,
      text: text,
    }
  );
}

// ===============================
// ✅ SAVE SALE TO GOOGLE SHEET
// ===============================
async function addSaleToSheet(nom, telephone, produit, prix, quantite) {
  const prix_unitaire = Number(prix);
  const qte = Number(quantite);
  const montant_total = prix_unitaire * qte;

  return axios.post(SCRIPT_URL, {
    nom_complet: nom,
    telephone: telephone,
    produit: produit,
    prix_unitaire: prix_unitaire,
    quantite: qte,
    montant_total: montant_total,
  });
}

// ===============================
// ✅ GPT FUNCTION (INTELLIGENT BOT)
// ===============================
async function askGPT(userText) {
  const response = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: `
Tu es un assistant intelligent de boutique.

Tu dois comprendre les ventes écrites comme :
- "Marie, 06060606, Soft, 15000, 2"
- "J’ai vendu 2 soft à Marie"

Si c’est une vente, répond uniquement sous ce format JSON :

{
 "type": "sale",
 "nom": "...",
 "telephone": "...",
 "produit": "...",
 "prix": "...",
 "quantite": "..."
}

Si ce n’est pas une vente, répond normalement comme un assistant poli.
        `,
      },
      { role: "user", content: userText },
    ],
  });

  return response.choices[0].message.content;
}

// ===============================
// ✅ TEST ROUTE
// ===============================
app.get("/", (req, res) => {
  res.send("✅ OK SERVER RUNNING");
});

// ===============================
// ✅ WEBHOOK TELEGRAM
// ===============================
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const message = req.body.message;
    if (!message || !message.text) return;

    const chatId = message.chat.id;
    const userText = message.text.trim();

    console.log("📩 Message reçu :", userText);

    // ✅ Basic hello
    if (userText.toLowerCase() === "bonjour") {
      await sendTelegram(chatId, "👋 Bonjour Mélissa ! Que puis-je faire ?");
      return;
    }

    // ===============================
    // ✅ GPT ANALYSIS
    // ===============================
    const gptReply = await askGPT(userText);

    // Try JSON parse
    let data;
    try {
      data = JSON.parse(gptReply);
    } catch {
      // Normal conversation
      await sendTelegram(chatId, gptReply);
      return;
    }

    // ===============================
    // ✅ IF SALE DETECTED
    // ===============================
    if (data.type === "sale") {
      await addSaleToSheet(
        data.nom,
        data.telephone || "",
        data.produit,
        data.prix,
        data.quantite
      );

      await sendTelegram(
        chatId,
        `✅ Vente enregistrée : ${data.nom} a acheté ${data.quantite} ${data.produit}`
      );
      return;
    }

    // fallback
    await sendTelegram(chatId, "❌ Je n’ai pas compris.");
  } catch (err) {
    console.log("❌ Erreur webhook :", err.message);
  }
});

// ===============================
// ✅ START SERVER
// ===============================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("🚀 Serveur démarré sur le port", PORT);
});
