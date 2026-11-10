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
  await pool.query("ALTER TABLE sessions ADD COLUMN IF NOT EXISTS chat_history JSONB NOT NULL DEFAULT '[]'::jsonb");
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
  await pool.query("ALTER TABLE applications ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'reverse' CHECK (mode IN ('normal', 'reverse'))");
  await pool.query('ALTER TABLE applications ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now()');
  await pool.query('DELETE FROM applications a USING applications b WHERE a.phone = b.phone AND a.form_type = b.form_type AND a.id < b.id');
  await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS applications_phone_form_uq ON applications (phone, form_type)');
  await pool.query('CREATE INDEX IF NOT EXISTS applications_phone_idx ON applications (phone)');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS focal_persons (
      form_type  TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      email      TEXT NOT NULL
    )
  `);
  await pool.query(`
    INSERT INTO focal_persons (form_type, name, email) VALUES
      ('id_card', 'Ayesha Khan (ID card focal person)', 'focal.idcard@example.com'),
      ('health_card', 'Bilal Ahmed (health card focal person)', 'focal.health@example.com'),
      ('license', 'Sara Malik (license focal person)', 'focal.license@example.com')
    ON CONFLICT (form_type) DO NOTHING
  `);
  console.log('✅ sessions, applications, focal_persons tables initialized.');
}

async function resetSession(pool, phone) {
  const r = await pool.query(
    `INSERT INTO sessions (phone) VALUES ($1)
     ON CONFLICT (phone) DO UPDATE SET
       agent = 'router', form_type = NULL, state = 'idle',
       field_index = 0, retry_count = 0, answers = '{}'::jsonb, chat_history = '[]'::jsonb, updated_at = now()
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
  const allowed = ['agent', 'form_type', 'state', 'field_index', 'retry_count', 'answers', 'voice_reply', 'chat_history'];
  const keys = Object.keys(patch).filter((k) => allowed.includes(k));
  const sets = [];
  const vals = [];
  keys.forEach((k, i) => {
    sets.push(`${k} = $${i + 2}`);
    if (k === 'answers' || k === 'chat_history') vals.push(JSON.stringify(patch[k]));
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
    `INSERT INTO applications (phone, form_type, data, status, mode)
     VALUES ($1, $2, $3, 'submitted', 'reverse')
     ON CONFLICT (phone, form_type) DO UPDATE SET
       data = EXCLUDED.data, status = 'submitted', mode = 'reverse', updated_at = now()
     RETURNING id`,
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

async function getApplication(pool, phone, formType) {
  const r = await pool.query(
    'SELECT id, form_type, data, status, mode FROM applications WHERE phone = $1 AND form_type = $2',
    [phone, formType]
  );
  return r.rows[0] || null;
}

async function listApplicationsForPhone(pool, phone) {
  const r = await pool.query(
    'SELECT id, form_type, status, mode FROM applications WHERE phone = $1 ORDER BY id',
    [phone]
  );
  return r.rows;
}

async function getFocal(pool, formType) {
  const r = await pool.query('SELECT name, email FROM focal_persons WHERE form_type = $1', [formType]);
  return r.rows[0] || null;
}

module.exports = { initSchema, getSession, resetSession, saveSession, cleanupSessions, createApplication, getLatestApplication, getApplication, listApplicationsForPhone, getFocal };
