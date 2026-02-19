require("dotenv").config();
const express = require("express");
const axios = require("axios");
const OpenAI = require("openai");

const app = express();
app.use(express.json());

// ==============================
// ENV variables
// ==============================
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SCRIPT_URL = "https://script.google.com/macros/s/AKfycbwBJjWvypfxR_Z2ZOaOLQyOV0js2r3pLrUwEG_FFV4sYQGTnrRwFuIdb4djrWuiIuUwNA/exec";

// ==============================
// OpenAI Client
// ==============================
const client = new OpenAI({ apiKey: OPENAI_API_KEY });

// ==============================
// Utils
// ==============================

// Envoyer un message Telegram
async function sendTelegram(chatId, text) {
  try {
    await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
      {
        chat_id: chatId,
        text: text,
        parse_mode: "Markdown",
      }
    );
  } catch (err) {
    console.error("❌ Erreur d'envoi Telegram :", err.message);
  }
}

// Ajouter une vente dans Google Sheet
async function addSaleToSheet(nom, tel, produit, prix, quantite) {
  const prixNum = parseFloat(String(prix).replace(",", "."));
  const quantiteNum = parseInt(String(quantite), 10);

  if (isNaN(prixNum) || isNaN(quantiteNum)) {
    throw new Error("Prix ou quantité invalide");
  }

  const montantTotal = prixNum * quantiteNum;

  const payload = {
    nom_complet: nom,
    telephone: String(tel).trim(),
    produit: produit,
    prix_unitaire: prixNum,
    quantite: quantiteNum,
    montant_total: montantTotal,
    statut: "validé",
  };

  console.log("📤 Payload envoyé à Google Sheet :", JSON.stringify(payload));

  const response = await axios.post(SCRIPT_URL, payload, {
    headers: { "Content-Type": "application/json" },
  });

  console.log("✅ Réponse Google Sheet :", response.data);
  return { prixNum, quantiteNum, montantTotal };
}

// Demander à GPT (assistant commercial)
async function askGPT(userText) {
  try {
    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `Tu es un assistant commercial intelligent d'une entreprise.
Tu réponds UNIQUEMENT sur les sujets liés à l'entreprise : ventes, stocks, produits, commandes, chiffres, gestion commerciale.
Si la question est hors sujet, réponds poliment que tu ne peux traiter que les sujets commerciaux.
Réponds de manière concise et professionnelle.`,
        },
        { role: "user", content: userText },
      ],
    });
    return response.choices[0].message.content;
  } catch (err) {
    console.error("❌ Erreur OpenAI :", err.message);
    return "⚠️ Erreur de traitement avec GPT. Réessaie dans un instant.";
  }
}

// ==============================
// Routes
// ==============================

// Route de test
app.get("/", (req, res) => {
  res.send("✅ Serveur opérationnel");
});

// Webhook Telegram
app.post("/webhook", async (req, res) => {
  // Répondre immédiatement à Telegram pour éviter le timeout
  res.sendStatus(200);

  try {
    const message = req.body.message;
    if (!message || !message.text) return;

    const chatId = message.chat.id;
    const text = message.text.trim();

    console.log("📩 Message reçu :", text);

    // ─── Commande /start ───────────────────────────────────────────
    if (text === "/start") {
      await sendTelegram(
        chatId,
        `👋 *Bienvenue sur le bot commercial !*\n\n` +
        `Voici ce que je peux faire :\n\n` +
        `📝 *Enregistrer une vente :*\n` +
        `Format : \`Nom, Téléphone, Produit, Prix, Quantité\`\n` +
        `Exemple : \`Jean Dupont, 0612345678, soft, 500, 2\`\n\n` +
        `📦 Tape \`stock\` pour voir le stock\n` +
        `📊 Tape \`commandes\` pour les commandes du jour\n\n` +
        `Tu peux aussi me poser des questions commerciales librement !`
      );
      return;
    }

    // ─── Commande stock ────────────────────────────────────────────
    if (text.toLowerCase() === "stock") {
      await sendTelegram(chatId, "📦 La gestion de stock arrive bientôt. Reste connecté !");
      return;
    }

    // ─── Commande commandes ────────────────────────────────────────
    if (text.toLowerCase() === "commandes") {
      await sendTelegram(chatId, "📊 Récapitulatif des commandes du jour bientôt disponible !");
      return;
    }

    // ─── Enregistrement d'une vente (format avec virgules) ─────────
    if (text.includes(",")) {
      const parts = text.split(",").map((p) => p.trim());

      if (parts.length < 5) {
        await sendTelegram(
          chatId,
          `❌ *Format incorrect.*\n\n` +
          `Format attendu :\n\`Nom, Téléphone, Produit, Prix, Quantité\`\n\n` +
          `Exemple :\n\`Jean Dupont, 0612345678, soft, 500, 2\``
        );
        return;
      }

      const [nom, tel, produit, prix, quantite] = parts;

      if (!nom || !tel || !produit) {
        await sendTelegram(chatId, "❌ Nom, téléphone et produit ne peuvent pas être vides.");
        return;
      }

      // Vérification que prix et quantité sont bien des nombres
      const prixTest = parseFloat(String(prix).replace(",", "."));
      const quantiteTest = parseInt(String(quantite), 10);

      if (isNaN(prixTest) || isNaN(quantiteTest)) {
        await sendTelegram(
          chatId,
          `❌ *Prix ou quantité invalide.*\nAssure-toi que le prix et la quantité sont des nombres.\n\nExemple : \`Jean, 0612345678, soft, 500, 2\``
        );
        return;
      }

      try {
        const { prixNum, quantiteNum, montantTotal } = await addSaleToSheet(nom, tel, produit, prix, quantite);
        await sendTelegram(
          chatId,
          `✅ *Vente enregistrée avec succès !*\n\n` +
          `👤 Client : ${nom}\n` +
          `📞 Tél : ${tel}\n` +
          `📦 Produit : ${produit}\n` +
          `💲 Prix unitaire : ${prixNum}\n` +
          `🔢 Quantité : ${quantiteNum}\n` +
          `💰 Total : *${montantTotal}*`
        );
      } catch (e) {
        console.error("❌ Erreur enregistrement vente :", e.message);
        await sendTelegram(
          chatId,
          "⚠️ Erreur lors de l'enregistrement dans le tableau. Vérifie les données et réessaie."
        );
      }
      return;
    }

    // ─── Question libre → GPT ──────────────────────────────────────
    const reply = await askGPT(text);
    await sendTelegram(chatId, reply);

  } catch (err) {
    console.error("❌ Erreur Webhook globale :", err.message);
  }
});

// ==============================
// Lancement du serveur
// ==============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Serveur lancé sur le port ${PORT}`);
});