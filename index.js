require("dotenv").config();
const express = require("express");
const axios = require("axios");
const OpenAI = require("openai");

const app = express();
app.use(express.json());

// ENV variables
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SCRIPT_URL = "https://script.google.com/macros/s/AKfycbwBJjWvypfxR_Z2ZOaOLQyOV0js2r3pLrUwEG_FFV4sYQGTnrRwFuIdb4djrWuiIuUwNA/exec";

// === OpenAI Client ===
const client = new OpenAI({ apiKey: OPENAI_API_KEY });

// === Utils ===

// Send message to Telegram
async function sendTelegram(chatId, text) {
  try {
    await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
      {
        chat_id: chatId,
        text: text,
      }
    );
  } catch (err) {
    console.error("❌ Erreur d'envoi Telegram :", err.message);
  }
}

// Add sale to Google Sheet
async function addSaleToSheet(nom, tel, produit, prix, quantite) {
  try {
    await axios.post(SCRIPT_URL, {
      nom_complet: nom,
      telephone: tel,
      produit: produit,
      prix_unitaire: Number(prix),
      quantite: Number(quantite),
    });
  } catch (err) {
    console.error("❌ Erreur ajout Google Sheet :", err.message);
  }
}

// Ask GPT
async function askGPT(userText) {
  try {
    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "Tu es un assistant commercial intelligent d'une entreprise. Tu réponds UNIQUEMENT sur les ventes, les stocks, les produits, les chiffres et la gestion commerciale.",
        },
        { role: "user", content: userText },
      ],
    });

    return response.choices[0].message.content;
  } catch (err) {
    console.error("❌ Erreur OpenAI :", err.message);
    return "⚠️ Erreur de traitement avec GPT.";
  }
}

// === Routes ===

// Test route
app.get("/", (req, res) => {
  res.send("✅ Server running");
});

// Webhook route (Telegram)
app.post("/webhook", async (req, res) => {
  // Toujours répondre immédiatement à Telegram
  res.sendStatus(200);

  try {
    const message = req.body.message;
    if (!message || !message.text) return;

    const chatId = message.chat.id;
    const text = message.text.trim();

    console.log("📩 Message reçu :", text);

    // 1️⃣ Check des commandes simples
    if (text.toLowerCase() === "stock") {
      await sendTelegram(chatId, "📦 Stock bientôt disponible.");
      return;
    }

    // 2️⃣ Format vente : Nom, Tel, Produit, Prix, Quantité
    if (text.includes(",")) {
      const parts = text.split(",");

      if (parts.length < 5) {
        await sendTelegram(
          chatId,
          "❌ Format attendu : Nom, Téléphone, Produit, Prix, Quantité"
        );
        return;
      }

      const [nom, tel, produit, prix, quantite] = parts.map((p) => p.trim());

      await addSaleToSheet(nom, tel, produit, prix, quantite);
      await sendTelegram(
        chatId,
        `✅ Vente enregistrée : ${nom} → ${quantite} ${produit}`
      );

      return;
    }

    // 3️⃣ Sinon → GPT assistant commercial
    const reply = await askGPT(text);
    await sendTelegram(chatId, reply);
  } catch (err) {
    console.error("❌ Erreur Webhook :", err.message);
  }
});

// === Start Server ===
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("🚀 Serveur lancé sur le port", PORT);
});
