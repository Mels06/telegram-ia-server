require("dotenv").config();
const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

// ✅ URL Apps Script
const SCRIPT_URL =
  "https://script.google.com/macros/s/AKfycbwBJjWvypfxR_Z2ZOaOLQyOV0js2r3pLrUwEG_FFV4sYQGTnrRwFuIdb4djrWuiIuUwNA/exec";

// ✅ Telegram send message
async function sendTelegram(chatId, text) {
  await axios.post(
    `https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`,
    {
      chat_id: chatId,
      text,
    }
  );
}

// ✅ Add sale to Google Sheet
async function addSaleToSheet(nom, telephone, produit, prix, quantite) {
  await axios.post(SCRIPT_URL, {
    nom,
    telephone,
    produit,
    prix: Number(prix),
    quantite: Number(quantite),
  });
}

// ✅ Route test Render
app.get("/", (req, res) => {
  res.send("OK SERVER RUNNING ✅");
});

// ✅ Webhook Telegram
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  const message = req.body.message;
  if (!message || !message.text) return;

  const chatId = message.chat.id;
  const userText = message.text;

  console.log("Message reçu :", userText);

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

    const nom = parts[0].trim();
    const telephone = parts[1].trim();
    const produit = parts[2].trim();
    const prix = parts[3].trim();
    const quantite = parts[4].trim();

    await addSaleToSheet(nom, telephone, produit, prix, quantite);

    await sendTelegram(
      chatId,
      `✅ Vente enregistrée : ${nom} / ${produit} / ${prix} FCFA x${quantite}`
    );

    return;
  }

  // ✅ Message normal
  await sendTelegram(
    chatId,
    "💡 Envoie une vente comme : Nom, Téléphone, Produit, Prix, Quantité"
  );
});

// ✅ Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Serveur démarré sur le port", PORT);
});
