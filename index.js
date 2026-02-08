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

const SCRIPT_URL =
  "https://script.google.com/macros/s/AKfycbwBJjWvypfxR_Z2ZOaOLQyOV0js2r3pLrUwEG_FFV4sYQGTnrRwFuIdb4djrWuiIuUwNA/exec";

// ===============================
// ✅ Envoyer message Telegram
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
// ✅ Envoyer vente à Apps Script
// ===============================
async function addSaleToSheet(nom, telephone, produit, quantite) {
  await axios.post(SCRIPT_URL, {
    nom_complet: nom,
    telephone: telephone,
    produit: produit,
    quantite: Number(quantite),
  });
}

// ===============================
// ✅ Test Render
// ===============================
app.get("/", (_req, res) => {
  res.send("✅ OK SERVER RUNNING");
});

// ===============================
// ✅ Webhook Telegram
// ===============================
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const message = req.body.message;
    if (!message || !message.text) return;

    const chatId = message.chat.id;
    const userText = message.text.trim();

    console.log("📩 Message reçu :", userText);

    // ===============================
    // ✅ Vente : Nom, Téléphone, Produit, Quantité
    // ===============================
    if (userText.includes(",")) {
      const parts = userText.split(",");

      if (parts.length < 4) {
        await sendTelegram(
          chatId,
          "❌ Format attendu : Nom, Téléphone, Produit, Quantité"
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

      // ✅ Envoyer à Google Sheet
      await addSaleToSheet(nom, telephone, produit, quantite);

      // ✅ Confirmation
      await sendTelegram(
        chatId,
        `✅ Vente enregistrée : ${nom} / ${produit} x${quantite}`
      );

      return;
    }

    // Message aide
    await sendTelegram(
      chatId,
      "💡 Exemple : Mélissa, 56565655, Blue, 2"
    );
  } catch (err) {
    console.log("❌ Erreur webhook :", err.message);
  }
});

// ===============================
// ✅ Lancer serveur
// ===============================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("🚀 Serveur démarré sur le port", PORT);
});
