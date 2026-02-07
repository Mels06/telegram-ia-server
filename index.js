const express = require("express");

const app = express();
app.use(express.json());

// ✅ Page test
app.get("/", (req, res) => {
  res.send("OK SERVER RUNNING");
});

// ✅ Webhook Telegram test
app.post("/webhook", (req, res) => {
  console.log("🔥 TELEGRAM A TOUCHÉ LE WEBHOOK !");
  console.log(req.body);

  res.sendStatus(200);
});

// ✅ Démarrage serveur
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Serveur démarré sur le port", PORT);
});
