require("dotenv").config();
const express = require("express");
const axios = require("axios");

const { Configuration, OpenAIApi } = require("openai");

// ===============================
// CONFIG OPENAI (v3.1.1)
// ===============================
const configuration = new Configuration({
  apiKey: process.env.OPENAI_API_KEY,
});
const openai = new OpenAIApi(configuration);

// ===============================
// EXPRESS
// ===============================
const app = express();
app.use(express.json());

// ===============================
// URL APPS SCRIPT GOOGLE SHEET
// ===============================
const SCRIPT_URL =
  "https://script.google.com/macros/s/AKfycbwBJjWvypfxR_Z2ZOaOLQyOV0js2r3pLrUwEG_FFV4sYQGTnrRwFuIdb4djrWuiIuUwNA/exec";

// ===============================
// TELEGRAM SEND MESSAGE
// ===============================
async function sendTelegram(chatId, text) {
  await axios.post(
    `https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`,
    {
      chat_id: chatId,
      text: text,
    }
  );
}

// ===============================
// ENVOYER VENTE AU SHEET
// ===============================
async function addSaleToSheet(nom, telephone, produit, prix, quantite) {
  const montant_total = Number(prix) * Number(quantite);

  await axios.post(SCRIPT_URL, {
    nom_complet: nom,
    telephone: telephone,
    produit: produit,
    prix_unitaire: Number(prix),
    quantite: Number(quantite),
    montant_total: montant_total,
    statut: "validé",
  });
}

// ===============================
// GPT RESPONSE
// ===============================
async function askGPT(question) {
  const response = await openai.createChatCompletion({
    model: "gpt-3.5-turbo",
    messages: [
      { role: "system", content: "Tu es un assistant utile et clair." },
      { role: "user", content: question },
    ],
  });

  return response.data.choices[0].message.content;
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
    const userText = message.text.trim();

    console.log("Message reçu :", userText);

    // ===============================
    // VENTE FORMAT : 5 INFOS
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

    // ===============================
    // SINON GPT
    // ===============================
    const reply = await askGPT(userText);
    await sendTelegram(chatId, reply);
  } catch (err) {
    console.log("Erreur webhook :", err.message);
  }
});

// ===============================
// START SERVER
// ===============================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Serveur démarré sur le port", PORT);
});
