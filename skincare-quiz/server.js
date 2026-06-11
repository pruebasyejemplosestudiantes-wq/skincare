const express = require('express');
const { Pool } = require('pg');
const crypto = require('crypto');
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

// ── Auth helpers ─────────────────────────────────────────────────────────────
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const ADMIN_TOKEN = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest('hex');
const COOKIE_NAME = 'skincare_admin';

function getCookie(req, name) {
  const cookies = req.headers.cookie || '';
  const match = cookies.split(';').map(c => c.trim()).find(c => c.startsWith(name + '='));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

function requireAdmin(req, res, next) {
  if (getCookie(req, COOKIE_NAME) === ADMIN_TOKEN) return next();
  res.redirect('/admin/login');
}

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Quiz API ──────────────────────────────────────────────────────────────────

// POST /api/save
app.post('/api/save', async (req, res) => {
  const { userId, responseId, answers, questionsDone, resultType, scores, isCompleted, email } = req.body;

  if (!userId || !Array.isArray(answers)) {
    return res.status(400).json({ error: 'Faltan campos requeridos.' });
  }

  if (!pool) return res.json({ success: true, responseId: 'demo-' + userId });

  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
  const ua = req.headers['user-agent'] || '';

  try {
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

// POST /api/track-pay-click
app.post('/api/track-pay-click', async (req, res) => {
  const { userId, email } = req.body;
  if (!pool) return res.json({ success: true });

  try {
    await pool.query(
      `INSERT INTO pay_clicks (user_id, email) VALUES (
        (SELECT id FROM quiz_users WHERE id = $1::uuid LIMIT 1),
        $2
      )`,
      [userId || null, email || null]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('[/api/track-pay-click]', err.message);
    res.json({ success: false });
  }
});

// GET /api/stats
app.get('/api/stats', async (req, res) => {
  if (!pool) return res.json([]);
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

// ── Hotmart webhook ───────────────────────────────────────────────────────────

// POST /api/hotmart/webhook
app.post('/api/hotmart/webhook', async (req, res) => {
  // Responder 200 inmediatamente para que Hotmart no reintente
  res.json({ received: true });

  const payload = req.body;
  console.log('[hotmart webhook]', JSON.stringify(payload).slice(0, 300));

  if (!pool) return;

  try {
    const event     = payload.event || payload.status || 'UNKNOWN';
    const buyer     = payload.data?.buyer || {};
    const purchase  = payload.data?.purchase || {};
    const email     = (buyer.email || '').toLowerCase().trim();
    const name      = buyer.name || null;
    const txId      = purchase.transaction || null;
    const status    = purchase.status || event;

    if (!email && !txId) return;

    await pool.query(
      `INSERT INTO payments (transaction_id, email, name, status, event_type, raw_payload)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       ON CONFLICT (transaction_id) DO UPDATE
         SET status      = EXCLUDED.status,
             event_type  = EXCLUDED.event_type,
             name        = COALESCE(EXCLUDED.name, payments.name),
             raw_payload = EXCLUDED.raw_payload,
             updated_at  = NOW()`,
      [txId, email || null, name, status, event, JSON.stringify(payload)]
    );
  } catch (err) {
    console.error('[hotmart webhook save]', err.message);
  }
});

// ── Admin ─────────────────────────────────────────────────────────────────────

// GET /admin → redirige a login o dashboard
app.get('/admin', (req, res) => {
  if (getCookie(req, COOKIE_NAME) === ADMIN_TOKEN) return res.redirect('/admin/dashboard');
  res.redirect('/admin/login');
});

// GET /admin/login
app.get('/admin/login', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Admin — Login</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:'Georgia',serif;background:#fdf6f0;display:flex;align-items:center;justify-content:center;min-height:100vh}
    .card{background:#fff;border-radius:20px;padding:40px;box-shadow:0 8px 40px rgba(100,40,10,.1);width:100%;max-width:360px}
    h1{font-size:1.4rem;font-weight:normal;color:#4a2010;text-align:center;margin-bottom:8px}
    p{text-align:center;color:#9a5c3a;font-size:.85rem;margin-bottom:28px}
    input{width:100%;padding:12px 16px;border:1.5px solid #e8c4b0;border-radius:10px;font-size:.95rem;font-family:inherit;outline:none;margin-bottom:14px}
    input:focus{border-color:#c26045}
    button{width:100%;padding:13px;background:#c26045;color:#fff;border:none;border-radius:10px;font-size:1rem;cursor:pointer;font-family:inherit}
    button:hover{background:#a84e38}
    .err{color:#c04030;font-size:.82rem;text-align:center;margin-top:10px}
  </style>
</head>
<body>
<div class="card">
  <h1>Panel Admin</h1>
  <p>Skincare Quiz</p>
  <form method="POST" action="/admin/login">
    <input type="password" name="password" placeholder="Contraseña" autofocus/>
    <button type="submit">Entrar</button>
  </form>
  ${req.query.error ? '<p class="err">Contraseña incorrecta.</p>' : ''}
</div>
</body>
</html>`);
});

// POST /admin/login
app.post('/admin/login', (req, res) => {
  const { password } = req.body;
  const token = crypto.createHash('sha256').update(password || '').digest('hex');
  if (token !== ADMIN_TOKEN) return res.redirect('/admin/login?error=1');
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${ADMIN_TOKEN}; HttpOnly; Path=/; SameSite=Strict`);
  res.redirect('/admin/dashboard');
});

// GET /admin/logout
app.get('/admin/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0`);
  res.redirect('/admin/login');
});

// GET /admin/dashboard
app.get('/admin/dashboard', requireAdmin, async (req, res) => {
  if (!pool) {
    return res.send('<h2 style="font-family:sans-serif;padding:40px">Sin base de datos conectada.</h2>');
  }

  try {
    const { rows } = await pool.query(`
      WITH emails AS (
        SELECT LOWER(email) AS email FROM quiz_users WHERE email IS NOT NULL AND email <> ''
        UNION
        SELECT LOWER(email) FROM pay_clicks WHERE email IS NOT NULL AND email <> ''
        UNION
        SELECT LOWER(email) FROM payments WHERE email IS NOT NULL AND email <> ''
      ),
      latest_quiz AS (
        SELECT DISTINCT ON (LOWER(qu.email))
          LOWER(qu.email) AS email,
          qu.email AS raw_email,
          qr.started_at AS quiz_date,
          qr.result_type,
          qr.is_completed
        FROM quiz_users qu
        JOIN quiz_responses qr ON qr.user_id = qu.id
        WHERE qu.email IS NOT NULL
        ORDER BY LOWER(qu.email), qr.started_at DESC
      ),
      latest_click AS (
        SELECT DISTINCT ON (LOWER(email))
          LOWER(email) AS email,
          clicked_at
        FROM pay_clicks
        WHERE email IS NOT NULL
        ORDER BY LOWER(email), clicked_at DESC
      ),
      latest_payment AS (
        SELECT DISTINCT ON (LOWER(email))
          LOWER(email) AS email,
          name,
          status,
          transaction_id,
          updated_at AS payment_date
        FROM payments
        WHERE email IS NOT NULL
        ORDER BY LOWER(email), updated_at DESC
      )
      SELECT
        COALESCE(lq.raw_email, lc.email, lp.email, e.email) AS email,
        lp.name,
        lq.quiz_date,
        lq.result_type,
        lc.clicked_at AS pay_clicked_at,
        lp.status AS payment_status,
        lp.transaction_id,
        lp.payment_date
      FROM emails e
      LEFT JOIN latest_quiz    lq ON lq.email = e.email
      LEFT JOIN latest_click   lc ON lc.email = e.email
      LEFT JOIN latest_payment lp ON lp.email = e.email
      ORDER BY COALESCE(lq.quiz_date, lc.clicked_at, lp.payment_date) DESC NULLS LAST
    `);

    const fmt = (d) => d ? new Date(d).toLocaleString('es-CO', { timeZone: 'America/Bogota' }) : '—';
    const statusBadge = (s) => {
      if (!s) return '<span style="color:#aaa">—</span>';
      const colors = { APPROVED:'#2a7a2a', COMPLETE:'#2a7a2a', CANCELLED:'#b03020', REFUNDED:'#b03020', CHARGEBACK:'#b03020', DISPUTE:'#c07010', EXPIRED:'#888' };
      const color = colors[s] || '#555';
      return `<span style="color:${color};font-weight:bold">${s}</span>`;
    };

    const rows_html = rows.map(r => `
      <tr>
        <td>${r.email || '—'}</td>
        <td>${r.name || '—'}</td>
        <td>${fmt(r.quiz_date)}</td>
        <td>${r.result_type || '—'}</td>
        <td>${fmt(r.pay_clicked_at)}</td>
        <td>${statusBadge(r.payment_status)}</td>
        <td style="font-size:.8rem;color:#888">${r.transaction_id || '—'}</td>
        <td>${fmt(r.payment_date)}</td>
      </tr>`).join('');

    res.send(`<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Admin — Skincare Quiz</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:'Georgia',serif;background:#fdf6f0;color:#2c1a0e;padding:32px 24px}
    .top{display:flex;justify-content:space-between;align-items:center;margin-bottom:28px;flex-wrap:wrap;gap:12px}
    h1{font-size:1.5rem;font-weight:normal;color:#4a2010}
    .actions{display:flex;gap:10px;align-items:center}
    .btn{padding:10px 20px;border-radius:10px;border:none;cursor:pointer;font-family:inherit;font-size:.88rem;text-decoration:none;display:inline-block}
    .btn-csv{background:#c26045;color:#fff}
    .btn-csv:hover{background:#a84e38}
    .btn-out{background:transparent;color:#c26045;border:1.5px solid #e8c4b0}
    .btn-out:hover{background:#fff5ef}
    .card{background:#fff;border-radius:16px;box-shadow:0 4px 24px rgba(100,40,10,.08);overflow:auto}
    table{width:100%;border-collapse:collapse;font-size:.88rem}
    th{background:#fdf0e8;color:#7a3e1a;font-size:.75rem;letter-spacing:1px;text-transform:uppercase;padding:12px 16px;text-align:left;white-space:nowrap}
    td{padding:11px 16px;border-top:1px solid #f5e8de;vertical-align:top;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    tr:hover td{background:#fffaf7}
    .count{color:#8a5c40;font-size:.85rem;margin-bottom:12px}
  </style>
</head>
<body>
<div class="top">
  <h1>Panel de seguimiento</h1>
  <div class="actions">
    <a class="btn btn-csv" href="/admin/export.csv">Descargar CSV</a>
    <a class="btn btn-out" href="/admin/logout">Cerrar sesión</a>
  </div>
</div>
<p class="count">${rows.length} registro${rows.length !== 1 ? 's' : ''}</p>
<div class="card">
  <table>
    <thead><tr>
      <th>Email</th>
      <th>Nombre</th>
      <th>Fecha quiz</th>
      <th>Resultado</th>
      <th>Click "Ir a pagar"</th>
      <th>Estado pago</th>
      <th>Transacción</th>
      <th>Fecha pago</th>
    </tr></thead>
    <tbody>${rows_html || '<tr><td colspan="8" style="text-align:center;color:#aaa;padding:32px">Sin datos aún.</td></tr>'}</tbody>
  </table>
</div>
</body>
</html>`);
  } catch (err) {
    console.error('[/admin/dashboard]', err.message);
    res.status(500).send('Error cargando datos.');
  }
});

// GET /admin/export.csv
app.get('/admin/export.csv', requireAdmin, async (req, res) => {
  if (!pool) return res.status(503).send('Sin base de datos.');

  try {
    const { rows } = await pool.query(`
      WITH emails AS (
        SELECT LOWER(email) AS email FROM quiz_users WHERE email IS NOT NULL AND email <> ''
        UNION
        SELECT LOWER(email) FROM pay_clicks WHERE email IS NOT NULL AND email <> ''
        UNION
        SELECT LOWER(email) FROM payments WHERE email IS NOT NULL AND email <> ''
      ),
      latest_quiz AS (
        SELECT DISTINCT ON (LOWER(qu.email))
          LOWER(qu.email) AS email,
          qu.email AS raw_email,
          qr.started_at AS quiz_date,
          qr.result_type
        FROM quiz_users qu
        JOIN quiz_responses qr ON qr.user_id = qu.id
        WHERE qu.email IS NOT NULL
        ORDER BY LOWER(qu.email), qr.started_at DESC
      ),
      latest_click AS (
        SELECT DISTINCT ON (LOWER(email))
          LOWER(email) AS email,
          clicked_at
        FROM pay_clicks
        WHERE email IS NOT NULL
        ORDER BY LOWER(email), clicked_at DESC
      ),
      latest_payment AS (
        SELECT DISTINCT ON (LOWER(email))
          LOWER(email) AS email,
          name,
          status,
          transaction_id,
          updated_at AS payment_date
        FROM payments
        WHERE email IS NOT NULL
        ORDER BY LOWER(email), updated_at DESC
      )
      SELECT
        COALESCE(lq.raw_email, lc.email, lp.email, e.email) AS email,
        COALESCE(lp.name, '') AS name,
        lq.quiz_date,
        COALESCE(lq.result_type, '') AS result_type,
        lc.clicked_at AS pay_clicked_at,
        COALESCE(lp.status, '') AS payment_status,
        COALESCE(lp.transaction_id, '') AS transaction_id,
        lp.payment_date
      FROM emails e
      LEFT JOIN latest_quiz    lq ON lq.email = e.email
      LEFT JOIN latest_click   lc ON lc.email = e.email
      LEFT JOIN latest_payment lp ON lp.email = e.email
      ORDER BY COALESCE(lq.quiz_date, lc.clicked_at, lp.payment_date) DESC NULLS LAST
    `);

    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const fmt = (d) => d ? new Date(d).toISOString() : '';

    const header = ['Email', 'Nombre', 'Fecha quiz', 'Resultado quiz', 'Click ir a pagar', 'Estado pago', 'Transacción Hotmart', 'Fecha pago'].join(',');
    const body = rows.map(r => [
      esc(r.email), esc(r.name), esc(fmt(r.quiz_date)), esc(r.result_type),
      esc(fmt(r.pay_clicked_at)), esc(r.payment_status), esc(r.transaction_id), esc(fmt(r.payment_date))
    ].join(',')).join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="skincare-quiz.csv"');
    res.send('﻿' + header + '\n' + body); // BOM para que Excel lo abra bien
  } catch (err) {
    console.error('[/admin/export.csv]', err.message);
    res.status(500).send('Error exportando.');
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
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
