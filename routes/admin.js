const express = require('express');
const { db, STAGES } = require('../src/db');

const router = express.Router();

// Простая проверка: заголовок x-telegram-id должен принадлежать админу
function requireAdmin(req, res, next) {
  const telegramId = req.header('x-telegram-id');
  if (!telegramId) return res.status(401).json({ error: 'no_auth' });
  const user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegramId);
  if (!user || !user.is_admin) return res.status(403).json({ error: 'forbidden' });
  next();
}

router.use(requireAdmin);

// --- Список этапов (для выпадающего списка при назначении роли) ---
router.get('/stages', (req, res) => {
  res.json(STAGES);
});

// --- Сотрудники ---
router.get('/users', (req, res) => {
  const rows = db.prepare('SELECT telegram_id, full_name, stage, is_admin, created_at FROM users ORDER BY created_at DESC').all();
  res.json(rows);
});

// Создать/обновить сотрудника (регистрация вручную операционистом по telegram_id)
router.post('/users', (req, res) => {
  const { telegram_id, full_name, stage, is_admin } = req.body;
  if (!telegram_id || !full_name || !stage) {
    return res.status(400).json({ error: 'bad_request' });
  }
  if (!STAGES.find(s => s.code === stage)) {
    return res.status(400).json({ error: 'unknown_stage' });
  }
  db.prepare(`
    INSERT INTO users (telegram_id, full_name, stage, is_admin)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(telegram_id) DO UPDATE SET full_name = excluded.full_name, stage = excluded.stage, is_admin = excluded.is_admin
  `).run(telegram_id, full_name, stage, is_admin ? 1 : 0);
  res.json({ ok: true });
});

router.delete('/users/:telegramId', (req, res) => {
  db.prepare('DELETE FROM users WHERE telegram_id = ?').run(req.params.telegramId);
  res.json({ ok: true });
});

// --- Номенклатура ---
router.get('/nomenclature', (req, res) => {
  const rows = db.prepare('SELECT * FROM nomenclature ORDER BY sort_order, id').all();
  res.json(rows);
});

router.post('/nomenclature', (req, res) => {
  const { name, unit } = req.body;
  if (!name) return res.status(400).json({ error: 'bad_request' });
  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM nomenclature').get().m;
  const info = db.prepare('INSERT INTO nomenclature (name, unit, sort_order) VALUES (?, ?, ?)')
    .run(name, unit || 'шт', maxOrder + 1);
  res.json({ ok: true, id: info.lastInsertRowid });
});

router.put('/nomenclature/:id', (req, res) => {
  const { name, unit, active } = req.body;
  db.prepare('UPDATE nomenclature SET name = COALESCE(?, name), unit = COALESCE(?, unit), active = COALESCE(?, active) WHERE id = ?')
    .run(name ?? null, unit ?? null, active === undefined ? null : (active ? 1 : 0), req.params.id);
  res.json({ ok: true });
});

router.delete('/nomenclature/:id', (req, res) => {
  // Мягкое удаление — просто деактивируем, чтобы не терять историю по старым записям
  db.prepare('UPDATE nomenclature SET active = 0 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
