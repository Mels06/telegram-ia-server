require("dotenv").config();
const express = require("express");
const axios   = require("axios");
const OpenAI  = require("openai");

const app = express();
app.use(express.json());

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SCRIPT_URL     = "https://script.google.com/macros/s/AKfycbyfObQmU4Jvl9rwTED0YUpk6XzbG_rPLej_oS0SiDMg_Tz0IMkCtrbs5842ijG_U7rTzA/exec";

const client = new OpenAI({ apiKey: OPENAI_API_KEY });

const SEUIL_ALERTE = 5;

// ==============================
// MOTS DE PASSE & RÔLES
// ==============================
const MOTS_DE_PASSE = {
  "admin@26":   "admin",
  "manager@26": "manager",
  "vendeur@26": "vendeur",
};

const PERMISSIONS = {
  admin:   ["vente", "commandes", "stats", "stock", "mois", "gpt"],
  manager: ["vente", "commandes", "stats", "stock", "mois", "gpt"],
  vendeur: ["vente", "stock"],
};

// ==============================
// SESSIONS
// ==============================
const sessions    = {};
const userMemory  = {};

function getRole(chatId)          { return sessions[chatId]?.role || null; }
function peutFaire(chatId, action){ const r = getRole(chatId); return r ? PERMISSIONS[r].includes(action) : false; }

function deconnecter(chatId) {
  delete sessions[chatId];
  if (userMemory[chatId]) userMemory[chatId] = [];
}

function addToHistory(chatId, role, content) {
  if (!userMemory[chatId]) userMemory[chatId] = [];
  userMemory[chatId].push({ role, content });
  if (userMemory[chatId].length > 20) userMemory[chatId] = userMemory[chatId].slice(-20);
}
function getHistory(chatId) { return userMemory[chatId] || []; }

// ==============================
// NETTOYAGE NOMBRES
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
    method: "POST", headers: { "Content-Type": "application/json" },
    body: payload, redirect: "follow",
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
  } catch (err) { console.error("❌ Telegram:", err.message); }
}

// ==============================
// VÉRIFIER STOCK AVANT VENTE
// Retourne null si OK, ou un message d'erreur si stock insuffisant
// ==============================
async function verifierStockAvantVente(produit, quantiteDemandee) {
  try {
    const data = await callSheet("stock");
    if (data.status !== "ok") return null; // si erreur, on laisse passer

    const produitNorm = String(produit).toLowerCase().trim();
    const item = (data.stock || []).find(s => {
      const sNorm = String(s.produit).toLowerCase().trim();
      return sNorm === produitNorm || sNorm.slice(0,-1) === produitNorm.slice(0,-1);
    });

    if (!item) return null; // produit inconnu, on laisse passer

    if (item.quantite_restante <= 0) {
      return `🚨 *Stock épuisé !*\n\n📦 *${item.produit.toUpperCase()}* : plus aucune unité disponible.\n_(initial: ${item.stock_initial} | vendu: ${item.vendu})_\n\n⚠️ Vente annulée. Réapprovisionner d'abord.`;
    }
    if (item.quantite_restante < quantiteDemandee) {
      return `🚨 *Stock insuffisant !*\n\n📦 *${item.produit.toUpperCase()}* : seulement *${item.quantite_restante}* unité(s) disponible(s).\nTu as demandé : ${quantiteDemandee}\n\n⚠️ Vente annulée.`;
    }
    return null; // stock OK
  } catch (e) {
    console.error("⚠️ Erreur vérif stock:", e.message);
    return null;
  }
}

// ==============================
// ALERTE STOCK FAIBLE APRÈS VENTE
// ==============================
async function alerteStockApresvente(chatId, produit) {
  try {
    const data = await callSheet("stock");
    if (data.status !== "ok") return;
    const produitNorm = String(produit).toLowerCase().trim();
    const item = (data.stock || []).find(s => {
      const sNorm = String(s.produit).toLowerCase().trim();
      return sNorm === produitNorm || sNorm.slice(0,-1) === produitNorm.slice(0,-1);
    });
    if (!item) return;
    if (item.quantite_restante <= 0) {
      await sendTelegram(chatId,
        `🚨 *RUPTURE — ${item.produit.toUpperCase()}*\nStock épuisé ! _(initial: ${item.stock_initial} | vendu: ${item.vendu})_\n⚠️ Réapprovisionnez.`
      );
    } else if (item.quantite_restante <= SEUIL_ALERTE) {
      await sendTelegram(chatId,
        `⚠️ *STOCK FAIBLE — ${item.produit.toUpperCase()}*\nIl reste *${item.quantite_restante}* unité(s) seulement !\n_(initial: ${item.stock_initial} | vendu: ${item.vendu})_`
      );
    }
  } catch (e) { console.error("⚠️ Erreur alerte:", e.message); }
}

// ==============================
// ENREGISTRER VENTE
// ==============================
async function enregistrerVente(chatId, nom, telephone, produit, prix, quantite) {
  // ✅ Vérifier stock AVANT d'enregistrer
  const erreurStock = await verifierStockAvantVente(produit, quantite);
  if (erreurStock) {
    await sendTelegram(chatId, erreurStock);
    return false;
  }

  const result = await callSheet("add_sale", {
    nom_complet: String(nom || "Inconnu").trim(),
    telephone:   String(telephone || "").trim(),
    produit:     String(produit).trim(),
    prix_unitaire: prix,
    quantite,
  });

  if (result.status === "ok") {
    const montant = prix * quantite;
    let msg = `✅ *Vente enregistrée !*\n\n👤 ${nom || "Inconnu"}\n📞 ${telephone || "—"}\n📦 ${produit}\n💲 ${prix.toLocaleString("fr-FR")}\n🔢 ${quantite}\n💰 *${montant.toLocaleString("fr-FR")}*`;
    await sendTelegram(chatId, msg);
    await alerteStockApresvente(chatId, produit);
    return true;
  } else {
    await sendTelegram(chatId, "⚠️ Erreur enregistrement.");
    return false;
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
    messages: [{ role: "user", content: [
      { type: "text", text: `Analyse cette image et extrais TOUTES les ventes.
Retourne UNIQUEMENT ce JSON :
{"ventes":[{"nom":"...","telephone":"...","produit":"...","prix_unitaire":0,"quantite":0}],"notes":"..."}
prix_unitaire et quantite sont des NOMBRES purs. Si aucune vente : {"ventes":[],"notes":"description"}
UNIQUEMENT le JSON.` },
      { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64}` } },
    ]}],
    max_tokens: 1000,
  });
  const clean = response.choices[0].message.content.trim().replace(/```json|```/g, "").trim();
  return JSON.parse(clean);
}

// ==============================
// GPT
// ==============================
async function askGPT(chatId, userText) {
  try {
    let dataContext = "";
    try {
      const now = new Date();
      const [todaySales, allStats, stock, monthStats] = await Promise.all([
        callSheet("today_sales"), callSheet("all_stats"),
        callSheet("stock"), callSheet("month_stats", { mois: now.getMonth()+1, annee: now.getFullYear() }),
      ]);
      if (todaySales.status === "ok") {
        dataContext += `\n=== VENTES DU JOUR (${todaySales.date}) ===\nNombre: ${todaySales.total_ventes} | CA: ${todaySales.total_montant}\n`;
        for (const [p,v] of Object.entries(todaySales.par_produit||{})) dataContext += `  - ${p}: ${v.quantite} unités, ${v.montant}\n`;
      }
      if (monthStats.status === "ok") {
        dataContext += `\n=== CA DU MOIS (${monthStats.mois} ${monthStats.annee}) ===\nNombre: ${monthStats.total_ventes} | CA: ${monthStats.total_montant}\n`;
        for (const [p,v] of Object.entries(monthStats.par_produit||{})) dataContext += `  - ${p}: ${v.quantite} unités, ${v.montant}\n`;
      }
      if (allStats.status === "ok") {
        dataContext += `\n=== STATS GLOBALES ===\nTotal: ${allStats.total_ventes} | CA: ${allStats.total_montant}\n`;
        for (const [p,v] of Object.entries(allStats.par_produit||{})) dataContext += `  - ${p}: ${v.quantite} unités, ${v.montant}\n`;
      }
      if (stock.status === "ok") {
        dataContext += `\n=== STOCK ===\n`;
        (stock.stock||[]).forEach(s => dataContext += `  - ${s.produit}: ${s.quantite_restante} restant (initial:${s.stock_initial}|vendu:${s.vendu})\n`);
      }
    } catch(e) { console.error("⚠️ Données:", e.message); }

    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: `Tu es un assistant commercial sympathique et courtois. Tu accueilles les salutations chaleureusement. Pour les chiffres, utilise UNIQUEMENT les données ci-dessous.\nDate: ${new Date().toLocaleString("fr-FR")}\n\nDONNÉES:\n${dataContext||"Aucune donnée."}` },
        ...getHistory(chatId),
        { role: "user", content: userText },
      ],
    });
    const reply = response.choices[0].message.content;
    addToHistory(chatId, "user", userText);
    addToHistory(chatId, "assistant", reply);
    return reply;
  } catch(err) { return "⚠️ Erreur GPT."; }
}

// ==============================
// DÉTECTER VENTE LANGAGE NATUREL
// ==============================
async function extractSale(text) {
  try {
    const r = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: `Analyse si c'est une vente. Si oui: {"is_sale":true,"nom":"...","telephone":"...","produit":"...","prix_unitaire":0,"quantite":0} Si non: {"is_sale":false} UNIQUEMENT le JSON.` },
        { role: "user", content: text }
      ],
    });
    return JSON.parse(r.choices[0].message.content.trim());
  } catch(e) { return { is_sale: false }; }
}

// ==============================
// MENU PAR RÔLE
// ==============================
function menuParRole(role) {
  const base = `📝 Vente : \`Nom, Tel, Produit, Prix, Quantité\`\n🖼️ Photo reçu : envoie l'image\n💬 Langage naturel : "J'ai vendu 2 soft à Marie"\n`;
  const stats = `📊 \`commandes\` → ventes du jour\n📅 \`mois\` → CA du mois\n📈 \`stats\` → statistiques globales\n`;
  const stockCmd = `📦 \`stock\` → état du stock et prix\n`;
  const deco = `\n🔴 \`deconnexion\` → se déconnecter`;

  if (role === "admin")   return `👑 *Connecté — Admin*\n\n${base}\n${stats}${stockCmd}${deco}`;
  if (role === "manager") return `📊 *Connecté — Manager*\n\n${base}\n${stats}${stockCmd}${deco}`;
  if (role === "vendeur") return `🛒 *Connecté — Vendeur*\n\n${base}\n${stockCmd}${deco}`;
}

// ==============================
// WEBHOOK
// ==============================
app.get("/", (req, res) => res.send("✅ Bot opérationnel"));

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  try {
    const message = req.body.message;
    if (!message) return;
    const chatId = message.chat.id;
    const role   = getRole(chatId);

    // ── IMAGES ────────────────────────────────────────────────────
    if (message.photo) {
      if (!role) { await sendTelegram(chatId, "🔒 Connecte-toi d'abord avec ton mot de passe."); return; }
      if (!peutFaire(chatId, "vente")) { await sendTelegram(chatId, "🚫 Permission refusée."); return; }

      await sendTelegram(chatId, "🖼️ Image reçue, analyse en cours...");
      try {
        const photo = message.photo[message.photo.length - 1];
        const { base64, mimeType } = await getImageBase64(photo.file_id);
        const result = await analyzeImage(base64, mimeType);

        if (!result.ventes || result.ventes.length === 0) {
          await sendTelegram(chatId, `🖼️ Aucune vente détectée.\n\nEnvoie manuellement : \`Nom, Tel, Produit, Prix, Quantité\``);
          return;
        }

        let totalGlobal = 0;
        let nbOk = 0;
        for (const vente of result.ventes) {
          if (!vente.produit) continue;
          const prix = toFloat(vente.prix_unitaire);
          const qte  = toInt(vente.quantite);
          const ok   = await enregistrerVente(chatId, vente.nom, vente.telephone, vente.produit, prix, qte);
          if (ok) { totalGlobal += prix * qte; nbOk++; }
        }
        if (nbOk > 1) await sendTelegram(chatId, `💰 *Total : ${totalGlobal.toLocaleString("fr-FR")}*`);

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

    // ✅ TOUJOURS en premier : déconnexion et /start
    const textNorm = text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    if (text === "/start" || textNorm.includes("deconnex") || textNorm.includes("logout") || textNorm.includes("se deconnecter") || textNorm.includes("quitter")) {
      deconnecter(chatId);
      await sendTelegram(chatId, "👋 Bonjour ! Entrez votre mot de passe pour vous connecter.");
      return;
    }

    // ✅ Si non connecté → vérifier mot de passe
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

    // ── COMMANDES ─────────────────────────────────────────────────

    if (text.toLowerCase() === "stock") {
      if (!peutFaire(chatId, "stock")) { await sendTelegram(chatId, "🚫 Accès refusé."); return; }
      const data = await callSheet("stock");
      let msg = `📦 *Stock actuel :*\n\n`;
      (data.stock || []).forEach(s => {
        const r = s.quantite_restante;
        const e = r <= 0 ? "🚨" : r <= SEUIL_ALERTE ? "🔴" : r <= 10 ? "🟡" : "🟢";
        msg += `${e} *${s.produit.toUpperCase()}* : ${r} restant | 💲 ${Number(s.prix_unitaire).toLocaleString("fr-FR")}\n_(initial: ${s.stock_initial} | vendu: ${s.vendu})_\n\n`;
      });
      await sendTelegram(chatId, msg);
      return;
    }

    if (text.toLowerCase() === "commandes") {
      if (!peutFaire(chatId, "commandes")) { await sendTelegram(chatId, "🚫 Accès refusé."); return; }
      const data = await callSheet("today_sales");
      if (data.total_ventes === 0) { await sendTelegram(chatId, "📊 Aucune vente aujourd'hui."); return; }
      let msg = `📊 *Ventes du ${data.date}*\n🔢 *${data.total_ventes}* | 💰 *${Number(data.total_montant).toLocaleString("fr-FR")}*\n\n`;
      for (const [p,v] of Object.entries(data.par_produit||{})) msg += `📦 ${p} : ${v.quantite} — ${Number(v.montant).toLocaleString("fr-FR")}\n`;
      msg += `\n📋 *Détail :*\n`;
      (data.detail||[]).forEach((v,i) => msg += `${i+1}. ${v.nom||"?"} — ${v.quantite}x ${v.produit} — ${Number(v.montant).toLocaleString("fr-FR")}\n`);
      await sendTelegram(chatId, msg);
      return;
    }

    if (text.toLowerCase() === "mois") {
      if (!peutFaire(chatId, "mois")) { await sendTelegram(chatId, "🚫 Accès refusé."); return; }
      const now = new Date();
      const data = await callSheet("month_stats", { mois: now.getMonth()+1, annee: now.getFullYear() });
      if (data.total_ventes === 0) { await sendTelegram(chatId, `📅 Aucune vente ce mois.`); return; }
      let msg = `📅 *${data.mois} ${data.annee}*\n🔢 *${data.total_ventes}* | 💰 *${Number(data.total_montant).toLocaleString("fr-FR")}*\n\n`;
      for (const [p,v] of Object.entries(data.par_produit||{})) msg += `📦 ${p} : ${v.quantite} — ${Number(v.montant).toLocaleString("fr-FR")}\n`;
      msg += `\n📋 *Par jour :*\n`;
      for (const [jour,v] of Object.entries(data.par_jour||{})) msg += `  ${jour} : ${v.ventes} vente(s) — ${Number(v.montant).toLocaleString("fr-FR")}\n`;
      await sendTelegram(chatId, msg);
      return;
    }

    if (text.toLowerCase() === "stats") {
      if (!peutFaire(chatId, "stats")) { await sendTelegram(chatId, "🚫 Accès refusé."); return; }
      const data = await callSheet("all_stats");
      let msg = `📈 *Stats globales*\n🔢 *${data.total_ventes}* | 💰 *${Number(data.total_montant).toLocaleString("fr-FR")}*\n\n`;
      for (const [p,v] of Object.entries(data.par_produit||{})) msg += `📦 ${p} : ${v.quantite} — ${Number(v.montant).toLocaleString("fr-FR")}\n`;
      await sendTelegram(chatId, msg);
      return;
    }

    // ── VENTES ────────────────────────────────────────────────────
    if (peutFaire(chatId, "vente")) {

      // Format CSV
      if (text.includes(",")) {
        const parts = text.split(",").map(p => p.trim());
        if (parts.length >= 5) {
          const [nom, tel, produit, prix, quantite] = parts;
          const pN = toFloat(prix);
          const qN = toInt(quantite);
          if (nom && produit && pN > 0 && qN > 0) {
            await enregistrerVente(chatId, nom, tel, produit, pN, qN);
            return;
          }
        }
      }

      // Langage naturel
      const extracted = await extractSale(text);
      if (extracted.is_sale && extracted.produit && extracted.prix_unitaire && extracted.quantite) {
        const pN = toFloat(extracted.prix_unitaire);
        const qN = toInt(extracted.quantite);
        await enregistrerVente(chatId, extracted.nom, extracted.telephone, extracted.produit, pN, qN);
        return;
      }
    }

    // GPT ou message par défaut
    if (peutFaire(chatId, "gpt")) {
      const reply = await askGPT(chatId, text);
      await sendTelegram(chatId, reply);
    } else {
      await sendTelegram(chatId, menuParRole(role));
    }

  } catch (err) { console.error("❌ Webhook:", err.message); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Port ${PORT}`));