// ===============================
// ✅ BOT TELEGRAM + GOOGLE SHEET
// ===============================

require("dotenv").config();
const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

// ===============================
// ✅ CONFIGURATION
// ===============================

// Token Telegram (Render > Environment)
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;

// URL Apps Script (Web App)
const SCRIPT_URL =
  "https://script.google.com/macros/s/AKfycbwBJjWvypfxR_Z2ZOaOLQyOV0js2r3pLrUwEG_FFV4sYQGTnrRwFuIdb4djrWuiIuUwNA/exec";

// ===============================
// ✅ Envoyer un message Telegram
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
// ✅ Ajouter une vente dans Google Sheet
// ===============================
async function addSaleToSheet(
  nom_complet,
  telephone,
  produit,
  prix,
  quantite,
  montant
) {
  await axios.post(SCRIPT_URL, {
    nom_complet: nom_complet,
    telephone: telephone,
    produit: produit,
    prix_unitaire: Number(prix),
    quantite: Number(quantite),
    montant_total: Number(montant),
  });
}

// ===============================
// ✅ Route de test Render
// ===============================
app.get("/", (req, res) => {
  res.send("✅ OK SERVER RUNNING");
});

// ===============================
// ✅ Webhook Telegram
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
    // ✅ Si l'utilisateur envoie une vente
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

      // Extraction des données
      const nom_complet = parts[0].trim();
      const telephone = parts[1].trim();
      const produit = parts[2].trim();
      const prix = parts[3].trim();
      const quantite = parts[4].trim();

      // Enregistrer dans Google Sheet
      await addSaleToSheet(
        nom_complet,
        telephone,
        produit,
        prix,
        quantite
      );

      // Confirmation Telegram
      await sendTelegram(
        chatId,
        `✅ Vente enregistrée : ${nom_complet} / ${produit} / ${prix} FCFA x${quantite}`
      );

      return;
    }

    // ===============================
    // ✅ Message d’aide si format incorrect
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
// ✅ Lancer le serveur Render
// ===============================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("🚀 Serveur démarré sur le port", PORT);
});
