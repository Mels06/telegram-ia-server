require("dotenv").config();
const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

// ✅ Apps Script URL
const SCRIPT_URL =
  "https://script.google.com/macros/s/AKfycbwBJjWvypfxR_Z2ZOaOLQyOV0js2r3pLrUwEG_FFV4sYQGTnrRwFuIdb4djrWuiIuUwNA/exec";

// ✅ Telegram sendMessage
async function sendTelegram(chatId, text) {
  return axios.post(
    `https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`,
    {
      chat_id: chatId,
      text: text,
    }
  );
}

// ✅ Webhook route
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const message = req.body.message;
    if (!message || !message.text) return;

    const chatId = message.chat.id;
    const userText = message.text.trim();

    console.log("📩 Message reçu :", userText);

    // ✅ Vente format
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

      // ✅ Send to Google Sheet
      await axios.post(SCRIPT_URL, {
        nom_complet,
        telephone,
        produit,
        prix_unitaire,
        quantite,
        montant_total,
      });

      // ✅ Confirmation
      await sendTelegram(
        chatId,
        `✅ Vente enregistrée : ${nom_complet} / ${produit} / ${montant_total} FCFA`
      );

      return;
    }

    // ✅ Default help message
    await sendTelegram(
      chatId,
      "💡 Envoie une vente comme : Nom, Téléphone, Produit, Prix, Quantité"
    );
  } catch (err) {
    console.log("❌ Erreur webhook :", err.message);
  }
});

// ✅ Test route
app.get("/", (req, res) => {
  res.send("OK SERVER RUNNING");
});

// ✅ Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("✅ Serveur démarré sur le port", PORT);
});
