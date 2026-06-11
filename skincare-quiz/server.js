const express = require('express');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const app = express();

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
    })
  : null;

async function runMigrations() {
  if (!pool) { console.log('Sin DATABASE_URL — modo visual (sin BD).'); return; }
  const sql = fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf8');
  await pool.query(sql);
  console.log('Tablas verificadas/creadas correctamente.');
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// POST /api/save — crea o actualiza una respuesta (parcial o completa)
// Body: { userId, responseId?, answers, questionsDone, resultType?, scores?, isCompleted }
app.post('/api/save', async (req, res) => {
  const { userId, responseId, answers, questionsDone, resultType, scores, isCompleted, email } = req.body;

  if (!userId || !Array.isArray(answers)) {
    return res.status(400).json({ error: 'Faltan campos requeridos.' });
  }

  if (!pool) return res.json({ success: true, responseId: 'demo-' + userId });

  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
  const ua = req.headers['user-agent'] || '';

  try {
    // Upsert usuario
    await pool.query(
      `INSERT INTO quiz_users (id, ip_address, user_agent, email)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE
         SET ip_address = EXCLUDED.ip_address,
             user_agent  = EXCLUDED.user_agent,
             email       = COALESCE(EXCLUDED.email, quiz_users.email)`,
      [userId, ip, ua, email ?? null]
    );

    let savedId;

    if (responseId) {
      // Actualizar respuesta existente
      const result = await pool.query(
        `UPDATE quiz_responses
         SET answers        = $1::jsonb,
             questions_done = $2,
             result_type    = $3,
             scores         = $4::jsonb,
             is_completed   = $5,
             completed_at   = $6
         WHERE id = $7 AND user_id = $8
         RETURNING id`,
        [
          JSON.stringify(answers),
          questionsDone,
          resultType ?? null,
          scores ? JSON.stringify(scores) : null,
          isCompleted ?? false,
          isCompleted ? new Date() : null,
          responseId,
          userId,
        ]
      );
      savedId = result.rows[0]?.id;
    } else {
      // Crear nueva respuesta
      const result = await pool.query(
        `INSERT INTO quiz_responses (user_id, answers, questions_done, result_type, scores, is_completed, completed_at)
         VALUES ($1, $2::jsonb, $3, $4, $5::jsonb, $6, $7)
         RETURNING id`,
        [
          userId,
          JSON.stringify(answers),
          questionsDone,
          resultType ?? null,
          scores ? JSON.stringify(scores) : null,
          isCompleted ?? false,
          isCompleted ? new Date() : null,
        ]
      );
      savedId = result.rows[0].id;
    }

    res.json({ success: true, responseId: savedId });
  } catch (err) {
    console.error('[/api/save]', err.message);
    res.status(500).json({ error: 'Error al guardar.' });
  }
});

// GET /api/stats — distribución de resultados completados
app.get('/api/stats', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT result_type, COUNT(*)::int AS total
       FROM quiz_responses
       WHERE is_completed = true
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
