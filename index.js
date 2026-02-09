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
// ✅ TELEGRAM SEND
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
// ✅ ENVOYER VENTE AU SHEET
// ===============================

async function addSaleToSheet(nom, telephone, produit, prix, quantite) {
  await axios.post(SCRIPT_URL, {
    nom_complet: nom,
    telephone: telephone,
    produit: produit,
    prix_unitaire: Number(prix),
    quantite: Number(quantite),
  });
}

// ===============================
// ✅ TEST SERVER
// ===============================

app.get("/", (req, res) => {
  res.send("✅ OK SERVER RUNNING");
});

// ===============================
// ✅ WEBHOOK TELEGRAM
// ===============================

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const message = req.body.message;
    if (!message || !message.text) return;

    const chatId = message.chat.id;
    const userText = message.text.trim();

    console.log("📩 Message reçu :", userText);

    // ✅ Bonjour
    if (
      userText.toLowerCase() === "bonjour" ||
      userText.toLowerCase() === "salut"
    ) {
      await sendTelegram(
        chatId,
        "👋 Bonjour !\n\n📌 Envoie une vente comme :\nNom, Téléphone, Produit, Prix, Quantité\n\nExemple : Marie, 0606, Soft, 15000, 2"
      );
      return;
    }

    // ✅ Vente format virgules
    if (userText.includes(",")) {
      const parts = userText.split(",");

      if (parts.length < 5) {
        await sendTelegram(
          chatId,
          "❌ Format incorrect.\nExemple : Marie, 0606, Soft, 15000, 2"
        );
        return;
      }

      const nom = parts[0].trim();
      const telephone = parts[1].trim();
      const produit = parts[2].trim();
      const prix = parts[3].trim();
      const quantite = parts[4].trim();

      // Vérification chiffres
      if (isNaN(prix) || isNaN(quantite)) {
        await sendTelegram(chatId, "❌ Prix et Quantité doivent être des nombres.");
        return;
      }

      // ✅ Envoi vers Sheet
      await addSaleToSheet(nom, telephone, produit, prix, quantite);

      // ✅ Confirmation
      await sendTelegram(
        chatId,
        `✅ Vente enregistrée :\n${nom} a acheté ${quantite} ${produit}\nPrix : ${prix} FCFA`
      );

      return;
    }

    // Message par défaut
    await sendTelegram(
      chatId,
      "🤖 Je n’ai pas compris.\n📌 Envoie : Nom, Téléphone, Produit, Prix, Quantité"
    );
  } catch (err) {
    console.log("❌ Erreur webhook :", err.message);
  }
});

// ===============================
// ✅ START SERVER
// ===============================

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("🚀 Serveur démarré sur le port", PORT);
});
