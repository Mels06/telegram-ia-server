require("dotenv").config();
const express = require("express");
const axios   = require("axios");
const OpenAI  = require("openai");

const app = express();
app.use(express.json());

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SCRIPT_URL     = "https://script.google.com/macros/s/AKfycbzAKFpnFcpAWRpeae9pcMgQV47-cpq9yLZaGGG_7G-54LQ_09mrthllqa-SjTuByOsLGQ/exec";

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
  admin:   ["vente", "commandes", "stats", "stock", "mois", "gpt", "annuler", "vendeurs", "restock"],
  manager: ["vente", "commandes", "stats", "stock", "mois", "gpt", "annuler", "vendeurs", "restock"],
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
      const [todaySales, allStats, stock, monthStats, yesterdaySales] = await Promise.all([
        callSheet("today_sales"), callSheet("all_stats"),
        callSheet("stock"), callSheet("month_stats", { mois: now.getMonth()+1, annee: now.getFullYear() }),
        callSheet("yesterday_sales"),
      ]);
      if (todaySales.status === "ok") {
        dataContext += `\n=== VENTES DU JOUR (${todaySales.date}) ===\nNombre: ${todaySales.total_ventes} | CA: ${todaySales.total_montant}\n`;
        for (const [p,v] of Object.entries(todaySales.par_produit||{})) dataContext += `  - ${p}: ${v.quantite} unités, ${v.montant}\n`;
        dataContext += `\nDétail ventes du jour :\n`;
        (todaySales.detail||[]).forEach(v => dataContext += `  • ${v.nom||"?"} (${v.telephone||"—"}) : ${v.quantite}x ${v.produit} = ${v.montant}\n`);
      }
      if (yesterdaySales && yesterdaySales.status === "ok" && yesterdaySales.total_ventes > 0) {
        dataContext += `\n=== VENTES D'HIER (${yesterdaySales.date}) ===\nNombre: ${yesterdaySales.total_ventes} | CA: ${yesterdaySales.total_montant}\n`;
        for (const [p,v] of Object.entries(yesterdaySales.par_produit||{})) dataContext += `  - ${p}: ${v.quantite} unités, ${v.montant}\n`;
      }
      if (monthStats.status === "ok") {
        dataContext += `\n=== CA DU MOIS (${monthStats.mois} ${monthStats.annee}) ===\nNombre: ${monthStats.total_ventes} | CA: ${monthStats.total_montant}\n`;
        for (const [p,v] of Object.entries(monthStats.par_produit||{})) dataContext += `  - ${p}: ${v.quantite} unités, ${v.montant}\n`;
      }
      if (allStats.status === "ok") {
        dataContext += `\n=== TOUTES LES VENTES (historique complet) ===\nTotal: ${allStats.total_ventes} | CA: ${allStats.total_montant}\n`;
        for (const [p,v] of Object.entries(allStats.par_produit||{})) dataContext += `  - ${p}: ${v.quantite} unités, ${v.montant}\n`;
        dataContext += `\nDétail de TOUTES les ventes :\n`;
        (allStats.detail||[]).forEach(v => dataContext += `  • ${v.nom||"?"} (${v.telephone||"—"}) : ${v.quantite}x ${v.produit} à ${v.prix} = ${v.montant} le ${v.date||""}\n`);
      }
      if (stock.status === "ok") {
        dataContext += `\n=== STOCK ===\n`;
        (stock.stock||[]).forEach(s => dataContext += `  - ${s.produit}: ${s.quantite_restante} restant (initial:${s.stock_initial}|vendu:${s.vendu}) | prix: ${s.prix_unitaire}\n`);
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
async function extractSale(text, catalogue = []) {
  try {
    const catalogueStr = catalogue.length > 0
      ? `\n\nCATALOGUE PRODUITS (utilise ces prix si le prix n\'est pas mentionné) :\n` +
        catalogue.map(p => `- ${p.produit} : ${p.prix_unitaire} FCFA`).join("\n")
      : "";

    const r = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: `Tu es un assistant commercial. Analyse si le message est une vente.
L\'ordre des informations peut être n\'importe lequel (nom, téléphone, produit, quantité, prix dans n\'importe quel ordre).
Si le prix n\'est pas mentionné, utilise le prix du catalogue.
Si le produit ressemble à un produit du catalogue (même partiel, même casse différente), utilise le nom officiel du catalogue.${catalogueStr}

Si c\'est une vente, retourne :
{"is_sale":true,"nom":"...","telephone":"...","produit":"NOM_OFFICIEL_DU_CATALOGUE","prix_unitaire":0,"quantite":0}
Si non : {"is_sale":false}
UNIQUEMENT le JSON.` },
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
  const stockCmd = `📦 \`stock\` → état du stock et prix\n📦 \`restock [produit] [qté]\` → réapprovisionner\n🗑️ \`annuler\` → annuler la dernière vente\n`;
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

    if (text.toLowerCase() === "hier") {
      if (!peutFaire(chatId, "commandes")) { await sendTelegram(chatId, "🚫 Accès refusé."); return; }
      const data = await callSheet("yesterday_sales");
      if (data.total_ventes === 0) { await sendTelegram(chatId, "📊 Aucune vente hier."); return; }
      let msg = `📊 *Ventes d'hier (${data.date})*
🔢 *${data.total_ventes}* | 💰 *${Number(data.total_montant).toLocaleString("fr-FR")}*

`;
      for (const [p,v] of Object.entries(data.par_produit||{})) msg += `📦 ${p} : ${v.quantite} — ${Number(v.montant).toLocaleString("fr-FR")}
`;
      msg += `
📋 *Détail :*
`;
      (data.detail||[]).forEach((v,i) => msg += `${i+1}. ${v.nom||"?"} — ${v.quantite}x ${v.produit} — ${Number(v.montant).toLocaleString("fr-FR")}
`);
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

    // supprimer une ligne précise
    if (text.toLowerCase().startsWith("supprimer ligne ")) {
      if (!peutFaire(chatId, "annuler")) { await sendTelegram(chatId, "🚫 Accès refusé."); return; }
      const parts = text.split(" ");
      const ligne = parseInt(parts[2], 10);
      if (!ligne) { await sendTelegram(chatId, "⚠️ Format : supprimer ligne [numéro]"); return; }
      const result = await callSheet("delete_sale", { ligne });
      if (result.status === "ok") {
        const s = result.supprime;
        await sendTelegram(chatId, `🗑️ *Supprimé !*\n\n👤 ${s.nom}\n📦 ${s.produit}\n🔢 ${s.quantite}\n💰 ${Number(s.montant).toLocaleString("fr-FR")}\n\n📦 Stock remis à jour.`);
      } else {
        await sendTelegram(chatId, `⚠️ Erreur : ${result.message}`);
      }
      return;
    }

    // annuler/supprimer une vente
    if (text.toLowerCase().includes("annuler") || text.toLowerCase().includes("supprimer")) {
      if (!peutFaire(chatId, "annuler")) { await sendTelegram(chatId, "🚫 Accès refusé."); return; }

      // Détecter "supprimer ligne X" en priorité
      const ligneMatch = text.match(/ligne\s+(\d+)/i);
      if (ligneMatch) {
        const ligneNum = parseInt(ligneMatch[1], 10);
        const result = await callSheet("delete_sale", { ligne: ligneNum });
        if (result.status === "ok") {
          const s = result.supprime;
          await sendTelegram(chatId, `🗑️ *Supprimé !*\n\n👤 ${s.nom}\n📦 ${s.produit}\n🔢 ${s.quantite}\n💰 ${Number(s.montant).toLocaleString("fr-FR")}\n\n📦 Stock remis à jour.`);
        } else {
          await sendTelegram(chatId, `⚠️ Ligne ${ligneNum} introuvable.`);
        }
        return;
      }

      // Extraire un nom éventuel : "supprimer Greg", "annuler vente de Marie"
      const stopWords = ["annuler", "supprimer", "la", "le", "les", "une", "vente", "ventes", "de", "du"];
      const words = text.split(" ").map(w => w.trim().toLowerCase()).filter(w => w && !stopWords.includes(w));
      const nomCible = words.join(" ").trim();

      if (nomCible) {
        // Chercher les ventes de ce client
        const searchResult = await callSheet("search_sale", { nom: nomCible });
        if (!searchResult.resultats || searchResult.resultats.length === 0) {
          await sendTelegram(chatId, `❌ Aucune vente trouvée pour *${nomCible}*.`);
          return;
        }

        if (searchResult.resultats.length === 1) {
          const v = searchResult.resultats[0];
          sessions[chatId].pendingDelete = true;
          sessions[chatId].pendingDeleteLigne = v.ligne;
          await sendTelegram(chatId,
            `⚠️ *Confirmer la suppression ?*

👤 ${v.nom}
📦 ${v.produit}
🔢 ${v.quantite}
💰 ${Number(v.montant).toLocaleString("fr-FR")}
📅 ${v.date}

✅ Tape \`confirmer\` pour supprimer
❌ Tape autre chose pour annuler`
          );
          return;
        }

        // Plusieurs ventes → afficher liste
        let msg = `🔍 *Ventes de "${nomCible}" :*

`;
        searchResult.resultats.forEach((v, i) => {
          msg += `${i+1}. Ligne ${v.ligne} — ${v.produit} × ${v.quantite} — ${Number(v.montant).toLocaleString("fr-FR")} — ${v.date}
`;
        });
        msg += `
Pour supprimer une ligne précise, tape :
\`supprimer ligne [numéro]\``;
        sessions[chatId].pendingSearch = searchResult.resultats;
        await sendTelegram(chatId, msg);
        return;
      }

      // Pas de nom → proposer la dernière vente
      const todayData = await callSheet("today_sales");
      if (!todayData.detail || todayData.detail.length === 0) {
        await sendTelegram(chatId, "❌ Aucune vente à supprimer aujourd'hui.");
        return;
      }
      const last = todayData.detail[todayData.detail.length - 1];
      sessions[chatId].pendingDelete = true;
      sessions[chatId].pendingDeleteLigne = null; // dernière ligne
      await sendTelegram(chatId,
        `⚠️ *Confirmer la suppression ?*

👤 ${last.nom||"?"}
📦 ${last.produit}
🔢 ${last.quantite}
💰 ${Number(last.montant).toLocaleString("fr-FR")}

✅ Tape \`confirmer\` pour supprimer
❌ Tape autre chose pour annuler`
      );
      return;
    }

    // supprimer une ligne précise
    if (text.toLowerCase().startsWith("supprimer ligne ")) {
      if (!peutFaire(chatId, "annuler")) { await sendTelegram(chatId, "🚫 Accès refusé."); return; }
      const parts = text.split(" ");
      const ligne = parseInt(parts[2], 10);
      if (!ligne) { await sendTelegram(chatId, "⚠️ Format : supprimer ligne [numéro]"); return; }
      const result = await callSheet("delete_sale", { ligne });
      if (result.status === "ok") {
        const s = result.supprime;
        await sendTelegram(chatId, `🗑️ *Supprimé !*

👤 ${s.nom}
📦 ${s.produit}
🔢 ${s.quantite}
💰 ${Number(s.montant).toLocaleString("fr-FR")}

📦 Stock remis à jour.`);
      } else {
        await sendTelegram(chatId, `⚠️ Erreur : ${result.message}`);
      }
      return;
    }


    if (text.toLowerCase() === "confirmer" && sessions[chatId]?.pendingDelete) {
      sessions[chatId].pendingDelete = false;
      const ligne = sessions[chatId].pendingDeleteLigne || null;
      const result = await callSheet("delete_sale", ligne ? { ligne } : {});
      if (result.status === "ok") {
        const s = result.supprime;
        await sendTelegram(chatId,
          `🗑️ *Vente annulée !*

👤 ${s.nom}
📦 ${s.produit}
🔢 ${s.quantite}
💰 ${Number(s.montant).toLocaleString("fr-FR")}

📦 Stock remis à jour.`
        );
      } else {
        await sendTelegram(chatId, "⚠️ Erreur lors de l'annulation.");
      }
      return;
    }

    // stats par vendeur
    if (text.toLowerCase() === "vendeurs") {
      if (!peutFaire(chatId, "vendeurs")) { await sendTelegram(chatId, "🚫 Accès refusé."); return; }
      const data = await callSheet("vendor_stats");
      if (!data.vendeurs || data.vendeurs.length === 0) {
        await sendTelegram(chatId, "📊 Aucune donnée vendeur.");
        return;
      }
      let msg = `👥 *Stats par client :*

`;
      data.vendeurs.slice(0, 10).forEach((v, i) => {
        msg += `${i+1}. 👤 *${v.nom}*`;
        if (v.telephone) msg += ` | 📞 ${v.telephone}`;
        msg += `
   🔢 ${v.total_ventes} achat(s) | 💰 ${Number(v.total_montant).toLocaleString("fr-FR")}\n`;
        for (const [p, pv] of Object.entries(v.produits||{}))
          msg += `   📦 ${p} : ${pv.quantite} unités\n`;
      });
      await sendTelegram(chatId, msg);
      return;
    }

    // réapprovisionner stock
    if (text.toLowerCase().startsWith("restock")) {
      if (!peutFaire(chatId, "restock")) { await sendTelegram(chatId, "🚫 Accès refusé."); return; }
      // Format : restock Soft 50
      const parts = text.split(" ").filter(p => p.trim());
      if (parts.length < 3) {
        await sendTelegram(chatId, '📦 Format : restock [produit] [quantité]\nEx: restock Soft 50');
        return;
      }
      const quantiteStr = parts[parts.length - 1];
      const produit     = parts.slice(1, -1).join(" ");
      const quantite    = parseInt(quantiteStr, 10);
      if (!produit || isNaN(quantite) || quantite <= 0) {
        await sendTelegram(chatId, "⚠️ Format invalide. Ex: `restock Soft 50`");
        return;
      }
      const result = await callSheet("restock", { produit, quantite });
      if (result.status === "ok") {
        await sendTelegram(chatId,
          `✅ *Stock réapprovisionné !*

📦 *${result.produit.toUpperCase()}*
➕ Ajouté : ${result.quantite_ajoutee}
📊 Nouveau stock initial : ${result.nouvel_initial}`
        );
      } else {
        await sendTelegram(chatId, `⚠️ ${result.message || "Erreur restock."}`);
      }
      return;
    }

    // ── VENTES ────────────────────────────────────────────────────
    if (peutFaire(chatId, "vente")) {

      // Format CSV (ordre flexible, prix optionnel si produit connu)
      if (text.includes(",")) {
        const parts = text.split(",").map(p => p.trim());
        if (parts.length >= 4) {
          // Récupérer catalogue pour prix automatique
          let cat = [];
          try { const sd = await callSheet("stock"); if (sd.status==="ok") cat = sd.stock||[]; } catch(e) {}

          // Passer par GPT pour détecter ordre flexible + prix auto
          const extracted = await extractSale(text, cat);
          if (extracted.is_sale && extracted.produit && extracted.quantite) {
            const pN = toFloat(extracted.prix_unitaire);
            const qN = toInt(extracted.quantite);
            if (pN > 0 && qN > 0) {
              await enregistrerVente(chatId, extracted.nom, extracted.telephone, extracted.produit, pN, qN);
              return;
            }
          }
        }
      }

      // Langage naturel
      let catalogue = [];
      try {
        const stockData = await callSheet("stock");
        if (stockData.status === "ok") catalogue = stockData.stock || [];
      } catch(e) {}
      const extracted = await extractSale(text, catalogue);
      if (extracted.is_sale && extracted.produit && extracted.quantite) {
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