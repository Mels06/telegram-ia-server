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
// MÉMOIRE PAR UTILISATEUR
// ==============================
const userMemory = {};

function addToHistory(chatId, role, content) {
  if (!userMemory[chatId]) userMemory[chatId] = [];
  userMemory[chatId].push({ role, content });
  if (userMemory[chatId].length > 20) userMemory[chatId] = userMemory[chatId].slice(-20);
}

function getHistory(chatId) {
  return userMemory[chatId] || [];
}

// ==============================
// APPEL GOOGLE SHEET (tout en POST)
// ==============================
async function callSheet(action, extraData = {}) {
  const payload = JSON.stringify({ action, ...extraData });
  
  const response = await fetch(SCRIPT_URL, {
    method:   "POST",
    headers:  { "Content-Type": "application/json" },
    body:     payload,
    redirect: "follow",
  });

  const text   = await response.text();
  console.log(`📥 callSheet(${action}) FULL:`, text); // ← log complet
  
  const result = JSON.parse(text);
  if (result.status === "success") result.status = "ok";
  return result;
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
    console.error("❌ Erreur Telegram:", err.message);
  }
}

// ==============================
// GPT avec données réelles
// ==============================
async function askGPT(chatId, userText) {
  try {
    let dataContext = "";
    try {
      const [todaySales, allStats, stock] = await Promise.all([
        callSheet("today_sales"),
        callSheet("all_stats"),
        callSheet("stock"),
      ]);

      if (todaySales.status === "ok") {
        dataContext += `\n=== VENTES DU JOUR (${todaySales.date}) ===\n`;
        dataContext += `Nombre de ventes : ${todaySales.total_ventes}\n`;
        dataContext += `CA du jour : ${todaySales.total_montant}\n`;
        for (const [p, v] of Object.entries(todaySales.par_produit || {})) {
          dataContext += `  - ${p} : ${v.quantite} unités, ${v.montant} FCFA\n`;
        }
        (todaySales.detail || []).forEach(v => {
          dataContext += `  • ${v.nom || "?"} : ${v.quantite}x ${v.produit} à ${v.prix} = ${v.montant}\n`;
        });
      }

      if (allStats.status === "ok") {
        dataContext += `\n=== STATS GLOBALES ===\n`;
        dataContext += `Total ventes : ${allStats.total_ventes} | CA total : ${allStats.total_montant}\n`;
        for (const [p, v] of Object.entries(allStats.par_produit || {})) {
          dataContext += `  - ${p} : ${v.quantite} unités, ${v.montant} FCFA\n`;
        }
        for (const [jour, v] of Object.entries(allStats.par_jour || {})) {
          dataContext += `  - ${jour} : ${v.ventes} vente(s), ${v.montant} FCFA\n`;
        }
      }

      if (stock.status === "ok") {
        dataContext += `\n=== STOCK ===\n`;
        (stock.stock || []).forEach(s => {
          dataContext += `  - ${s.produit} : ${s.quantite_restante} unités\n`;
        });
      }

      console.log("📊 Contexte données GPT:\n", dataContext);

    } catch (e) {
      console.error("⚠️ Erreur chargement données:", e.message);
      dataContext = "(Erreur de chargement des données)";
    }

    const systemPrompt =
      `Tu es un assistant commercial d'une entreprise. Tu réponds UNIQUEMENT sur les ventes, stocks, produits, commandes et chiffres.
Tu as accès aux données RÉELLES ci-dessous. Tu n'inventes RIEN. Si une info n'est pas dans les données, dis-le clairement.
Date actuelle : ${new Date().toLocaleString("fr-FR")}

DONNÉES RÉELLES DU GOOGLE SHEET :
${dataContext || "Aucune donnée disponible pour le moment."}`;

    const messages = [
      { role: "system", content: systemPrompt },
      ...getHistory(chatId),
      { role: "user", content: userText }
    ];

    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
    });

    const reply = response.choices[0].message.content;
    addToHistory(chatId, "user",      userText);
    addToHistory(chatId, "assistant", reply);
    return reply;

  } catch (err) {
    console.error("❌ Erreur OpenAI:", err.message);
    return "⚠️ Erreur GPT. Réessaie.";
  }
}

// ==============================
// DÉTECTER VENTE EN LANGAGE NATUREL
// ==============================
async function extractSale(text) {
  try {
    const r = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `Analyse si c'est une vente. Si oui, retourne UNIQUEMENT ce JSON :
{"is_sale":true,"nom":"...","telephone":"...","produit":"...","prix_unitaire":0,"quantite":0}
Si téléphone absent mets "". Si ce n'est PAS une vente : {"is_sale":false}
UNIQUEMENT le JSON, rien d'autre.`
        },
        { role: "user", content: text }
      ],
    });
    return JSON.parse(r.choices[0].message.content.trim());
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
    console.log("📩 Message reçu:", text);

    // /start
    if (text === "/start") {
      userMemory[chatId] = [];
      await sendTelegram(chatId,
        `👋 *Bienvenue sur le bot commercial !*\n\n` +
        `📝 *Vente rapide :* \`Nom, Téléphone, Produit, Prix, Quantité\`\n` +
        `💬 *Ou naturellement :* "J'ai vendu 2 soft à Marie pour 15000"\n\n` +
        `📊 \`commandes\` → ventes du jour\n` +
        `📦 \`stock\` → état du stock\n` +
        `📈 \`stats\` → statistiques globales`
      );
      return;
    }

    // Stock
    if (text.toLowerCase() === "stock") {
      const data = await callSheet("stock");
      let msg = `📦 *Stock actuel :*\n\n`;
      (data.stock || []).forEach(s => {
        const e = s.quantite_restante < 10 ? "🔴" : s.quantite_restante < 20 ? "🟡" : "🟢";
        msg += `${e} *${s.produit}* : ${s.quantite_restante} unités\n`;
      });
      await sendTelegram(chatId, msg);
      return;
    }

    // Commandes du jour
    if (text.toLowerCase() === "commandes") {
      const data = await callSheet("today_sales");
      if (data.total_ventes === 0) {
        await sendTelegram(chatId, "📊 Aucune vente enregistrée aujourd'hui.");
        return;
      }
      let msg = `📊 *Ventes du ${data.date}*\n\n🔢 *${data.total_ventes}* ventes | 💰 *${Number(data.total_montant).toLocaleString("fr-FR")}*\n\n`;
      for (const [p, v] of Object.entries(data.par_produit || {})) {
        msg += `📦 ${p} : ${v.quantite} unités — ${Number(v.montant).toLocaleString("fr-FR")}\n`;
      }
      msg += `\n📋 *Détail :*\n`;
      (data.detail || []).forEach((v, i) => {
        msg += `${i + 1}. ${v.nom || "?"} — ${v.quantite}x ${v.produit} — ${Number(v.montant).toLocaleString("fr-FR")}\n`;
      });
      await sendTelegram(chatId, msg);
      return;
    }

    // Stats globales
    if (text.toLowerCase() === "stats") {
      const data = await callSheet("all_stats");
      let msg = `📈 *Stats globales*\n\n🔢 Total : *${data.total_ventes}* ventes | 💰 *${Number(data.total_montant).toLocaleString("fr-FR")}*\n\n`;
      for (const [p, v] of Object.entries(data.par_produit || {})) {
        msg += `📦 ${p} : ${v.quantite} unités — ${Number(v.montant).toLocaleString("fr-FR")}\n`;
      }
      await sendTelegram(chatId, msg);
      return;
    }

    // Format CSV : Nom, Tel, Produit, Prix, Quantité
    if (text.includes(",")) {
      const parts = text.split(",").map(p => p.trim());
      if (parts.length >= 5) {
        const [nom, tel, produit, prix, quantite] = parts;
        const pN = parseFloat(String(prix).replace(",", "."));
        const qN = parseInt(String(quantite), 10);
        if (nom && produit && !isNaN(pN) && !isNaN(qN)) {
          const result = await callSheet("add_sale", {
            nom_complet: nom, telephone: tel, produit,
            prix_unitaire: pN, quantite: qN
          });
          if (result.status === "ok") {
            await sendTelegram(chatId,
              `✅ *Vente enregistrée !*\n\n👤 ${nom}\n📞 ${tel}\n📦 ${produit}\n💲 ${pN.toLocaleString("fr-FR")}\n🔢 ${qN}\n💰 *${(pN * qN).toLocaleString("fr-FR")}*`
            );
          } else {
            await sendTelegram(chatId, "⚠️ Erreur enregistrement.");
          }
          return;
        }
      }
    }

    // Vente en langage naturel
    const extracted = await extractSale(text);
    if (extracted.is_sale && extracted.produit && extracted.prix_unitaire && extracted.quantite) {
      const result = await callSheet("add_sale", {
        nom_complet:   extracted.nom || "Inconnu",
        telephone:     extracted.telephone || "",
        produit:       extracted.produit,
        prix_unitaire: extracted.prix_unitaire,
        quantite:      extracted.quantite,
      });
      if (result.status === "ok") {
        let msg = `✅ *Vente enregistrée automatiquement !*\n\n👤 ${extracted.nom || "Inconnu"}\n📦 ${extracted.produit}\n💲 ${extracted.prix_unitaire}\n🔢 ${extracted.quantite}\n💰 *${(extracted.prix_unitaire * extracted.quantite).toLocaleString("fr-FR")}*`;
        if (!extracted.telephone) msg += `\n\n⚠️ _Téléphone manquant._`;
        await sendTelegram(chatId, msg);
      }
      return;
    }

    // Question libre → GPT avec vraies données
    const reply = await askGPT(chatId, text);
    await sendTelegram(chatId, reply);

  } catch (err) {
    console.error("❌ Erreur Webhook:", err.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Serveur lancé sur le port ${PORT}`));