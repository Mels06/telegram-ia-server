// ===============================
// ✅ BOT TELEGRAM + GOOGLE SHEET
// ===============================

require("dotenv").config();
const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

// ===============================
// ✅ Variables obligatoires
// ===============================
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;

const SCRIPT_URL =
  "https://script.google.com/macros/s/AKfycbwBJjWvypfxR_Z2ZOaOLQyOV0js2r3pLrUwEG_FFV4sYQGTnrRwFuIdb4djrWuiIuUwNA/exec";

// ===============================
// ✅ Fonction envoyer message Telegram
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
// ✅ Fonction envoyer vente vers Google Sheet
// ===============================
async function addSaleToSheet(nom, telephone, produit, prix, quantite) {
  return axios.post(SCRIPT_URL, {
  nom_complet: nom,
  telephone: telephone,
  produit: produit,
  prix_unitaire: prix,
  quantite: quantite
}

// ===============================
// ✅ Route test Render
// ===============================
app.get("/", (req, res) => {
  res.send("✅ OK SERVER RUNNING");
});

// ===============================
// ✅ WEBHOOK TELEGRAM (COMPLET)
// ===============================
app.post("/webhook", async (req, res) => {
  // Telegram exige une réponse immédiate
  res.sendStatus(200);

  try {
    const message = req.body.message;
    if (!message || !message.text) return;

    const chatId = message.chat.id;
    const userText = message.text.trim();

    console.log("📩 Message reçu :", userText);

    // ===============================
    // ✅ Si message contient une vente
    // Format : Nom, Téléphone, Produit, Prix, Quantité
    // ===============================
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
      const prix = parts[3].trim();
      const quantite = parts[4].trim();

      // ✅ Envoi vers Google Sheet
      await addSaleToSheet(nom, telephone, produit, prix, quantite);

      // ✅ Confirmation Telegram
      await sendTelegram(
        chatId,
        `✅ Vente enregistrée : ${nom} / ${produit} / ${prix} FCFA x${quantite}`
      );

      return;
    }

    // ===============================
    // ✅ Sinon message normal
    // ===============================
    await sendTelegram(
      chatId,
      "💡 Envoie une vente comme : Nom, Téléphone, Produit, Prix, Quantité"
    );
  } catch (err) {
    console.log("❌ Erreur webhook :", err.message);
  }
});

// ===============================
// ✅ Lancer serveur Render
// ===============================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("✅ Serveur démarré sur le port", PORT);
});
