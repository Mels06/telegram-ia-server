require("dotenv").config();
const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

// ===============================
// CONFIG
// ===============================

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;

const SCRIPT_URL =
  "https://script.google.com/macros/s/AKfycbwBJjWvypfxR_Z2ZOaOLQyOV0js2r3pLrUwEG_FFV4sYQGTnrRwFuIdb4djrWuiIuUwNA/exec";

// ===============================
// TELEGRAM MESSAGE
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
// ENVOI GOOGLE SHEET (SANS MONTANT)
// ===============================

async function addSaleToSheet(nom, telephone, produit, prix, quantite) {
  return axios.post(SCRIPT_URL, {
    nom_complet: nom,
    telephone: telephone,
    produit: produit,
    prix_unitaire: Number(prix),
    quantite: Number(quantite),
  });
}

// ===============================
// TEST SERVER
// ===============================

app.get("/", (req, res) => {
  res.send("OK SERVER RUNNING");
});

// ===============================
// WEBHOOK TELEGRAM
// ===============================

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const message = req.body.message;
    if (!message || !message.text) return;

    const chatId = message.chat.id;
    const text = message.text.trim();

    console.log("Message reçu :", text);

    // Bonjour simple
    if (text.toLowerCase() === "bonjour") {
      await sendTelegram(
        chatId,
        "👋 Bonjour Mélissa !\n\n📌 Envoie une vente comme :\nNom, Téléphone, Produit, Prix, Quantité\n\nExemple : Marie, 0606, Soft, 15000, 2"
      );
      return;
    }

    // Vente avec virgules
    if (text.includes(",")) {
      const parts = text.split(",");

      if (parts.length !== 5) {
        await sendTelegram(
          chatId,
          "❌ Format exact : Nom, Téléphone, Produit, Prix, Quantité"
        );
        return;
      }

      const nom = parts[0].trim();
      const telephone = parts[1].trim();
      const produit = parts[2].trim();
      const prix = parts[3].trim();
      const quantite = parts[4].trim();

      if (isNaN(prix) || isNaN(quantite)) {
        await sendTelegram(chatId, "❌ Prix et Quantité doivent être des nombres.");
        return;
      }

      // ENVOI SHEET
      await addSaleToSheet(nom, telephone, produit, prix, quantite);

      // CONFIRMATION
      await sendTelegram(
        chatId,
        `✅ Vente enregistrée :\n${nom} / ${produit} (${quantite})\nPrix : ${prix} FCFA`
      );

      return;
    }

    // Sinon aide
    await sendTelegram(
      chatId,
      "📌 Je n’ai pas compris.\nEnvoie : Nom, Téléphone, Produit, Prix, Quantité"
    );
  } catch (err) {
    console.log("ERREUR :", err.message);
  }
});

// ===============================
// START
// ===============================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Serveur lancé sur", PORT));
