require("dotenv").config();
const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

const OpenAI = require("openai");

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ===============================
// ✅ CONFIG
// ===============================
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;

const SCRIPT_URL =
  "https://script.google.com/macros/s/AKfycbwBJjWvypfxR_Z2ZOaOLQyOV0js2r3pLrUwEG_FFV4sYQGTnrRwFuIdb4djrWuiIuUwNA/exec";

// ===============================
// ✅ SEND TELEGRAM MESSAGE
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

async function askGPT(text) {
  const response = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: "Tu es un assistant commercial intelligent." },
      { role: "user", content: text }
    ]
  });

  return response.choices[0].message.content;
}

// ===============================
// ✅ SAVE SALE TO GOOGLE SHEET
// ===============================
async function addSaleToSheet(nom, telephone, produit, prix, quantite) {
  const prix_unitaire = Number(prix);
  const qte = Number(quantite);
  const montant_total = prix_unitaire * qte;

  return axios.post(SCRIPT_URL, {
    nom_complet: nom,
    telephone: telephone,
    produit: produit,
    prix_unitaire: prix_unitaire,
    quantite: qte,
  });
}

// ===============================
// ✅ TEST ROUTE
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

    // ✅ Bonjour normal
    if (userText.toLowerCase() === "bonjour") {
      await sendTelegram(chatId, "👋 Bonjour Mélissa ! Envoie une vente 😊");
      return;
    }

    // ✅ Vente format CSV
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

      if (isNaN(prix) || isNaN(quantite)) {
        await sendTelegram(chatId, "❌ Prix et quantité doivent être des nombres.");
        return;
      }

      await addSaleToSheet(nom, telephone, produit, prix, quantite);

      await sendTelegram(
        chatId,
        `✅ Vente enregistrée : ${nom} / ${produit} / ${prix} FCFA x${quantite}`
      );

      return;
    }

    // Message aide
    await sendTelegram(
      chatId,
      "💡 Envoie une vente comme : Nom, Téléphone, Produit, Prix, Quantité"
    );
  } catch (err) {
    console.log("❌ Erreur webhook :", err.message);
  }
});

// Si ce n’est pas une vente → GPT répond
const reply = await askGPT(userText);
await sendTelegram(chatId, reply);

// ===============================
// ✅ START SERVER
// ===============================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("🚀 Serveur démarré sur le port", PORT);
});
