const express = require('express');
const cors = require('cors');

const app = express();

app.use(cors());
app.use(express.json());

// 🔥 ENDPOINT DE PRUEBA
app.get('/api/precios', (req, res) => {
  res.json({
    mercado: "CDMX",
    regular: 22.50,
    premium: 24.30,
    diesel: 23.10
  });
});

// ✅ IMPORTANTE PARA RENDER
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});
