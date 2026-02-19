require("dotenv").config();
const express = require("express");
const axios   = require("axios");
const OpenAI  = require("openai");

const app = express();
app.use(express.json());

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SCRIPT_URL     = "https://script.google.com/macros/s/AKfycbyuNzvkLMEfVGbvO22dAOqPMrBVjUn7RC_VnlMYvhd1cN0LPEzWXJiIfrVFlSKRGJ6WcA/exec";

const client = new OpenAI({ apiKey: OPENAI_API_KEY });

// ==============================
// MÉMOIRE PAR UTILISATEUR (en mémoire RAM)
// Stocke les 10 derniers messages par chatId
// ==============================
const userMemory = {};

function getHistory(chatId) {
  if (!userMemory[chatId]) userMemory[chatId] = [];
  return userMemory[chatId];
}

function addToHistory(chatId, role, content) {
  if (!userMemory[chatId]) userMemory[chatId] = [];
  userMemory[chatId].push({ role, content });
  // Garder seulement les 10 derniers échanges
  if (userMemory[chatId].length > 20) {
    userMemory[chatId] = userMemory[chatId].slice(-20);
  }
}

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
// GOOGLE SHEET — Récupérer les données
// ==============================
async function fetchFromSheet(action) {
  const response = await fetch(`${SCRIPT_URL}?action=${action}`);
  return response.json();
}

// ==============================
// GOOGLE SHEET — Ajouter une vente
// ==============================
async function addSaleToSheet(nom, tel, produit, prix, quantite) {
  const prixNum     = parseFloat(String(prix).replace(",", "."));
  const quantiteNum = parseInt(String(quantite), 10);
  const montantTotal = prixNum * quantiteNum;

  const payload = JSON.stringify({
    nom_complet:   nom,
    telephone:     String(tel || "").trim(),
    produit:       String(produit).trim(),
    prix_unitaire: prixNum,
    quantite:      quantiteNum,
    montant_total: montantTotal,
    statut:        "validé"
  });

  console.log("📤 PAYLOAD:", payload);

  const response = await fetch(SCRIPT_URL, {
    method:   "POST",
    headers:  { "Content-Type": "application/json" },
    body:     payload,
    redirect: "follow",
  });

  const text   = await response.text();
  const result = JSON.parse(text);
  console.log("📥 REPONSE:", JSON.stringify(result));

  if (result.status !== "ok" && result.status !== "success") {
    throw new Error(result.message || "Erreur inconnue");
  }

  return { prixNum, quantiteNum, montantTotal };
}

// ==============================
// GPT INTELLIGENT avec accès aux données réelles
// ==============================
async function askGPT(chatId, userText) {
  try {
    // 1. Récupérer les données réelles du Google Sheet
    let dataContext = "";
    try {
      const [todaySales, allStats, stock] = await Promise.all([
        fetchFromSheet("today_sales"),
        fetchFromSheet("all_stats"),
        fetchFromSheet("stock"),
      ]);

      // Ventes du jour
      if (todaySales.status === "ok") {
        dataContext += `\n=== VENTES DU JOUR (${todaySales.date}) ===\n`;
        dataContext += `Nombre de ventes : ${todaySales.total_ventes}\n`;
        dataContext += `CA du jour : ${todaySales.total_montant}\n`;
        if (Object.keys(todaySales.par_produit || {}).length > 0) {
          dataContext += `Par produit aujourd'hui :\n`;
          for (const [p, v] of Object.entries(todaySales.par_produit)) {
            dataContext += `  - ${p} : ${v.quantite} unités vendues, ${v.montant} de CA\n`;
          }
        }
        if (todaySales.detail && todaySales.detail.length > 0) {
          dataContext += `Détail des ventes :\n`;
          todaySales.detail.forEach(v => {
            dataContext += `  - ${v.nom || "Inconnu"} : ${v.quantite}x ${v.produit} à ${v.prix} = ${v.montant}\n`;
          });
        }
      }

      // Stats globales
      if (allStats.status === "ok") {
        dataContext += `\n=== STATS GLOBALES (tous les temps) ===\n`;
        dataContext += `Total ventes : ${allStats.total_ventes}\n`;
        dataContext += `CA total : ${allStats.total_montant}\n`;
        if (Object.keys(allStats.par_produit || {}).length > 0) {
          dataContext += `Par produit (total) :\n`;
          for (const [p, v] of Object.entries(allStats.par_produit)) {
            dataContext += `  - ${p} : ${v.quantite} unités, ${v.montant} de CA\n`;
          }
        }
        if (Object.keys(allStats.par_jour || {}).length > 0) {
          dataContext += `Par jour :\n`;
          for (const [jour, v] of Object.entries(allStats.par_jour)) {
            dataContext += `  - ${jour} : ${v.ventes} vente(s), ${v.montant} de CA\n`;
          }
        }
      }

      // Stock
      if (stock.status === "ok") {
        dataContext += `\n=== STOCK ACTUEL ===\n`;
        stock.stock.forEach(item => {
          dataContext += `  - ${item.produit} : ${item.quantite_restante} unités restantes\n`;
        });
      }
    } catch (e) {
      console.error("⚠️ Erreur récupération données:", e.message);
      dataContext = "\n(Données du sheet temporairement indisponibles)\n";
    }

    // 2. Construire les messages avec mémoire
    const history = getHistory(chatId);

    const systemPrompt = `Tu es un assistant commercial intelligent d'une entreprise.
Tu as accès en temps réel aux données du Google Sheet de l'entreprise.
Tu réponds UNIQUEMENT sur les sujets commerciaux : ventes, stocks, produits, commandes, chiffres, clients.
Si quelqu'un parle d'une vente en langage naturel (ex: "j'ai vendu 2 sacs à Marie pour 5000"), 
réponds en confirmant les infos et demande ce qu'il manque (téléphone si absent).
Tu n'inventes JAMAIS de chiffres. Tu utilises UNIQUEMENT les données ci-dessous.
Si tu ne sais pas, dis-le clairement.

${dataContext}

Date et heure actuelles : ${new Date().toLocaleString("fr-FR")}`;

    const messages = [
      { role: "system", content: systemPrompt },
      ...history,
      { role: "user", content: userText }
    ];

    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
    });

    const reply = response.choices[0].message.content;

    // 3. Sauvegarder dans la mémoire
    addToHistory(chatId, "user",      userText);
    addToHistory(chatId, "assistant", reply);

    return reply;

  } catch (err) {
    console.error("❌ Erreur OpenAI :", err.message);
    return "⚠️ Erreur GPT. Réessaie dans un instant.";
  }
}

// ==============================
// DÉTECTER UNE VENTE EN LANGAGE NATUREL via GPT
// ==============================
async function extractSaleFromText(text) {
  try {
    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `Tu es un extracteur de données de vente. 
Analyse le message et si c'est une vente, retourne UNIQUEMENT un JSON avec :
{"is_sale": true, "nom": "...", "telephone": "...", "produit": "...", "prix_unitaire": 0, "quantite": 0}
Si le téléphone est absent, mets "telephone": "".
Si ce n'est PAS une vente, retourne : {"is_sale": false}
Réponds UNIQUEMENT avec le JSON, rien d'autre.`
        },
        { role: "user", content: text }
      ],
    });

    const raw = response.choices[0].message.content.trim();
    return JSON.parse(raw);
  } catch (e) {
    return { is_sale: false };
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
      userMemory[chatId] = []; // reset mémoire
      await sendTelegram(chatId,
        `👋 *Bienvenue sur le bot commercial !*\n\n` +
        `📝 *Enregistrer une vente (format rapide) :*\n` +
        `\`Nom, Téléphone, Produit, Prix, Quantité\`\n` +
        `Exemple : \`Mélissa, 45454544, soft, 15000, 1\`\n\n` +
        `💬 *Ou en langage naturel :*\n` +
        `"J'ai vendu 2 soft à Marie pour 15000"\n\n` +
        `📊 \`commandes\` → ventes du jour\n` +
        `📦 \`stock\` → état du stock\n` +
        `📈 \`stats\` → statistiques globales\n\n` +
        `Tu peux aussi me poser n'importe quelle question commerciale !`
      );
      return;
    }

    // Commande stock
    if (text.toLowerCase() === "stock") {
      try {
        const data = await fetchFromSheet("stock");
        let msg = `📦 *État du stock :*\n\n`;
        data.stock.forEach((item) => {
          const emoji = item.quantite_restante < 10 ? "🔴" : item.quantite_restante < 20 ? "🟡" : "🟢";
          msg += `${emoji} *${item.produit}* : ${item.quantite_restante} unités\n`;
        });
        await sendTelegram(chatId, msg);
      } catch (e) {
        await sendTelegram(chatId, "⚠️ Impossible de lire le stock.");
      }
      return;
    }

    // Commande commandes du jour
    if (text.toLowerCase() === "commandes") {
      try {
        const data = await fetchFromSheet("today_sales");
        if (data.total_ventes === 0) {
          await sendTelegram(chatId, "📊 Aucune vente enregistrée aujourd'hui.");
          return;
        }
        let msg = `📊 *Ventes du ${data.date}*\n\n`;
        msg += `🔢 Nombre de ventes : *${data.total_ventes}*\n`;
        msg += `💰 CA du jour : *${Number(data.total_montant).toLocaleString("fr-FR")}*\n\n`;
        if (Object.keys(data.par_produit || {}).length > 0) {
          msg += `📦 *Par produit :*\n`;
          for (const [p, v] of Object.entries(data.par_produit)) {
            msg += `  • ${p} : ${v.quantite} unités — ${Number(v.montant).toLocaleString("fr-FR")}\n`;
          }
          msg += "\n";
        }
        msg += `📋 *Détail :*\n`;
        data.detail.forEach((v, i) => {
          msg += `${i + 1}. ${v.nom || "?"} — ${v.quantite}x ${v.produit} — ${Number(v.montant).toLocaleString("fr-FR")}\n`;
        });
        await sendTelegram(chatId, msg);
      } catch (e) {
        await sendTelegram(chatId, "⚠️ Impossible de lire les ventes.");
      }
      return;
    }

    // Commande stats globales
    if (text.toLowerCase() === "stats") {
      try {
        const data = await fetchFromSheet("all_stats");
        let msg = `📈 *Statistiques globales*\n\n`;
        msg += `🔢 Total ventes : *${data.total_ventes}*\n`;
        msg += `💰 CA total : *${Number(data.total_montant).toLocaleString("fr-FR")}*\n\n`;
        if (Object.keys(data.par_produit || {}).length > 0) {
          msg += `📦 *Par produit :*\n`;
          for (const [p, v] of Object.entries(data.par_produit)) {
            msg += `  • ${p} : ${v.quantite} unités — ${Number(v.montant).toLocaleString("fr-FR")}\n`;
          }
        }
        await sendTelegram(chatId, msg);
      } catch (e) {
        await sendTelegram(chatId, "⚠️ Impossible de lire les stats.");
      }
      return;
    }

    // Format CSV classique : Nom, Tel, Produit, Prix, Quantité
    if (text.includes(",")) {
      const parts = text.split(",").map((p) => p.trim());
      if (parts.length >= 5) {
        const [nom, tel, produit, prix, quantite] = parts;
        const prixTest     = parseFloat(String(prix).replace(",", "."));
        const quantiteTest = parseInt(String(quantite), 10);

        if (nom && produit && !isNaN(prixTest) && !isNaN(quantiteTest)) {
          try {
            const { prixNum, quantiteNum, montantTotal } = await addSaleToSheet(nom, tel, produit, prix, quantite);
            const confirmMsg = `✅ *Vente enregistrée !*\n\n👤 ${nom}\n📞 ${tel}\n📦 ${produit}\n💲 Prix : ${prixNum.toLocaleString("fr-FR")}\n🔢 Qté : ${quantiteNum}\n💰 Total : *${montantTotal.toLocaleString("fr-FR")}*`;
            await sendTelegram(chatId, confirmMsg);
            addToHistory(chatId, "user",      text);
            addToHistory(chatId, "assistant", confirmMsg);
          } catch (e) {
            await sendTelegram(chatId, "⚠️ Erreur lors de l'enregistrement.");
          }
          return;
        }
      }
    }

    // Détection vente en langage naturel
    const extracted = await extractSaleFromText(text);
    if (extracted.is_sale && extracted.produit && extracted.prix_unitaire && extracted.quantite) {
      console.log("🧠 Vente détectée en langage naturel:", JSON.stringify(extracted));
      try {
        const { prixNum, quantiteNum, montantTotal } = await addSaleToSheet(
          extracted.nom || "Inconnu",
          extracted.telephone || "",
          extracted.produit,
          extracted.prix_unitaire,
          extracted.quantite
        );
        let confirmMsg = `✅ *Vente enregistrée automatiquement !*\n\n`;
        confirmMsg += `👤 ${extracted.nom || "Inconnu"}\n`;
        if (extracted.telephone) confirmMsg += `📞 ${extracted.telephone}\n`;
        confirmMsg += `📦 ${extracted.produit}\n`;
        confirmMsg += `💲 Prix : ${prixNum.toLocaleString("fr-FR")}\n`;
        confirmMsg += `🔢 Qté : ${quantiteNum}\n`;
        confirmMsg += `💰 Total : *${montantTotal.toLocaleString("fr-FR")}*`;
        if (!extracted.telephone) {
          confirmMsg += `\n\n⚠️ _Téléphone manquant. Tu peux l'ajouter manuellement._`;
        }
        await sendTelegram(chatId, confirmMsg);
        addToHistory(chatId, "user",      text);
        addToHistory(chatId, "assistant", confirmMsg);
      } catch (e) {
        await sendTelegram(chatId, "⚠️ Erreur lors de l'enregistrement.");
      }
      return;
    }

    // Sinon → GPT avec accès aux vraies données
    const reply = await askGPT(chatId, text);
    await sendTelegram(chatId, reply);

  } catch (err) {
    console.error("❌ Erreur Webhook globale :", err.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Serveur lancé sur le port ${PORT}`));