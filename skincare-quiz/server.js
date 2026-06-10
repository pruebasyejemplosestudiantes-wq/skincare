const express = require('express');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const app = express();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
});

// Crea las tablas automáticamente si no existen (safe: usa IF NOT EXISTS)
async function runMigrations() {
  const sql = fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf8');
  await pool.query(sql);
  console.log('Tablas verificadas/creadas correctamente.');
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// POST /api/submit — guarda usuario + respuestas al terminar el quiz
app.post('/api/submit', async (req, res) => {
  const { userId, answers, resultType, scores } = req.body;

  if (!userId || !answers || !resultType || !scores) {
    return res.status(400).json({ error: 'Faltan campos requeridos.' });
  }

  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
  const ua = req.headers['user-agent'] || '';

  try {
    // Crea el usuario si no existe; actualiza user-agent en cada visita
    await pool.query(
      `INSERT INTO quiz_users (id, ip_address, user_agent)
       VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE
         SET ip_address = EXCLUDED.ip_address,
             user_agent  = EXCLUDED.user_agent`,
      [userId, ip, ua]
    );

    // Inserta la respuesta del quiz
    const result = await pool.query(
      `INSERT INTO quiz_responses (user_id, answers, result_type, scores)
       VALUES ($1, $2::jsonb, $3, $4::jsonb)
       RETURNING id, completed_at`,
      [userId, JSON.stringify(answers), resultType, JSON.stringify(scores)]
    );

    res.json({ success: true, responseId: result.rows[0].id });
  } catch (err) {
    console.error('[/api/submit]', err.message);
    res.status(500).json({ error: 'Error al guardar las respuestas.' });
  }
});

// GET /api/stats — resumen de resultados (uso interno / admin)
app.get('/api/stats', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT result_type, COUNT(*)::int AS total
       FROM quiz_responses
       GROUP BY result_type
       ORDER BY total DESC`
    );
    res.json(rows);
  } catch (err) {
    console.error('[/api/stats]', err.message);
    res.status(500).json({ error: 'Error al obtener estadísticas.' });
  }
});

const PORT = process.env.PORT || 3000;

runMigrations()
  .then(() => {
    app.listen(PORT, () => console.log(`Servidor corriendo en http://localhost:${PORT}`));
  })
  .catch(err => {
    console.error('Error al crear tablas:', err.message ?? err);
    console.error('DATABASE_URL definida:', !!process.env.DATABASE_URL);
    process.exit(1);
  });
