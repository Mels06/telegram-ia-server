// ===============================
// ✅ BOT TELEGRAM + GOOGLE SHEET + GPT
// ===============================

require("dotenv").config();

const express = require("express");
const axios = require("axios");
const OpenAI = require("openai");

const app = express();
app.use(express.json());

// ===============================
// ✅ Variables importantes
// ===============================

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const SCRIPT_URL =
  "https://script.google.com/macros/s/AKfycbwBJjWvypfxR_Z2ZOaOLQyOV0js2r3pLrUwEG_FFV4sYQGTnrRwFuIdb4djrWuiIuUwNA/exec";

// ===============================
// ✅ OpenAI Setup
// ===============================

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

// ===============================
// ✅ Envoyer message Telegram
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
// ✅ Enregistrer vente Google Sheet
// ===============================

async function addSaleToSheet(nom_complet, telephone, produit, prix, quantite) {
  const prixNum = Number(prix);
  const quantiteNum = Number(quantite);

  const montant_total = prixNum * quantiteNum;

  return axios.post(SCRIPT_URL, {
    nom_complet,
    telephone,
    produit,
    prix_unitaire: prixNum,
    quantite: quantiteNum,
    montant_total,
  });
}

// ===============================
// ✅ Fonction GPT
// ===============================

async function askGPT(question) {
  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content:
          "Tu es un assistant commercial intelligent. Réponds court, clair et utile.",
      },
      {
        role: "user",
        content: question,
      },
    ],
  });

  return response.choices[0].message.content;
}

// ===============================
// ✅ WEBHOOK TELEGRAM (COMPLET)
// ===============================

app.post("/webhook", async (req, res) => {
  // Telegram veut une réponse immédiate
  res.sendStatus(200);

  try {
    const message = req.body.message;
    if (!message || !message.text) return;

    const chatId = message.chat.id;
    const userText = message.text.trim();

    console.log("📩 Message reçu :", userText);

    // ===============================
    // ✅ CAS 1 : Vente détectée (virgules)
    // ===============================

    if (userText.includes(",")) {
      const parts = userText.split(",");

      // On attend exactement 5 infos
      if (parts.length < 5) {
        await sendTelegram(
          chatId,
          "❌ Format attendu : Nom, Téléphone, Produit, Prix, Quantité"
        );
        return;
      }

      // Extraction
      const nom_complet = parts[0].trim();
      const telephone = parts[1].trim();
      const produit = parts[2].trim();
      const prix = parts[3].trim();
      const quantite = parts[4].trim();

      // Enregistrer dans Google Sheet
      await addSaleToSheet(nom_complet, telephone, produit, prix, quantite);

      // Confirmation Telegram
      await sendTelegram(
        chatId,
        `✅ Vente enregistrée !\n\n👤 ${nom_complet}\n📞 ${telephone}\n🛒 ${produit}\n💰 ${prix} FCFA x${quantite}`
      );

      return;
    }

    // ===============================
    // ✅ CAS 2 : Message normal → GPT répond
    // ===============================

    const gptReply = await askGPT(userText);

    await sendTelegram(chatId, gptReply);
  } catch (err) {
    console.log("❌ Erreur webhook :", err.message);
  }
});

// ===============================
// ✅ TEST SERVER
// ===============================

app.get("/", (req, res) => {
  res.send("✅ OK SERVER RUNNING");
});

// ===============================
// ✅ Lancer serveur Render
// ===============================

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("🚀 Serveur démarré sur le port", PORT);
});
