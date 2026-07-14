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

// --- Просмотр смены (для дашборда, без экспорта) ---
router.get('/entries', (req, res) => {
  const { date_from, date_to } = req.query;
  const from = date_from || new Date().toISOString().slice(0, 10);
  const to = date_to || from;

  const rows = db.prepare(`
    SELECT e.id, e.entry_date, e.stage, e.telegram_id, e.employee_name,
           n.name AS nomenclature_name, e.quantity, e.grade, e.comment, e.created_at
    FROM entries e
    JOIN nomenclature n ON n.id = e.nomenclature_id
    WHERE e.entry_date BETWEEN ? AND ?
    ORDER BY e.stage, e.employee_name, e.created_at
  `).all(from, to);

  res.json(rows);
});

// Удалить запись (админ может удалить любую, за любую дату — для исправления ошибок задним числом)
router.delete('/entries/:id', (req, res) => {
  const info = db.prepare('DELETE FROM entries WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'not_found' });
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
