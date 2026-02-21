require("dotenv").config();
const express = require("express");
const axios   = require("axios");
const OpenAI  = require("openai");

const app = express();
app.use(express.json());

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SCRIPT_URL     = "https://script.google.com/macros/s/AKfycbxrqgLsHIdnQEvNogBEIXxFfPvgjBDQkuIkrwTjBTHbMBcEU65U1Fh10c0rq7HwHsIULg/exec";

const client = new OpenAI({ apiKey: OPENAI_API_KEY });

// ==============================
// MOTS DE PASSE & RÔLES
// ==============================
const MOTS_DE_PASSE = {
  "admin@26":   "admin",
  "manager@26": "manager",
  "vendeur@26": "vendeur",
};

// Permissions par rôle
const PERMISSIONS = {
  admin:   ["vente", "commandes", "stats", "stock", "mois", "gpt"],
  manager: ["vente", "commandes", "stats", "stock", "mois", "gpt"],
  vendeur: ["vente"],
};

// ==============================
// SESSIONS UTILISATEURS
// ==============================
// { chatId: { role, nom } }
const sessions = {};

function getRole(chatId)   { return sessions[chatId]?.role || null; }
function peutFaire(chatId, action) {
  const role = getRole(chatId);
  if (!role) return false;
  return PERMISSIONS[role].includes(action);
}

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
// NETTOYAGE DES NOMBRES
// ==============================
function toFloat(val) {
  if (typeof val === "number" && !isNaN(val)) return val;
  const n = parseFloat(String(val || "0").replace(/[^0-9.]/g, ""));
  return isNaN(n) ? 0 : n;
}
function toInt(val) {
  if (typeof val === "number" && !isNaN(val)) return Math.round(val);
  const n = parseInt(String(val || "0").replace(/[^0-9]/g, ""), 10);
  return isNaN(n) ? 0 : n;
}

// ==============================
// APPEL GOOGLE SHEET
// ==============================
async function callSheet(action, extraData = {}) {
  const payload = JSON.stringify({ action, ...extraData });
  console.log(`📤 callSheet(${action}):`, payload);

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
// ALERTE STOCK FAIBLE
// ==============================
const SEUIL_ALERTE = 5;
async function checkStockAlerte(chatId, produitVendu) {
  try {
    const data = await callSheet("stock");
    if (data.status !== "ok") return;
    const produitNorm = String(produitVendu).toLowerCase().trim();
    const item = (data.stock || []).find(s =>
      String(s.produit).toLowerCase().trim() === produitNorm
    );
    if (!item) return;
    if (item.quantite_restante <= 0) {
      await sendTelegram(chatId,
        `🚨 *RUPTURE DE STOCK — ${item.produit.toUpperCase()}*\n\nStock épuisé ! _(initial: ${item.stock_initial} | vendu: ${item.vendu})_\n\n⚠️ _Pensez à réapprovisionner._`
      );
    } else if (item.quantite_restante <= SEUIL_ALERTE) {
      await sendTelegram(chatId,
        `⚠️ *STOCK FAIBLE — ${item.produit.toUpperCase()}*\n\nIl ne reste que *${item.quantite_restante} unité(s)* !\n_(initial: ${item.stock_initial} | vendu: ${item.vendu})_\n\n📋 _Pensez à réapprovisionner._`
      );
    }
  } catch (e) {
    console.error("⚠️ Erreur alerte stock:", e.message);
  }
}

// ==============================
// IMAGE → BASE64
// ==============================
async function getImageBase64(fileId) {
  const fileInfo = await axios.get(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getFile?file_id=${fileId}`);
  const filePath = fileInfo.data.result.file_path;
  const imageUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${filePath}`;
  const imageRes = await axios.get(imageUrl, { responseType: "arraybuffer" });
  return { base64: Buffer.from(imageRes.data).toString("base64"), mimeType: "image/jpeg" };
}

// ==============================
// ANALYSER IMAGE
// ==============================
async function analyzeImage(base64, mimeType) {
  const response = await client.chat.completions.create({
    model: "gpt-4o",
    messages: [{
      role: "user",
      content: [
        {
          type: "text",
          text: `Analyse cette image et extrais TOUTES les ventes.
Retourne UNIQUEMENT ce JSON :
{
  "ventes": [
    { "nom": "...", "telephone": "...", "produit": "...", "prix_unitaire": 0, "quantite": 0 }
  ],
  "notes": "..."
}
prix_unitaire et quantite sont des NOMBRES purs.
Si aucune vente : {"ventes": [], "notes": "description"}
UNIQUEMENT le JSON.`
        },
        { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64}` } },
      ],
    }],
    max_tokens: 1000,
  });
  const clean = response.choices[0].message.content.trim().replace(/```json|```/g, "").trim();
  console.log("🖼️ Vision:", clean);
  return JSON.parse(clean);
}

// ==============================
// GPT AVEC DONNÉES RÉELLES
// ==============================
async function askGPT(chatId, userText) {
  try {
    let dataContext = "";
    try {
      const now = new Date();
      const [todaySales, allStats, stock, monthStats] = await Promise.all([
        callSheet("today_sales"),
        callSheet("all_stats"),
        callSheet("stock"),
        callSheet("month_stats", { mois: now.getMonth() + 1, annee: now.getFullYear() }),
      ]);

      if (todaySales.status === "ok") {
        dataContext += `\n=== VENTES DU JOUR (${todaySales.date}) ===\n`;
        dataContext += `Nombre : ${todaySales.total_ventes} | CA : ${todaySales.total_montant}\n`;
        for (const [p, v] of Object.entries(todaySales.par_produit || {}))
          dataContext += `  - ${p} : ${v.quantite} unités, ${v.montant}\n`;
        (todaySales.detail || []).forEach(v =>
          dataContext += `  • ${v.nom || "?"} : ${v.quantite}x ${v.produit} à ${v.prix} = ${v.montant}\n`
        );
      }
      if (monthStats.status === "ok") {
        dataContext += `\n=== CA DU MOIS (${monthStats.mois} ${monthStats.annee}) ===\n`;
        dataContext += `Nombre : ${monthStats.total_ventes} | CA : ${monthStats.total_montant}\n`;
        for (const [p, v] of Object.entries(monthStats.par_produit || {}))
          dataContext += `  - ${p} : ${v.quantite} unités, ${v.montant}\n`;
      }
      if (allStats.status === "ok") {
        dataContext += `\n=== STATS GLOBALES ===\n`;
        dataContext += `Total : ${allStats.total_ventes} ventes | CA : ${allStats.total_montant}\n`;
        for (const [p, v] of Object.entries(allStats.par_produit || {}))
          dataContext += `  - ${p} : ${v.quantite} unités, ${v.montant}\n`;
      }
      if (stock.status === "ok") {
        dataContext += `\n=== STOCK ACTUEL ===\n`;
        (stock.stock || []).forEach(s =>
          dataContext += `  - ${s.produit} : ${s.quantite_restante} restant (initial: ${s.stock_initial} | vendu: ${s.vendu})\n`
        );
      }
    } catch (e) {
      console.error("⚠️ Erreur données:", e.message);
    }

    const systemPrompt = `Tu es un assistant commercial sympathique et courtois.
Tu accueilles chaleureusement les salutations et proposes ton aide.
Pour les questions commerciales, tu utilises UNIQUEMENT les données ci-dessous. Tu n'inventes JAMAIS de chiffres.
Date : ${new Date().toLocaleString("fr-FR")}

DONNÉES RÉELLES :
${dataContext || "Aucune donnée disponible."}`;

    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        ...getHistory(chatId),
        { role: "user", content: userText },
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
// MESSAGE DE BIENVENUE PAR RÔLE
// ==============================
function menuParRole(role) {
  if (role === "admin") {
    return `👑 *Connecté en tant qu'Admin*\n\n` +
      `📝 Vente : \`Nom, Tel, Produit, Prix, Quantité\`\n` +
      `🖼️ Photo reçu : envoie l'image\n` +
      `💬 Langage naturel : "J'ai vendu 2 soft à Marie"\n\n` +
      `📊 \`commandes\` → ventes du jour\n` +
      `📅 \`mois\` → CA du mois\n` +
      `📈 \`stats\` → statistiques globales\n` +
      `📦 \`stock\` → état du stock\n\n` +
      `🔴 \`deconnexion\` → se déconnecter`;
  }
  if (role === "manager") {
    return `📊 *Connecté en tant que Manager*\n\n` +
      `📊 \`commandes\` → ventes du jour\n` +
      `📅 \`mois\` → CA du mois\n` +
      `📈 \`stats\` → statistiques globales\n` +
      `📦 \`stock\` → état du stock\n\n` +
      `🔴 \`deconnexion\` → se déconnecter`;
  }
  if (role === "vendeur") {
    return `🛒 *Connecté en tant que Vendeur*\n\n` +
      `📝 Vente : \`Nom, Tel, Produit, Prix, Quantité\`\n` +
      `🖼️ Photo reçu : envoie l'image\n` +
      `💬 Langage naturel : "J'ai vendu 2 soft à Marie"\n\n` +
      `🔴 \`deconnexion\` → se déconnecter`;
  }
}

// ==============================
// WEBHOOK
// ==============================
app.get("/", (req, res) => res.send("✅ Bot commercial opérationnel"));

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  try {
    const message = req.body.message;
    if (!message) return;
    const chatId = message.chat.id;
    const role   = getRole(chatId);

    // ── IMAGES ────────────────────────────────────────────────────
    if (message.photo) {
      if (!role) {
        await sendTelegram(chatId, "🔒 Connecte-toi d'abord avec ton mot de passe.");
        return;
      }
      if (!peutFaire(chatId, "vente")) {
        await sendTelegram(chatId, "🚫 Tu n'as pas la permission d'enregistrer des ventes.");
        return;
      }
      await sendTelegram(chatId, "🖼️ Image reçue, analyse en cours...");
      try {
        const photo = message.photo[message.photo.length - 1];
        const { base64, mimeType } = await getImageBase64(photo.file_id);
        const result = await analyzeImage(base64, mimeType);

        if (!result.ventes || result.ventes.length === 0) {
          await sendTelegram(chatId, `🖼️ Aucune vente détectée.\n\nEnvoie manuellement : \`Nom, Tel, Produit, Prix, Quantité\``);
          return;
        }

        let msg = `✅ *${result.ventes.length} vente(s) enregistrée(s) !*\n\n`;
        let totalGlobal = 0;

        for (const vente of result.ventes) {
          if (!vente.produit) continue;
          const prix     = toFloat(vente.prix_unitaire);
          const quantite = toInt(vente.quantite);
          const montant  = prix * quantite;
          totalGlobal   += montant;

          const saleResult = await callSheet("add_sale", {
            nom_complet: String(vente.nom || "Inconnu").trim(),
            telephone:   String(vente.telephone || "").trim(),
            produit:     String(vente.produit).trim(),
            prix_unitaire: prix, quantite,
          });

          if (saleResult.status === "ok") {
            msg += `👤 *${vente.nom || "Inconnu"}*`;
            if (vente.telephone) msg += ` | 📞 ${vente.telephone}`;
            msg += `\n📦 ${vente.produit} × ${quantite} × ${prix.toLocaleString("fr-FR")} = *${montant.toLocaleString("fr-FR")}*\n\n`;
            await checkStockAlerte(chatId, vente.produit);
          }
        }

        if (result.ventes.length > 1) msg += `💰 *Total : ${totalGlobal.toLocaleString("fr-FR")}*`;
        await sendTelegram(chatId, msg);

      } catch (e) {
        console.error("❌ Image:", e.message);
        await sendTelegram(chatId, "⚠️ Impossible de lire l'image.");
      }
      return;
    }

    // ── TEXTES ────────────────────────────────────────────────────
    if (!message.text) return;
    const text = message.text.trim();
    console.log("📩", text, "| role:", role || "non connecté");

    // /start
    if (text === "/start") {
      delete sessions[chatId];
      userMemory[chatId] = [];
      await sendTelegram(chatId,
        `👋 *Bonjour ! Bienvenue sur le bot commercial.*\n\n🔐 Entrez votre mot de passe pour vous connecter.`
      );
      return;
    }

    // Déconnexion
    if (text.toLowerCase() === "deconnexion") {
      delete sessions[chatId];
      userMemory[chatId] = [];
      await sendTelegram(chatId, "👋 Déconnecté. Entrez votre mot de passe pour vous reconnecter.");
      return;
    }

    // Vérifier mot de passe si non connecté
    if (!role) {
      const roleDetecte = MOTS_DE_PASSE[text];
      if (roleDetecte) {
        sessions[chatId] = { role: roleDetecte };
        await sendTelegram(chatId, menuParRole(roleDetecte));
      } else {
        await sendTelegram(chatId, "🔒 Mot de passe incorrect. Réessaie.");
      }
      return;
    }

    // ── COMMANDES PAR RÔLE ────────────────────────────────────────

    // stock
    if (text.toLowerCase() === "stock") {
      if (!peutFaire(chatId, "stock")) {
        await sendTelegram(chatId, "🚫 Accès non autorisé.");
        return;
      }
      const data = await callSheet("stock");
      let msg = `📦 *Stock actuel :*\n\n`;
      (data.stock || []).forEach(s => {
        const r = s.quantite_restante;
        const e = r <= 0 ? "🚨" : r <= SEUIL_ALERTE ? "🔴" : r <= 10 ? "🟡" : "🟢";
        msg += `${e} *${s.produit.toUpperCase()}* : ${r} restant _(initial: ${s.stock_initial} | vendu: ${s.vendu})_\n`;
      });
      await sendTelegram(chatId, msg);
      return;
    }

    // commandes du jour
    if (text.toLowerCase() === "commandes") {
      if (!peutFaire(chatId, "commandes")) {
        await sendTelegram(chatId, "🚫 Accès non autorisé.");
        return;
      }
      const data = await callSheet("today_sales");
      if (data.total_ventes === 0) {
        await sendTelegram(chatId, "📊 Aucune vente aujourd'hui.");
        return;
      }
      let msg = `📊 *Ventes du ${data.date}*\n🔢 *${data.total_ventes}* | 💰 *${Number(data.total_montant).toLocaleString("fr-FR")}*\n\n`;
      for (const [p, v] of Object.entries(data.par_produit || {}))
        msg += `📦 ${p} : ${v.quantite} unités — ${Number(v.montant).toLocaleString("fr-FR")}\n`;
      msg += `\n📋 *Détail :*\n`;
      (data.detail || []).forEach((v, i) =>
        msg += `${i + 1}. ${v.nom || "?"} — ${v.quantite}x ${v.produit} — ${Number(v.montant).toLocaleString("fr-FR")}\n`
      );
      await sendTelegram(chatId, msg);
      return;
    }

    // mois
    if (text.toLowerCase() === "mois") {
      if (!peutFaire(chatId, "mois")) {
        await sendTelegram(chatId, "🚫 Accès non autorisé.");
        return;
      }
      const now  = new Date();
      const data = await callSheet("month_stats", { mois: now.getMonth() + 1, annee: now.getFullYear() });
      if (data.total_ventes === 0) {
        await sendTelegram(chatId, `📅 Aucune vente ce mois (${data.mois} ${data.annee}).`);
        return;
      }
      let msg = `📅 *${data.mois} ${data.annee}*\n🔢 *${data.total_ventes}* | 💰 *${Number(data.total_montant).toLocaleString("fr-FR")}*\n\n`;
      for (const [p, v] of Object.entries(data.par_produit || {}))
        msg += `📦 ${p} : ${v.quantite} — ${Number(v.montant).toLocaleString("fr-FR")}\n`;
      msg += `\n📋 *Par jour :*\n`;
      for (const [jour, v] of Object.entries(data.par_jour || {}))
        msg += `  ${jour} : ${v.ventes} vente(s) — ${Number(v.montant).toLocaleString("fr-FR")}\n`;
      await sendTelegram(chatId, msg);
      return;
    }

    // stats
    if (text.toLowerCase() === "stats") {
      if (!peutFaire(chatId, "stats")) {
        await sendTelegram(chatId, "🚫 Accès non autorisé.");
        return;
      }
      const data = await callSheet("all_stats");
      let msg = `📈 *Statistiques globales*\n🔢 *${data.total_ventes}* | 💰 *${Number(data.total_montant).toLocaleString("fr-FR")}*\n\n`;
      for (const [p, v] of Object.entries(data.par_produit || {}))
        msg += `📦 ${p} : ${v.quantite} — ${Number(v.montant).toLocaleString("fr-FR")}\n`;
      await sendTelegram(chatId, msg);
      return;
    }

    // ── VENTES (admin et vendeur uniquement) ──────────────────────

    // Format CSV
    if (text.includes(",")) {
      if (!peutFaire(chatId, "vente")) {
        await sendTelegram(chatId, "🚫 Tu n'as pas la permission d'enregistrer des ventes.");
        return;
      }
      const parts = text.split(",").map(p => p.trim());
      if (parts.length >= 5) {
        const [nom, tel, produit, prix, quantite] = parts;
        const pN = toFloat(prix);
        const qN = toInt(quantite);
        if (nom && produit && pN > 0 && qN > 0) {
          const result = await callSheet("add_sale", {
            nom_complet: nom, telephone: tel, produit, prix_unitaire: pN, quantite: qN,
          });
          if (result.status === "ok") {
            await sendTelegram(chatId,
              `✅ *Vente enregistrée !*\n\n👤 ${nom}\n📞 ${tel}\n📦 ${produit}\n💲 ${pN.toLocaleString("fr-FR")}\n🔢 ${qN}\n💰 *${(pN * qN).toLocaleString("fr-FR")}*`
            );
            await checkStockAlerte(chatId, produit);
          } else {
            await sendTelegram(chatId, "⚠️ Erreur enregistrement.");
          }
          return;
        }
      }
    }

    // Langage naturel
    if (peutFaire(chatId, "vente")) {
      const extracted = await extractSale(text);
      if (extracted.is_sale && extracted.produit && extracted.prix_unitaire && extracted.quantite) {
        const pN = toFloat(extracted.prix_unitaire);
        const qN = toInt(extracted.quantite);
        const result = await callSheet("add_sale", {
          nom_complet: String(extracted.nom || "Inconnu").trim(),
          telephone:   String(extracted.telephone || "").trim(),
          produit:     String(extracted.produit).trim(),
          prix_unitaire: pN, quantite: qN,
        });
        if (result.status === "ok") {
          let msg = `✅ *Vente enregistrée !*\n\n👤 ${extracted.nom || "Inconnu"}\n📦 ${extracted.produit}\n💲 ${pN.toLocaleString("fr-FR")}\n🔢 ${qN}\n💰 *${(pN * qN).toLocaleString("fr-FR")}*`;
          if (!extracted.telephone) msg += `\n\n⚠️ _Téléphone manquant._`;
          await sendTelegram(chatId, msg);
          await checkStockAlerte(chatId, extracted.produit);
        }
        return;
      }
    }

    // Question libre → GPT (admin et manager uniquement)
    if (peutFaire(chatId, "gpt")) {
      const reply = await askGPT(chatId, text);
      await sendTelegram(chatId, reply);
      return;
    }

    // Vendeur qui tape autre chose
    await sendTelegram(chatId,
      `🛒 *Mode Vendeur*\n\nEnregistre une vente :\n\`Nom, Tel, Produit, Prix, Quantité\`\n\nou envoie une photo du reçu.`
    );

  } catch (err) {
    console.error("❌ Webhook:", err.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Port ${PORT}`));