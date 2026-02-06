// ===============================
// ✅ BOT TELEGRAM + GOOGLE SHEET
// ===============================

require("dotenv").config();
const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

// ===============================
// ✅ CONFIG
// ===============================

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;

// 🔥 Ton URL Apps Script (Google Sheet)
const SCRIPT_URL =
  "https://script.google.com/macros/s/AKfycbwBJjWvypfxR_Z2ZOaOLQyOV0js2r3pLrUwEG_FFV4sYQGTnrRwFuIdb4djrWuiIuUwNA/exec";

// ===============================
// ✅ Fonction : répondre sur Telegram
// ===============================

async function sendTelegram(chatId, text) {
  await axios.post(
    `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
    {
      chat_id: chatId,
      text: text,
    }
  );
}

// ===============================
// ✅ Fonction : enregistrer une vente dans Google Sheet
// ===============================

async function addSaleToSheet(nom, telephone, produit, prix, quantite) {
  await axios.post(SCRIPT_URL, {
    nom: nom,
    telephone: telephone,
    produit: produit,
    prix: prix,
    quantite: quantite,
  });
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
    // ✅ Si l’utilisateur envoie une vente
    // Format : Nom, Téléphone, Produit, Prix, Quantité
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

      const nom = parts[0].trim();
      const telephone = parts[1].trim();
      const produit = parts[2].trim();
      const prix = parts[3].trim();
      const quantite = parts[4].trim();

      // ✅ Enregistrer dans Google Sheet
      await addSaleToSheet(nom, telephone, produit, prix, quantite);

      // ✅ Réponse Telegram
      await sendTelegram(
        chatId,
        `✅ Vente enregistrée : ${nom} / ${produit} / ${prix} FCFA x${quantite}`
      );

      return;
    }

    // ===============================
    // ✅ Sinon → message d’aide
    // ===============================

    await sendTelegram(
      chatId,
      "💡 Envoie une vente comme : Nom, Téléphone, Produit, Prix, Quantité"
    );
  } catch (err) {
    console.log("❌ Erreur webhook :", err);
  }
});

// ===============================
// ✅ Route test Render
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
