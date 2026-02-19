require("dotenv").config();
const express = require("express");
const axios   = require("axios");
const OpenAI  = require("openai");

const app = express();
app.use(express.json());

// ==============================
// ENV
// ==============================
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SCRIPT_URL     = "https://script.google.com/macros/s/AKfycbwBJjWvypfxR_Z2ZOaOLQyOV0js2r3pLrUwEG_FFV4sYQGTnrRwFuIdb4djrWuiIuUwNA/exec";

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

  // ⚠️ On utilise fetch natif au lieu d'axios
  // pour éviter la perte du body lors de la redirection Google
  const response = await fetch(SCRIPT_URL, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    payload,
    redirect: "follow",
  });

  const result = await response.json();
  console.log("✅ Réponse Google Sheet :", JSON.stringify(result));

  return { prixNum, quantiteNum, montantTotal };
}

// ==============================
// GOOGLE SHEET — Lire les ventes du jour
// ==============================
async function getTodaySales() {
  const response = await axios.get(SCRIPT_URL, {
    params: { action: "today_sales" },
  });
  return response.data;
}

// ==============================
// GOOGLE SHEET — Lire le stock
// ==============================
async function getStock() {
  const response = await axios.get(SCRIPT_URL, {
    params: { action: "stock" },
  });
  return response.data;
}

// ==============================
// GPT — Assistant commercial
// ==============================
async function askGPT(userText, context = "") {
  try {
    const systemPrompt = `Tu es un assistant commercial intelligent d'une entreprise.
Tu réponds UNIQUEMENT sur les sujets liés à l'entreprise : ventes, stocks, produits, commandes, chiffres, gestion commerciale.
Si la question est hors sujet, réponds poliment que tu ne traites que les sujets commerciaux.
Sois concis, professionnel et utile.
${context ? `\nContexte actuel :\n${context}` : ""}`;

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
    return "⚠️ Erreur GPT. Réessaie dans un instant.";
  }
}

// ==============================
// ROUTES
// ==============================
app.get("/", (req, res) => res.send("✅ Serveur opérationnel"));

app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // Répondre immédiatement à Telegram

  try {
    const message = req.body.message;
    if (!message || !message.text) return;

    const chatId = message.chat.id;
    const text   = message.text.trim();

    console.log("📩 Message reçu :", text);

    // ── /start ──────────────────────────────────────────────────────
    if (text === "/start") {
      await sendTelegram(chatId,
        `👋 *Bienvenue sur le bot commercial !*\n\n` +
        `Voici ce que je peux faire :\n\n` +
        `📝 *Enregistrer une vente :*\n` +
        `\`Nom, Téléphone, Produit, Prix, Quantité\`\n` +
        `Exemple : \`Mélissa, 45454544, soft, 15000, 2\`\n\n` +
        `📊 \`commandes\` → ventes du jour\n` +
        `📦 \`stock\` → état du stock\n\n` +
        `Tu peux aussi poser des questions commerciales librement !`
      );
      return;
    }

    // ── commandes du jour ────────────────────────────────────────────
    if (text.toLowerCase() === "commandes") {
      try {
        const data = await getTodaySales();
        if (data.status !== "ok") throw new Error("Erreur lecture sheet");

        if (data.total_ventes === 0) {
          await sendTelegram(chatId, "📊 Aucune vente enregistrée aujourd'hui.");
          return;
        }

        let msg = `📊 *Ventes du ${data.date}*\n\n`;
        msg += `🔢 Nombre de ventes : *${data.total_ventes}*\n`;
        msg += `💰 Chiffre du jour : *${data.total_montant.toLocaleString("fr-FR")}*\n\n`;
        msg += `📋 *Détail :*\n`;
        data.detail.forEach((v, i) => {
          msg += `${i + 1}. ${v.nom} — ${v.produit} — ${Number(v.montant).toLocaleString("fr-FR")}\n`;
        });

        await sendTelegram(chatId, msg);
      } catch (e) {
        console.error("❌ Erreur lecture ventes :", e.message);
        await sendTelegram(chatId, "⚠️ Impossible de lire les ventes du jour.");
      }
      return;
    }

    // ── stock ────────────────────────────────────────────────────────
    if (text.toLowerCase() === "stock") {
      try {
        const data = await getStock();
        if (data.status !== "ok") throw new Error("Erreur lecture stock");

        let msg = `📦 *État du stock :*\n\n`;
        data.stock.forEach((item) => {
          const emoji = item.quantite_restante < 10 ? "🔴" : "🟢";
          msg += `${emoji} ${item.produit} : *${item.quantite_restante}* unités\n`;
        });

        await sendTelegram(chatId, msg);
      } catch (e) {
        console.error("❌ Erreur lecture stock :", e.message);
        await sendTelegram(chatId, "⚠️ Impossible de lire le stock.");
      }
      return;
    }

    // ── Enregistrement vente (format CSV avec virgules) ──────────────
    if (text.includes(",")) {
      const parts = text.split(",").map((p) => p.trim());

      if (parts.length < 5) {
        await sendTelegram(chatId,
          `❌ *Format incorrect.*\n\n` +
          `Format attendu :\n\`Nom, Téléphone, Produit, Prix, Quantité\`\n\n` +
          `Exemple :\n\`Mélissa, 45454544, soft, 15000, 1\``
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
        await sendTelegram(chatId,
          `❌ *Prix ou quantité invalide.*\nAssure-toi que ce sont des nombres.\n\nExemple : \`Mélissa, 45454544, soft, 15000, 1\``
        );
        return;
      }

      try {
        const { prixNum, quantiteNum, montantTotal } = await addSaleToSheet(nom, tel, produit, prix, quantite);
        await sendTelegram(chatId,
          `✅ *Vente enregistrée avec succès !*\n\n` +
          `👤 Client : ${nom}\n` +
          `📞 Tél : ${tel}\n` +
          `📦 Produit : ${produit}\n` +
          `💲 Prix unitaire : ${prixNum.toLocaleString("fr-FR")}\n` +
          `🔢 Quantité : ${quantiteNum}\n` +
          `💰 Total : *${montantTotal.toLocaleString("fr-FR")}*`
        );
      } catch (e) {
        console.error("❌ Erreur enregistrement vente :", e.message);
        await sendTelegram(chatId, "⚠️ Erreur lors de l'enregistrement. Vérifie tes données.");
      }
      return;
    }

    // ── Question libre → GPT avec contexte ventes du jour ───────────
    let context = "";
    try {
      // On enrichit GPT avec les ventes du jour si disponibles
      const sales = await getTodaySales();
      if (sales.status === "ok" && sales.total_ventes > 0) {
        context = `Ventes du jour (${sales.date}) : ${sales.total_ventes} vente(s), montant total : ${sales.total_montant}.`;
      }
    } catch (_) {}

    const reply = await askGPT(text, context);
    await sendTelegram(chatId, reply);

  } catch (err) {
    console.error("❌ Erreur Webhook globale :", err.message);
  }
});

// ==============================
// START
// ==============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Serveur lancé sur le port ${PORT}`));