require("dotenv").config();
const express = require("express");
const axios = require("axios");
const OpenAI = require("openai");

const app = express();
app.use(express.json());

// ENV
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const SCRIPT_URL =
  "https://script.google.com/macros/s/AKfycbwBJjWvypfxR_Z2ZOaOLQyOV0js2r3pLrUwEG_FFV4sYQGTnrRwFuIdb4djrWuiIuUwNA/exec";

// OpenAI Client
const client = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

// Send Telegram
async function sendTelegram(chatId, text) {
  await axios.post(
    https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage,
    {
      chat_id: chatId,
      text: text,
    }
  );
}

// Add Sale to Sheet
async function addSaleToSheet(nom, tel, produit, prix, quantite) {
  await axios.post(SCRIPT_URL, {
    nom_complet: nom,
    telephone: tel,
    produit: produit,
    prix_unitaire: Number(prix),
    quantite: Number(quantite),
  });
}

// GPT Reply
async function askGPT(userText) {
  const response = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content:
          "Tu es un assistant commercial. Tu réponds uniquement sur les ventes, stock, produits, chiffres.",
      },
      { role: "user", content: userText },
    ],
  });

  return response.choices[0].message.content;
}

// Test route
app.get("/", (req, res) => {
  res.send("✅ Server running");
});

// Webhook Telegram
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const message = req.body.message;
    if (!message || !message.text) return;

    const chatId = message.chat.id;
    const text = message.text.trim();

    console.log("📩 Message reçu :", text);

    // Stock command
    if (text.toLowerCase() === "stock") {
      await sendTelegram(chatId, "📦 Stock bientôt disponible.");
      return;
    }

    // Sale format
    if (text.includes(",")) {
      const parts = text.split(",");

      if (parts.length < 5) {
        await sendTelegram(
          chatId,
          "❌ Format : Nom, Téléphone, Produit, Prix, Quantité"
        );
        return;
      }

      const nom = parts[0].trim();
      const tel = parts[1].trim();
      const produit = parts[2].trim();
      const prix = parts[3].trim();
      const quantite = parts[4].trim();

      await addSaleToSheet(nom, tel, produit, prix, quantite);

      await sendTelegram(
  chatId,
  `✅ Vente enregistrée : ${nom} → ${quantite} ${produit}`
);

    // GPT response
    const reply = await askGPT(text);
    await sendTelegram(chatId, reply);

  } catch (err) {
    console.log("❌ Erreur :", err.message);
  }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("🚀 Serveur lancé sur le port", PORT);
});