require("dotenv").config();
const express = require("express");
const axios   = require("axios");
const OpenAI  = require("openai");

const app = express();
app.use(express.json());

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// ✅ NOUVELLE URL mise à jour
const SCRIPT_URL = "https://script.google.com/macros/s/AKfycbyuNzvkLMEfVGbvO22dAOqPMrBVjUn7RC_VnlMYvhd1cN0LPEzWXJiIfrVFlSKRGJ6WcA/exec";

const client = new OpenAI({ apiKey: OPENAI_API_KEY });

// ==============================
// TELEGRAM
// ==============================
async function sendTelegram(chatId, text) {
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      chat_id:    chatId,
      text:       text,
      parse_mode: "Markdown",
    });
  } catch (err) {
    console.error("❌ Erreur Telegram :", err.message);
  }
}

// ==============================
// GOOGLE SHEET — Ajouter une vente
// ==============================
async function addSaleToSheet(nom, tel, produit, prix, quantite) {
  const prixNum     = parseFloat(String(prix).replace(",", "."));
  const quantiteNum = parseInt(String(quantite), 10);

  if (isNaN(prixNum) || isNaN(quantiteNum)) {
    throw new Error("Prix ou quantité invalide");
  }

  const montantTotal = prixNum * quantiteNum;

  const payload = JSON.stringify({
    nom_complet:   nom,
    telephone:     String(tel).trim(),
    produit:       String(produit).trim(),
    prix_unitaire: prixNum,
    quantite:      quantiteNum,
    montant_total: montantTotal,
    statut:        "validé"
  });

  console.log("📤 Payload envoyé :", payload);

  // Utilise fetch natif (Node 18+) pour bien suivre la redirection Google
  const response = await fetch(SCRIPT_URL, {
    method:   "POST",
    headers:  { "Content-Type": "application/json" },
    body:     payload,
    redirect: "follow",
  });

  const result = await response.json();
  console.log("✅ Réponse Google Sheet :", JSON.stringify(result));

  if (result.status !== "ok") {
    throw new Error("Google Sheet a retourné une erreur : " + result.message);
  }

  return { prixNum, quantiteNum, montantTotal };
}

// ==============================
// GOOGLE SHEET — Ventes du jour
// ==============================
async function getTodaySales() {
  const response = await fetch(`${SCRIPT_URL}?action=today_sales`);
  return response.json();
}

// ==============================
// GOOGLE SHEET — Stock
// ==============================
async function getStock() {
  const response = await fetch(`${SCRIPT_URL}?action=stock`);
  return response.json();
}

// ==============================
// GPT
// ==============================
async function askGPT(userText, context = "") {
  try {
    const systemPrompt =
      `Tu es un assistant commercial d'une entreprise. Tu réponds UNIQUEMENT sur : ventes, stocks, produits, commandes, chiffres, gestion commerciale. Sois concis et professionnel.` +
      (context ? `\n\nContexte du jour : ${context}` : "");

    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: userText },
      ],
    });
    return response.choices[0].message.content;
  } catch (err) {
    console.error("❌ Erreur OpenAI :", err.message);
    return "⚠️ Erreur GPT. Réessaie.";
  }
}

// ==============================
// WEBHOOK
// ==============================
app.get("/", (req, res) => res.send("✅ Serveur opérationnel"));

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const message = req.body.message;
    if (!message || !message.text) return;

    const chatId = message.chat.id;
    const text   = message.text.trim();

    console.log("📩 Message reçu :", text);

    // /start
    if (text === "/start") {
      await sendTelegram(chatId,
        `👋 *Bienvenue sur le bot commercial !*\n\n` +
        `📝 *Enregistrer une vente :*\n\`Nom, Téléphone, Produit, Prix, Quantité\`\n` +
        `Exemple : \`Mélissa, 45454544, soft, 15000, 1\`\n\n` +
        `📊 \`commandes\` → ventes du jour\n` +
        `📦 \`stock\` → état du stock\n\n` +
        `Pose aussi des questions commerciales librement !`
      );
      return;
    }

    // commandes du jour
    if (text.toLowerCase() === "commandes") {
      try {
        const data = await getTodaySales();
        if (data.total_ventes === 0) {
          await sendTelegram(chatId, "📊 Aucune vente enregistrée aujourd'hui.");
          return;
        }
        let msg = `📊 *Ventes du ${data.date}*\n\n🔢 Nombre : *${data.total_ventes}*\n💰 CA : *${Number(data.total_montant).toLocaleString("fr-FR")}*\n\n📋 *Détail :*\n`;
        data.detail.forEach((v, i) => {
          msg += `${i + 1}. ${v.nom} — ${v.produit} — ${Number(v.montant).toLocaleString("fr-FR")}\n`;
        });
        await sendTelegram(chatId, msg);
      } catch (e) {
        await sendTelegram(chatId, "⚠️ Impossible de lire les ventes du jour.");
      }
      return;
    }

    // stock
    if (text.toLowerCase() === "stock") {
      try {
        const data = await getStock();
        let msg = `📦 *État du stock :*\n\n`;
        data.stock.forEach((item) => {
          const emoji = item.quantite_restante < 10 ? "🔴" : "🟢";
          msg += `${emoji} ${item.produit} : *${item.quantite_restante}* unités\n`;
        });
        await sendTelegram(chatId, msg);
      } catch (e) {
        await sendTelegram(chatId, "⚠️ Impossible de lire le stock.");
      }
      return;
    }

    // Enregistrement vente
    if (text.includes(",")) {
      const parts = text.split(",").map((p) => p.trim());

      if (parts.length < 5) {
        await sendTelegram(chatId,
          `❌ *Format incorrect.*\n\nFormat : \`Nom, Téléphone, Produit, Prix, Quantité\`\nExemple : \`Mélissa, 45454544, soft, 15000, 1\``
        );
        return;
      }

      const [nom, tel, produit, prix, quantite] = parts;

      if (!nom || !tel || !produit) {
        await sendTelegram(chatId, "❌ Nom, téléphone et produit ne peuvent pas être vides.");
        return;
      }

      const prixTest     = parseFloat(String(prix).replace(",", "."));
      const quantiteTest = parseInt(String(quantite), 10);

      if (isNaN(prixTest) || isNaN(quantiteTest)) {
        await sendTelegram(chatId, `❌ Prix ou quantité invalide.\nExemple : \`Mélissa, 45454544, soft, 15000, 1\``);
        return;
      }

      try {
        const { prixNum, quantiteNum, montantTotal } = await addSaleToSheet(nom, tel, produit, prix, quantite);
        await sendTelegram(chatId,
          `✅ *Vente enregistrée !*\n\n` +
          `👤 ${nom}\n📞 ${tel}\n📦 ${produit}\n` +
          `💲 Prix unitaire : ${prixNum.toLocaleString("fr-FR")}\n` +
          `🔢 Quantité : ${quantiteNum}\n` +
          `💰 Total : *${montantTotal.toLocaleString("fr-FR")}*`
        );
      } catch (e) {
        console.error("❌ Erreur vente :", e.message);
        await sendTelegram(chatId, "⚠️ Erreur lors de l'enregistrement. Vérifie tes données.");
      }
      return;
    }

    // GPT avec contexte ventes du jour
    let context = "";
    try {
      const sales = await getTodaySales();
      if (sales.status === "ok" && sales.total_ventes > 0) {
        context = `Ventes du jour (${sales.date}) : ${sales.total_ventes} vente(s), CA total : ${sales.total_montant}.`;
      }
    } catch (_) {}

    const reply = await askGPT(text, context);
    await sendTelegram(chatId, reply);

  } catch (err) {
    console.error("❌ Erreur Webhook globale :", err.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Serveur lancé sur le port ${PORT}`));