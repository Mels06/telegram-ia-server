require("dotenv").config();
const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

// ✅ URL Google Apps Script
const SCRIPT_URL =
  "https://script.google.com/macros/s/AKfycbwBJjWvypfxR_Z2ZOaOLQyOV0js2r3pLrUwEG_FFV4sYQGTnrRwFuIdb4djrWuiIuUwNA/exec";

// ✅ Fonction envoyer message Telegram
async function sendTelegram(chatId, text) {
  await axios.post(
    `https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`,
    {
      chat_id: chatId,
      text: text,
    }
  );
}

// ✅ Fonction envoyer vente à Google Sheet
async function addSaleToSheet(nom, telephone, produit, prix, quantite) {
  await axios.post(SCRIPT_URL, {
    nom,
    telephone,
    produit,
    prix: Number(prix),
    quantite: Number(quantite),
  });
}

// ✅ WEBHOOK TELEGRAM
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const message = req.body.message;
    if (!message || !message.text) return;

    const chatId = message.chat.id;
    const userText = message.text;

    console.log("✅ Message reçu :", userText);

    // ✅ Si c’est une vente (5 infos séparées par virgule)
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

      // ✅ Ajouter dans Google Sheet
      await addSaleToSheet(nom, telephone, produit, prix, quantite);

      // ✅ Confirmation Telegram
      await sendTelegram(
        chatId,
        `✅ Vente enregistrée : ${nom} / ${produit} / ${prix} FCFA x${quantite}`
      );

      return;
    }

    // ✅ Sinon message d’aide
    await sendTelegram(
      chatId,
      "💡 Envoie une vente comme : Nom, Téléphone, Produit, Prix, Quantité"
    );
  } catch (err) {
    console.log("❌ ERREUR :", err.message);
  }
});

// ✅ Route test Render
app.get("/", (req, res) => {
  res.send("OK SERVER RUNNING ✅");
});

// ✅ Lancer serveur
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("🚀 Serveur démarré sur le port", PORT);
});
