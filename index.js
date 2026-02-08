app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const message = req.body.message;
    if (!message || !message.text) return;

    const chatId = message.chat.id;
    const userText = message.text.trim();

    console.log("📩 Message reçu :", userText);

    // ✅ Si vente envoyée avec virgules
    if (userText.includes(",")) {
      const parts = userText.split(",");

      // ✅ On attend exactement 5 infos
      if (parts.length < 5) {
        await sendTelegram(
          chatId,
          "❌ Format attendu : Nom, Téléphone, Produit, Prix, Quantité"
        );
        return;
      }

      // ✅ Variables correctes
      const nom_complet = parts[0].trim();
      const telephone = parts[1].trim();
      const produit = parts[2].trim();
      const prix_unitaire = Number(parts[3].trim());
      const quantite = Number(parts[4].trim());

      // ✅ Montant total automatique
      const montant_total = prix_unitaire * quantite;

      // ✅ Envoi vers Google Sheet
      await axios.post(SCRIPT_URL, {
        nom_complet,
        telephone,
        produit,
        prix_unitaire,
        quantite,
        montant_total,
      });

      // ✅ Confirmation Telegram
      await sendTelegram(
        chatId,
        `✅ Vente enregistrée : ${nom_complet} / ${produit} / ${prix_unitaire} FCFA x${quantite}`
      );

      return;
    }

    // ✅ Message normal si pas une vente
    await sendTelegram(
      chatId,
      "💡 Envoie une vente comme : Nom, Téléphone, Produit, Prix, Quantité"
    );
  } catch (err) {
    console.log("❌ Erreur webhook :", err);
  }
});
