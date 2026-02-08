// ======================================
// ✅ TELEGRAM BOT + GOOGLE SHEET + GPT
// ======================================

require("dotenv").config();
const express = require("express");
const axios = require("axios");
const OpenAI = require("openai");

const app = express();
app.use(express.json());

// ======================================
// ✅ CONFIG
// ======================================

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const SCRIPT_URL =
  "https://script.google.com/macros/s/AKfycbwBJjWvypfxR_Z2ZOaOLQyOV0js2r3pLrUwEG_FFV4sYQGTnrRwFuIdb4djrWuiIuUwNA/exec";

// ======================================
// ✅ OPENAI CLIENT
// ======================================

const client = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

// ======================================
// ✅ SEND MESSAGE TELEGRAM
// ======================================

async function sendTelegram(chatId, text) {
  await axios.post(
    `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
    {
      chat_id: chatId,
      text: text,
    }
  );
}

// ======================================
// ✅ ENVOYER VENTE AU GOOGLE SHEET
// ======================================

async function addSaleToSheet(nom, telephone, produit, quantite) {
  await axios.post(SCRIPT_URL, {
    nom_complet: nom,
    telephone: telephone,
    produit: produit.toUpperCase(),
    quantite: Number(quantite),
  });
}

// ======================================
// ✅ GPT : CONVERSATION NORMALE
// ======================================

async function askGPT(userText) {
  const response = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content:
          "Tu es un assistant professionnel et chaleureux pour une boutique de lunettes. Réponds naturellement.",
      },
      {
        role: "user",
        content: userText,
      },
    ],
  });

  return response.choices[0].message.content.trim();
}

// ======================================
// ✅ GPT : DÉTECTION DE VENTE EN PHRASE
// ======================================

async function detectSale(userText) {
  const response = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: `
Tu dois détecter si le message contient une vente.

Si c’est une vente, réponds uniquement avec ce JSON :

{
  "isSale": true,
  "nom": "Marie",
  "produit": "SOFT",
  "quantite": 2
}

Si ce n’est pas une vente :

{
  "isSale": false
}

JSON uniquement. Rien d'autre.
        `,
      },
      { role: "user", content: userText },
    ],
  });

  return response.choices[0].message.content.trim();
}

// ======================================
// ✅ ROUTE TEST RENDER
// ======================================

app.get("/", (_req, res) => {
  res.send("✅ BOT RUNNING");
});

// ======================================
// ✅ WEBHOOK TELEGRAM
// ======================================

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const message = req.body.message;
    if (!message || !message.text) return;

    const chatId = message.chat.id;
    const text = message.text.trim();

    console.log("📩 Message reçu :", text);

    // ======================================
    // ✅ 1) Vente format virgule
    // Exemple : Marie, 06000000, BLUE, 2
    // ======================================

    if (text.includes(",")) {
      const parts = text.split(",");

      if (parts.length !== 4) {
        await sendTelegram(
          chatId,
          "❌ Format vente : Nom, Téléphone, Produit, Quantité\nExemple : Marie, 06000000, BLUE, 2"
        );
        return;
      }

      const nom = parts[0].trim();
      const telephone = parts[1].trim();
      const produit = parts[2].trim();
      const quantite = parts[3].trim();

      if (isNaN(quantite)) {
        await sendTelegram(chatId, "❌ Quantité doit être un nombre.");
        return;
      }

      await addSaleToSheet(nom, telephone, produit, quantite);

      await sendTelegram(
        chatId,
        `✅ Vente enregistrée : ${produit} x${quantite} pour ${nom}`
      );

      return;
    }

    // ======================================
    // ✅ 2) Vente en phrase naturelle (GPT)
    // Exemple : J’ai vendu 2 soft à Marie
    // ======================================

    const saleRaw = await detectSale(text);

    let sale;
    try {
      sale = JSON.parse(saleRaw);
    } catch (err) {
      sale = { isSale: false };
    }

    if (sale.isSale) {
      await addSaleToSheet(
        sale.nom,
        "00000000",
        sale.produit,
        sale.quantite
      );

      await sendTelegram(
        chatId,
        `✅ Vente enregistrée : ${sale.produit} x${sale.quantite} pour ${sale.nom}`
      );

      return;
    }

    // ======================================
    // ✅ 3) Conversation normale GPT
    // ======================================

    const reply = await askGPT(text);
    await sendTelegram(chatId, reply);
  } catch (err) {
    console.log("❌ Erreur webhook :", err.message);
  }
});

// ======================================
// ✅ START SERVER
// ======================================

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("🚀 Serveur démarré sur le port", PORT);
});
