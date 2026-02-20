require("dotenv").config();
const express = require("express");
const axios   = require("axios");
const OpenAI  = require("openai");

const app = express();
app.use(express.json());

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SCRIPT_URL     = "https://script.google.com/macros/s/AKfycbxLAgimMZjJvFrHGXqMcDEPQzuzIPg8KO1XZYYFM6z7Gykpiz56w-4orPVa1v1mB30L7g/exec";

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
function getHistory(chatId) { return userMemory[chatId] || []; }

// ==============================
// APPEL GOOGLE SHEET
// ==============================
async function callSheet(action, extraData = {}) {
  const payload = JSON.stringify({ action, ...extraData });
  console.log(`📤 callSheet(${action})`);

  const response = await fetch(SCRIPT_URL, {
    method:   "POST",
    headers:  { "Content-Type": "application/json" },
    body:     payload,
    redirect: "follow",
  });

  const text = await response.text();
  console.log(`📥 callSheet(${action}):`, text);

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
      chat_id: chatId, text, parse_mode: "Markdown",
    });
  } catch (err) {
    console.error("❌ Telegram:", err.message);
  }
}

// ==============================
// TÉLÉCHARGER IMAGE TELEGRAM → BASE64
// ==============================
async function getImageBase64(fileId) {
  const fileInfo = await axios.get(
    `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getFile?file_id=${fileId}`
  );
  const filePath = fileInfo.data.result.file_path;
  const imageUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${filePath}`;
  const imageRes = await axios.get(imageUrl, { responseType: "arraybuffer" });
  const base64   = Buffer.from(imageRes.data).toString("base64");
  return { base64, mimeType: "image/jpeg" };
}

// ==============================
// ANALYSER IMAGE — PLUSIEURS VENTES
// ==============================
async function analyzeImage(base64, mimeType) {
  console.log("🖼️ Analyse image avec GPT-4o Vision...");

  const response = await client.chat.completions.create({
    model: "gpt-4o",
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `Tu es un assistant commercial. Analyse cette image et extrais TOUTES les ventes présentes.
Il peut y avoir 1 ou plusieurs ventes sur la même image.

Retourne UNIQUEMENT un JSON avec ce format :
{
  "ventes": [
    {
      "nom": "nom du client",
      "telephone": "numéro ou vide",
      "produit": "nom du produit",
      "prix_unitaire": nombre,
      "quantite": nombre
    }
  ],
  "notes": "autres infos utiles"
}

Si aucune vente n'est détectée : {"ventes": [], "notes": "description de ce que tu vois"}
UNIQUEMENT le JSON, rien d'autre.`
          },
          {
            type: "image_url",
            image_url: { url: `data:${mimeType};base64,${base64}` },
          },
        ],
      },
    ],
    max_tokens: 1000,
  });

  const raw   = response.choices[0].message.content.trim();
  const clean = raw.replace(/```json|```/g, "").trim();
  console.log("🖼️ Résultat Vision:", clean);
  return JSON.parse(clean);
}

// ==============================
// GPT AVEC DONNÉES RÉELLES
// ==============================
async function askGPT(chatId, userText) {
  try {
    let dataContext = "";
    try {
      const now   = new Date();
      const [todaySales, allStats, stock, monthStats] = await Promise.all([
        callSheet("today_sales"),
        callSheet("all_stats"),
        callSheet("stock"),
        callSheet("month_stats", { mois: now.getMonth() + 1, annee: now.getFullYear() }),
      ]);

      if (todaySales.status === "ok") {
        dataContext += `\n=== VENTES DU JOUR (${todaySales.date}) ===\n`;
        dataContext += `Nombre : ${todaySales.total_ventes} | CA : ${todaySales.total_montant}\n`;
        for (const [p, v] of Object.entries(todaySales.par_produit || {})) {
          dataContext += `  - ${p} : ${v.quantite} unités, ${v.montant}\n`;
        }
        (todaySales.detail || []).forEach(v => {
          dataContext += `  • ${v.nom || "?"} : ${v.quantite}x ${v.produit} à ${v.prix} = ${v.montant}\n`;
        });
      }
      if (monthStats.status === "ok") {
        dataContext += `\n=== CA DU MOIS (${monthStats.mois} ${monthStats.annee}) ===\n`;
        dataContext += `Nombre : ${monthStats.total_ventes} | CA : ${monthStats.total_montant}\n`;
        for (const [p, v] of Object.entries(monthStats.par_produit || {})) {
          dataContext += `  - ${p} : ${v.quantite} unités, ${v.montant}\n`;
        }
      }
      if (allStats.status === "ok") {
        dataContext += `\n=== STATS GLOBALES ===\n`;
        dataContext += `Total : ${allStats.total_ventes} ventes | CA : ${allStats.total_montant}\n`;
        for (const [p, v] of Object.entries(allStats.par_produit || {})) {
          dataContext += `  - ${p} : ${v.quantite} unités, ${v.montant}\n`;
        }
      }
      if (stock.status === "ok") {
        dataContext += `\n=== STOCK ===\n`;
        (stock.stock || []).forEach(s => {
          dataContext += `  - ${s.produit} : ${s.quantite_restante} unités\n`;
        });
      }
    } catch (e) {
      console.error("⚠️ Erreur données:", e.message);
    }

    const systemPrompt = `Tu es un assistant commercial. Tu réponds UNIQUEMENT sur les ventes, stocks, produits et chiffres.
Tu utilises UNIQUEMENT les données ci-dessous. Tu n'inventes RIEN.
Date : ${new Date().toLocaleString("fr-FR")}

DONNÉES RÉELLES :
${dataContext || "Aucune donnée disponible."}`;

    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        ...getHistory(chatId),
        { role: "user", content: userText }
      ],
    });

    const reply = response.choices[0].message.content;
    addToHistory(chatId, "user", userText);
    addToHistory(chatId, "assistant", reply);
    return reply;

  } catch (err) {
    console.error("❌ GPT:", err.message);
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
          content: `Analyse si c'est une vente. Si oui :
{"is_sale":true,"nom":"...","telephone":"...","produit":"...","prix_unitaire":0,"quantite":0}
Si non : {"is_sale":false}
UNIQUEMENT le JSON.`
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
app.get("/", (req, res) => res.send("✅ OK"));

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  try {
    const message = req.body.message;
    if (!message) return;

    const chatId = message.chat.id;

    // ── GESTION DES IMAGES ─────────────────────────────────────────
    if (message.photo) {
      await sendTelegram(chatId, "🖼️ Image reçue, analyse en cours...");
      try {
        const photo  = message.photo[message.photo.length - 1];
        const { base64, mimeType } = await getImageBase64(photo.file_id);
        const result = await analyzeImage(base64, mimeType);

        if (!result.ventes || result.ventes.length === 0) {
          await sendTelegram(chatId,
            `🖼️ Aucune vente détectée.\n${result.notes ? `Je vois : ${result.notes}` : ""}\n\nEnvoie les infos manuellement : \`Nom, Tel, Produit, Prix, Quantité\``
          );
          return;
        }

        // Enregistrer TOUTES les ventes
        let msg = `✅ *${result.ventes.length} vente(s) enregistrée(s) !*\n\n`;
        let totalGlobal = 0;

        for (const vente of result.ventes) {
          if (!vente.produit || !vente.prix_unitaire || !vente.quantite) continue;

          const saleResult = await callSheet("add_sale", {
            nom_complet:   vente.nom || "Inconnu",
            telephone:     vente.telephone || "",
            produit:       vente.produit,
            prix_unitaire: vente.prix_unitaire,
            quantite:      vente.quantite,
          });

          const total = vente.prix_unitaire * vente.quantite;
          totalGlobal += total;

          if (saleResult.status === "ok") {
            msg += `👤 *${vente.nom || "Inconnu"}*`;
            if (vente.telephone) msg += ` | 📞 ${vente.telephone}`;
            msg += `\n📦 ${vente.produit} × ${vente.quantite} × ${Number(vente.prix_unitaire).toLocaleString("fr-FR")} = *${total.toLocaleString("fr-FR")}*\n\n`;
          }
        }

        if (result.ventes.length > 1) {
          msg += `💰 *Total image : ${totalGlobal.toLocaleString("fr-FR")}*`;
        }

        if (result.notes) msg += `\n\n📝 _${result.notes}_`;

        await sendTelegram(chatId, msg);

      } catch (e) {
        console.error("❌ Erreur image:", e.message);
        await sendTelegram(chatId, "⚠️ Impossible de lire l'image. Envoie les infos manuellement.");
      }
      return;
    }

    // ── GESTION DES TEXTES ─────────────────────────────────────────
    if (!message.text) return;
    const text = message.text.trim();
    console.log("📩", text);

    // /start
    if (text === "/start") {
      userMemory[chatId] = [];
      await sendTelegram(chatId,
        `👋 *Bot commercial*\n\n` +
        `📝 Vente texte : \`Nom, Tel, Produit, Prix, Quantité\`\n` +
        `🖼️ Vente image : envoie une photo (plusieurs ventes supportées)\n` +
        `💬 Ou : "J'ai vendu 2 soft à Marie pour 15000"\n\n` +
        `📊 \`commandes\` → ventes du jour\n` +
        `📅 \`mois\` → CA du mois\n` +
        `📈 \`stats\` → stats globales\n` +
        `📦 \`stock\` → état du stock`
      );
      return;
    }

    // stock
    if (text.toLowerCase() === "stock") {
      const data = await callSheet("stock");
      let msg = `📦 *Stock :*\n\n`;
      (data.stock || []).forEach(s => {
        const e = s.quantite_restante < 10 ? "🔴" : s.quantite_restante < 20 ? "🟡" : "🟢";
        msg += `${e} *${s.produit}* : ${s.quantite_restante} unités\n`;
      });
      await sendTelegram(chatId, msg);
      return;
    }

    // commandes du jour
    if (text.toLowerCase() === "commandes") {
      const data = await callSheet("today_sales");
      if (data.total_ventes === 0) {
        await sendTelegram(chatId, "📊 Aucune vente aujourd'hui.");
        return;
      }
      let msg = `📊 *Ventes du ${data.date}*\n🔢 *${data.total_ventes}* ventes | 💰 *${Number(data.total_montant).toLocaleString("fr-FR")}*\n\n`;
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

    // CA du mois
    if (text.toLowerCase() === "mois") {
      const now  = new Date();
      const data = await callSheet("month_stats", { mois: now.getMonth() + 1, annee: now.getFullYear() });
      if (data.total_ventes === 0) {
        await sendTelegram(chatId, `📅 Aucune vente ce mois (${data.mois} ${data.annee}).`);
        return;
      }
      let msg = `📅 *${data.mois} ${data.annee}*\n🔢 *${data.total_ventes}* ventes | 💰 *${Number(data.total_montant).toLocaleString("fr-FR")}*\n\n`;
      for (const [p, v] of Object.entries(data.par_produit || {})) {
        msg += `📦 ${p} : ${v.quantite} unités — ${Number(v.montant).toLocaleString("fr-FR")}\n`;
      }
      msg += `\n📋 *Par jour :*\n`;
      for (const [jour, v] of Object.entries(data.par_jour || {})) {
        msg += `  ${jour} : ${v.ventes} vente(s) — ${Number(v.montant).toLocaleString("fr-FR")}\n`;
      }
      await sendTelegram(chatId, msg);
      return;
    }

    // stats globales
    if (text.toLowerCase() === "stats") {
      const data = await callSheet("all_stats");
      let msg = `📈 *Stats globales*\n🔢 *${data.total_ventes}* ventes | 💰 *${Number(data.total_montant).toLocaleString("fr-FR")}*\n\n`;
      for (const [p, v] of Object.entries(data.par_produit || {})) {
        msg += `📦 ${p} : ${v.quantite} unités — ${Number(v.montant).toLocaleString("fr-FR")}\n`;
      }
      await sendTelegram(chatId, msg);
      return;
    }

    // Format CSV
    if (text.includes(",")) {
      const parts = text.split(",").map(p => p.trim());
      if (parts.length >= 5) {
        const [nom, tel, produit, prix, quantite] = parts;
        const pN = parseFloat(String(prix).replace(",", "."));
        const qN = parseInt(String(quantite), 10);
        if (nom && produit && !isNaN(pN) && !isNaN(qN)) {
          const result = await callSheet("add_sale", {
            nom_complet: nom, telephone: tel, produit, prix_unitaire: pN, quantite: qN
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

    // Langage naturel
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
        let msg = `✅ *Vente enregistrée !*\n\n👤 ${extracted.nom || "Inconnu"}\n📦 ${extracted.produit}\n💲 ${extracted.prix_unitaire}\n🔢 ${extracted.quantite}\n💰 *${(extracted.prix_unitaire * extracted.quantite).toLocaleString("fr-FR")}*`;
        if (!extracted.telephone) msg += `\n\n⚠️ _Téléphone manquant._`;
        await sendTelegram(chatId, msg);
      }
      return;
    }

    // Question → GPT
    const reply = await askGPT(chatId, text);
    await sendTelegram(chatId, reply);

  } catch (err) {
    console.error("❌ Webhook:", err.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Port ${PORT}`));