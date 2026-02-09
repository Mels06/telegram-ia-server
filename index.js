app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const message = req.body.message;
    if (!message || !message.text) return;

    const chatId = message.chat.id;
    const text = message.text.trim();

    // ✅ Définir userText correctement
    const userText = text.toLowerCase();

    console.log("📩 Message reçu :", text);

    // ===============================
    // ✅ COMMANDE STOCK DIRECTE
    // ===============================
    if (userText === "stock") {
      const response = await axios.get(SCRIPT_URL + "?action=stock");
      await sendTelegram(chatId, response.data);
      return;
    }

    // ===============================
    // ✅ FILTRE ENTREPRISE
    // ===============================
    const businessKeywords = [
      "vente",
      "vendu",
      "stock",
      "produit",
      "prix",
      "quantité",
      "client",
      "chiffre",
      "recette",
      "bénéfice",
      "jour",
      "mois",
    ];

    const isBusiness = businessKeywords.some((word) =>
      userText.includes(word)
    );

    // Si pas business → refuser gentiment
    if (!isBusiness && !text.includes(",")) {
      await sendTelegram(
        chatId,
        "📌 Je suis ton assistant de gestion d’entreprise.\n\nJe réponds uniquement aux questions liées aux ventes, stock, produits et chiffres.\n\n✅ Exemple :\n- stock\n- J’ai vendu 2 soft\n- Marie, 0606, Blue, 20000, 1"
      );
      return;
    }

    // ===============================
    // ✅ VENTE FORMAT VIRGULES
    // ===============================
    if (text.includes(",")) {
      const parts = text.split(",");

      if (parts.length < 5) {
        await sendTelegram(
          chatId,
          "❌ Format attendu : Nom, Téléphone, Produit, Prix, Quantité"
        );
        return;
      }

      const nom = parts[0].trim();
      const tel = parts[1].trim();
      const produit = parts[2].trim();
      const prix = parts[3].trim();
      const quantite = parts[4].trim();

      if (isNaN(prix) || isNaN(quantite)) {
        await sendTelegram(
          chatId,
          "❌ Prix et quantité doivent être des nombres."
        );
        return;
      }

      await addSaleToSheet(nom, tel, produit, prix, quantite);

      await sendTelegram(
        chatId,
        `✅ Vente enregistrée : ${nom} a acheté ${quantite} ${produit} (${prix} FCFA)`
      );

      return;
    }

    // ===============================
    // ✅ GPT POUR DISCUSSION BUSINESS
    // ===============================
    const gptReply = await askGPT(text);
    await sendTelegram(chatId, gptReply);

  } catch (err) {
    console.log("❌ Erreur :", err.message);
  }
});
