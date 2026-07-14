const express = require('express');
const { db, STAGES } = require('../src/db');

const router = express.Router();

function getStageMeta(code) {
  return STAGES.find(s => s.code === code);
}

// Кто я и какой у меня этап
router.get('/me/:telegramId', (req, res) => {
  const { telegramId } = req.params;
  const user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegramId);
  if (!user) {
    return res.status(404).json({ error: 'not_registered' });
  }
  const stageMeta = getStageMeta(user.stage);
  res.json({
    telegram_id: user.telegram_id,
    full_name: user.full_name,
    is_admin: !!user.is_admin,
    stage: user.stage,
    stage_title: stageMeta ? stageMeta.title : user.stage,
    needs_grade: stageMeta ? stageMeta.needsGrade : false,
  });
});

// Активная номенклатура для формы
router.get('/nomenclature', (req, res) => {
  const rows = db.prepare('SELECT id, name, unit FROM nomenclature WHERE active = 1 ORDER BY sort_order, id').all();
  res.json(rows);
});

// Отправка партии записей за один сабмит формы
// body: { telegram_id, entry_date, items: [{ nomenclature_id, quantity, grade?, comment? }] }
router.post('/submit', (req, res) => {
  const { telegram_id, entry_date, items } = req.body;

  if (!telegram_id || !entry_date || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'bad_request' });
  }

  const user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegram_id);
  if (!user) {
    return res.status(404).json({ error: 'not_registered' });
  }

  const stageMeta = getStageMeta(user.stage);

  const insert = db.prepare(`
    INSERT INTO entries (entry_date, stage, telegram_id, employee_name, nomenclature_id, quantity, grade, comment)
    VALUES (@entry_date, @stage, @telegram_id, @employee_name, @nomenclature_id, @quantity, @grade, @comment)
  `);

  const insertMany = db.transaction((rows) => {
    for (const row of rows) insert.run(row);
  });

  const rows = items
    .filter(it => Number(it.quantity) > 0)
    .map(it => ({
      entry_date,
      stage: user.stage,
      telegram_id: user.telegram_id,
      employee_name: user.full_name,
      nomenclature_id: it.nomenclature_id,
      quantity: Number(it.quantity),
      grade: stageMeta && stageMeta.needsGrade ? (it.grade || null) : null,
      comment: it.comment || null,
    }));

  if (rows.length === 0) {
    return res.status(400).json({ error: 'no_valid_items' });
  }

  insertMany(rows);
  res.json({ ok: true, saved: rows.length });
});

// Удалить свою запись (только за сегодня — чтобы нельзя было редактировать закрытую историю)
router.delete('/entries/:id', (req, res) => {
  const { telegram_id } = req.query;
  const { id } = req.params;
  if (!telegram_id) return res.status(400).json({ error: 'bad_request' });

  const today = new Date().toISOString().slice(0, 10);
  const entry = db.prepare('SELECT * FROM entries WHERE id = ?').get(id);

  if (!entry) return res.status(404).json({ error: 'not_found' });
  if (entry.telegram_id !== String(telegram_id)) return res.status(403).json({ error: 'not_yours' });
  if (entry.entry_date !== today) return res.status(403).json({ error: 'not_today' });

  db.prepare('DELETE FROM entries WHERE id = ?').run(id);
  res.json({ ok: true });
});

// История за сегодня для этого сотрудника (чтобы видел что уже вбил)
router.get('/today/:telegramId', (req, res) => {
  const { telegramId } = req.params;
  const today = new Date().toISOString().slice(0, 10);
  const rows = db.prepare(`
    SELECT e.id, e.quantity, e.grade, e.comment, e.created_at, n.name AS nomenclature_name
    FROM entries e
    JOIN nomenclature n ON n.id = e.nomenclature_id
    WHERE e.telegram_id = ? AND e.entry_date = ?
    ORDER BY e.created_at DESC
  `).all(telegramId, today);
  res.json(rows);
});

module.exports = router;
