'use strict';

async function initSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      phone        TEXT PRIMARY KEY,
      agent        TEXT NOT NULL DEFAULT 'router',
      form_type    TEXT,
      state        TEXT NOT NULL DEFAULT 'idle',
      field_index  INT NOT NULL DEFAULT 0,
      retry_count  INT NOT NULL DEFAULT 0,
      answers      JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query('ALTER TABLE sessions ADD COLUMN IF NOT EXISTS voice_reply BOOLEAN NOT NULL DEFAULT false');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS applications (
      id          SERIAL PRIMARY KEY,
      phone       TEXT NOT NULL,
      form_type   TEXT NOT NULL,
      data        JSONB NOT NULL,
      status      TEXT NOT NULL DEFAULT 'submitted',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS applications_phone_idx ON applications (phone)');
  console.log('✅ sessions + applications tables initialized.');
}

async function resetSession(pool, phone) {
  const r = await pool.query(
    `INSERT INTO sessions (phone) VALUES ($1)
     ON CONFLICT (phone) DO UPDATE SET
       agent = 'router', form_type = NULL, state = 'idle',
       field_index = 0, retry_count = 0, answers = '{}'::jsonb, updated_at = now()
     RETURNING *`,
    [phone]
  );
  return r.rows[0];
}

async function getSession(pool, phone) {
  const r = await pool.query('SELECT * FROM sessions WHERE phone = $1', [phone]);
  if (r.rows.length === 0) return resetSession(pool, phone);
  const s = r.rows[0];
  const ageMs = Date.now() - new Date(s.updated_at).getTime();
  if (ageMs > 24 * 60 * 60 * 1000) return resetSession(pool, phone);
  return s;
}

async function saveSession(pool, phone, patch) {
  const allowed = ['agent', 'form_type', 'state', 'field_index', 'retry_count', 'answers', 'voice_reply'];
  const keys = Object.keys(patch).filter((k) => allowed.includes(k));
  const sets = [];
  const vals = [];
  keys.forEach((k, i) => {
    sets.push(`${k} = $${i + 2}`);
    if (k === 'answers') vals.push(JSON.stringify(patch[k]));
    else vals.push(patch[k]);
  });
  sets.push('updated_at = now()');
  await pool.query(`UPDATE sessions SET ${sets.join(', ')} WHERE phone = $1`, [phone, ...vals]);
}

async function cleanupSessions(pool) {
  await pool.query("DELETE FROM sessions WHERE updated_at < now() - interval '24 hours'");
}

async function createApplication(pool, phone, formType, data) {
  const r = await pool.query(
    'INSERT INTO applications (phone, form_type, data) VALUES ($1, $2, $3) RETURNING id',
    [phone, formType, JSON.stringify(data)]
  );
  return r.rows[0].id;
}

async function getLatestApplication(pool, phone) {
  const r = await pool.query(
    'SELECT id, form_type, status, created_at FROM applications WHERE phone = $1 ORDER BY id DESC LIMIT 1',
    [phone]
  );
  return r.rows[0] || null;
}

module.exports = { initSchema, getSession, resetSession, saveSession, cleanupSessions, createApplication, getLatestApplication };
