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

app.listen(3000, () => {
  console.log('Servidor corriendo en http://localhost:3000');
});

