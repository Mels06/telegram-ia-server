require("dotenv").config();
const express = require("express");
const axios = require("axios");
const OpenAI = require("openai");

const app = express();
app.use(express.json());

// ===============================
// ENV
// ===============================
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const SCRIPT_URL =
  "https://script.google.com/macros/s/AKfycbwBJjWvypfxR_Z2ZOaOLQyOV0js2r3pLrUwEG_FFV4sYQGTnrRwFuIdb4djrWuiIuUwNA/exec";

// ===============================
// OpenAI Client (V4)
// ===============================
const client = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

// ===============================
// Telegram send
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
// GPT Answer
// ===============================
async function askGPT(question) {
  const response = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: "Tu es un assistant utile et clair." },
      { role: "user", content: question },
    ],
  });

  return response.choices[0].message.content;
}

// ===============================
// Webhook Telegram
// ===============================
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const message = req.body.message;
    if (!message || !message.text) return;

    const chatId = message.chat.id;
    const userText = message.text.trim();

    console.log("Message reçu :", userText);

    // Vente format
    if (userText.includes(",")) {
      const parts = userText.split(",");

      if (parts.length < 5) {
        await sendTelegram(
          chatId,
          "❌ Format attendu : Nom, Téléphone, Produit, Prix, Quantité"
        );
        return;
      }

      const nom_complet = parts[0].trim();
      const telephone = parts[1].trim();
      const produit = parts[2].trim();
      const prix_unitaire = Number(parts[3].trim());
      const quantite = Number(parts[4].trim());

      const montant_total = prix_unitaire * quantite;

      await axios.post(SCRIPT_URL, {
        nom_complet,
        telephone,
        produit,
        prix_unitaire,
        quantite,
        montant_total,
      });

      await sendTelegram(
        chatId,
        `✅ Vente enregistrée : ${nom_complet} / ${produit} / ${montant_total} FCFA`
      );

      return;
    }

    // Sinon GPT répond
    const reply = await askGPT(userText);
    await sendTelegram(chatId, reply);
  } catch (err) {
    console.log("❌ Erreur webhook :", err.message);
  }
});

// ===============================
// Server start
// ===============================
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("OK SERVER RUNNING");
});

app.listen(PORT, () => {
  console.log("Serveur démarré sur le port", PORT);
});
