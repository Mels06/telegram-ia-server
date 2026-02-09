// ===============================
// ✅ TELEGRAM BOT + GPT + GOOGLE SHEET
// ===============================

require("dotenv").config();
const express = require("express");
const axios = require("axios");
const OpenAI = require("openai");

const app = express();
app.use(express.json());

// ===============================
// ✅ ENV VARIABLES
// ===============================
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const SCRIPT_URL =
  "https://script.google.com/macros/s/AKfycbwBJjWvypfxR_Z2ZOaOLQyOV0js2r3pLrUwEG_FFV4sYQGTnrRwFuIdb4djrWuiIuUwNA/exec";

// ===============================
// ✅ OpenAI Client
// ===============================
const client = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

// ===============================
// ✅ Send Telegram Message
// ===============================
async function sendTelegram(chatId, text) {
  await axios.post(
    `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
    {
      chat_id: chatId,
      text,
    }
  );
}

// ===============================
// ✅ Add Sale to Google Sheet
// ===============================
async function addSaleToSheet(nom, tel, produit, prix, quantite) {
  await axios.post(SCRIPT_URL, {
    nom_complet: nom,
    telephone: tel,
    produit: produit,
    prix_unitaire: Number(prix),
    quantite: Number(quantite),
  });
}

// ===============================
// ✅ GPT Response Function
// ===============================
async function askGPT(userText) {
  const response = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content:
          "Tu es un assistant commercial intelligent. Tu aides à gérer ventes, stock, réponses clients.",
      },
      { role: "user", content: userText },
    ],
  });

  return response.choices[0].message.content;
}

// ===============================
// ✅ Test Route
// ===============================
app.get("/", (req, res) => {
  res.send("✅ Server running");
});

// ===============================
// ✅ Telegram Webhook
// ===============================
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const message = req.body.message;
    if (!message || !message.text) return;

    const chatId = message.chat.id;
    const text = message.text.trim();

    console.log("📩 Message reçu :", text);

    // ===============================
    // ✅ SALES FORMAT: Nom, Tel, Produit, Prix, Quantité
    // ===============================
    if (text.includes(",")) {
      const parts = text.split(",");

      if (parts.length < 5) {
        await sendTelegram(
          chatId,
          "❌ Format attendu : Nom, Téléphone, Produit, Prix, Quantité"
        );
        return;
      }

      const nom = parts[0].trim();
      const tel = parts[1].trim();
      const produit = parts[2].trim();
      const prix = parts[3].trim();
      const quantite = parts[4].trim();

      if (isNaN(prix) || isNaN(quantite)) {
        await sendTelegram(chatId, "❌ Prix et quantité doivent être des nombres.");
        return;
      }

      await addSaleToSheet(nom, tel, produit, prix, quantite);

      await sendTelegram(
        chatId,
        `✅ Vente enregistrée : ${nom} a acheté ${quantite} ${produit} (${prix} FCFA)`
      );

      return;
    }

    // ===============================
    // ✅ Otherwise GPT handles conversation
    // ===============================
    const gptReply = await askGPT(text);
    await sendTelegram(chatId, gptReply);
  } catch (err) {
    console.log("❌ Erreur :", err.message);
  }
});

// ===============================
// ✅ Start Server
// ===============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("🚀 Serveur lancé sur", PORT));
