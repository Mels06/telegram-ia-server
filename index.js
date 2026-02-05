require("dotenv").config();
const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

// ✅ URL Google Apps Script
const SCRIPT_URL =
  "https://script.google.com/macros/s/AKfycbwBJjWvypfxR_Z2ZOaOLQyOV0js2r3pLrUwEG_FFV4sYQGTnrRwFuIdb4djrWuiIuUwNA/exec";

// ✅ Fonction Telegram
async function sendTelegram(chatId, text) {
  await axios.post(
    `https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`,
    {
      chat_id: chatId,
      text: text,
    }
  );
}

// ✅ Webhook Telegram
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const message = req.body.message;
    if (!message || !message.text) return;

    const chatId = message.chat.id;
    const userText = message.text;

    console.log("Message reçu :", userText);

    // ✅ Si vente (5 infos séparées par virgule)
    if (userText.includes(",")) {
      const parts = userText.split(",");

      if (parts.length !== 5) {
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

      // ✅ Envoyer à Google Sheet
      await axios.post(SCRIPT_URL, {
        nom,
        telephone,
        produit,
        prix,
        quantite,
      });

      // ✅ Confirmation
      await sendTelegram(
        chatId,
        `✅ Vente enregistrée : ${nom} / ${produit} / ${prix} FCFA x${quantite}`
      );

      return;
    }

    // ✅ Sinon aide
    await sendTelegram(
      chatId,
      "💡 Envoie une vente comme : Nom, Téléphone, Produit, Prix, Quantité"
    );
  } catch (err) {
    console.log("Erreur webhook :", err);
  }
});

// ✅ Lancer serveur
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Serveur démarré sur le port", PORT);
});
