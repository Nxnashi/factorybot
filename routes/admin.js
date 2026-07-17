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
// stage может быть списком через запятую, например "molding,qc_final"
router.post('/users', (req, res) => {
  const { telegram_id, full_name, stage, is_admin } = req.body;
  if (!telegram_id || !full_name || !stage) {
    return res.status(400).json({ error: 'bad_request' });
  }
  const stageCodes = String(stage).split(',').map(s => s.trim()).filter(Boolean);
  if (stageCodes.length === 0 || stageCodes.some(code => !STAGES.find(s => s.code === code))) {
    return res.status(400).json({ error: 'unknown_stage' });
  }
  db.prepare(`
    INSERT INTO users (telegram_id, full_name, stage, is_admin)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(telegram_id) DO UPDATE SET full_name = excluded.full_name, stage = excluded.stage, is_admin = excluded.is_admin
  `).run(telegram_id, full_name, stageCodes.join(','), is_admin ? 1 : 0);
  res.json({ ok: true });
});

router.delete('/users/:telegramId', (req, res) => {
  db.prepare('DELETE FROM users WHERE telegram_id = ?').run(req.params.telegramId);
  res.json({ ok: true });
});

// --- Закрытие дня (после того как операционист перенёс данные в ИС) ---
router.get('/day-status/:date', (req, res) => {
  const row = db.prepare('SELECT * FROM closed_days WHERE entry_date = ?').get(req.params.date);
  res.json(row ? { closed: true, closed_by: row.closed_by, closed_at: row.closed_at } : { closed: false });
});

router.post('/day-status/:date/close', (req, res) => {
  const telegramId = req.header('x-telegram-id');
  db.prepare(`
    INSERT INTO closed_days (entry_date, closed_by) VALUES (?, ?)
    ON CONFLICT(entry_date) DO UPDATE SET closed_by = excluded.closed_by, closed_at = datetime('now')
  `).run(req.params.date, telegramId);
  res.json({ ok: true });
});

router.post('/day-status/:date/reopen', (req, res) => {
  db.prepare('DELETE FROM closed_days WHERE entry_date = ?').run(req.params.date);
  res.json({ ok: true });
});

// Дни, за которые есть записи, но операционист их ещё не закрыл (чек-лист "не забыть выгрузить")
router.get('/open-days', (req, res) => {
  const rows = db.prepare(`
    SELECT e.entry_date, COUNT(*) AS entries_count
    FROM entries e
    WHERE e.entry_date NOT IN (SELECT entry_date FROM closed_days)
    GROUP BY e.entry_date
    ORDER BY e.entry_date ASC
    LIMIT 60
  `).all();
  res.json(rows);
});

// --- Просмотр смены (для дашборда, без экспорта) ---
router.get('/entries', (req, res) => {
  const { date_from, date_to } = req.query;
  const from = date_from || new Date().toISOString().slice(0, 10);
  const to = date_to || from;

  const rows = db.prepare(`
    SELECT e.id, e.entry_date, e.stage, e.telegram_id, e.employee_name,
           n.name || CASE WHEN n.article IS NOT NULL THEN ' (' || n.article || ')' ELSE '' END AS nomenclature_name,
           e.quantity, e.grade, e.comment, e.created_at, 0 AS is_photo
    FROM entries e
    JOIN nomenclature n ON n.id = e.nomenclature_id
    WHERE e.entry_date BETWEEN ? AND ?
    ORDER BY e.stage, e.employee_name, e.created_at
  `).all(from, to);

  // Фото накладных (этап "Приход ТМЦ") показываем в той же ленте, но без номенклатуры/количества
  const photoRows = db.prepare(`
    SELECT id, entry_date, telegram_id, employee_name, caption, created_at
    FROM intake_photos
    WHERE entry_date BETWEEN ? AND ?
    ORDER BY employee_name, created_at
  `).all(from, to).map(p => ({
    id: p.id,
    entry_date: p.entry_date,
    stage: 'intake',
    telegram_id: p.telegram_id,
    employee_name: p.employee_name,
    nomenclature_name: null,
    quantity: null,
    grade: null,
    comment: p.caption,
    created_at: p.created_at,
    is_photo: 1,
  }));

  res.json([...rows, ...photoRows]);
});

// Удалить запись (админ может удалить любую, за любую дату — для исправления ошибок задним числом)
router.delete('/entries/:id', (req, res) => {
  const info = db.prepare('DELETE FROM entries WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true });
});

// --- Баланс по этапам (сколько зашло/вышло на каждом этапе, где расхождения) ---
router.get('/balance', (req, res) => {
  const { date_from, date_to } = req.query;
  const from = date_from || new Date().toISOString().slice(0, 10);
  const to = date_to || from;

  const rows = db.prepare(`
    SELECT n.id AS nomenclature_id,
           n.name || CASE WHEN n.article IS NOT NULL THEN ' (' || n.article || ')' ELSE '' END AS nomenclature_name,
           e.stage, e.grade, SUM(e.quantity) AS total
    FROM entries e
    JOIN nomenclature n ON n.id = e.nomenclature_id
    WHERE e.entry_date BETWEEN ? AND ?
    GROUP BY n.id, e.stage, e.grade
  `).all(from, to);

  // Собираем в структуру: nomenclature_id -> { stage -> total, stage_grades -> {grade: total} }
  const byNom = {};
  for (const r of rows) {
    if (!byNom[r.nomenclature_id]) {
      byNom[r.nomenclature_id] = { nomenclature_name: r.nomenclature_name, stageTotals: {}, stageGrades: {} };
    }
    const entry = byNom[r.nomenclature_id];
    entry.stageTotals[r.stage] = (entry.stageTotals[r.stage] || 0) + r.total;
    if (r.grade) {
      entry.stageGrades[r.stage] = entry.stageGrades[r.stage] || {};
      entry.stageGrades[r.stage][r.grade] = (entry.stageGrades[r.stage][r.grade] || 0) + r.total;
    }
  }

  // Замес меряется сырьём (кг/партии), а не штуками готовых изделий — сравнивать напрямую
  // с формовкой некорректно, поэтому в цепочку сверки берём только этапы поштучного учёта
  const BALANCE_CHAIN = ['molding', 'qc_molding', 'glazing', 'kiln', 'breakage', 'qc_final'];

  const stageCodes = STAGES.map(s => s.code);
  const result = Object.entries(byNom).map(([nomenclatureId, data]) => {
    const perStage = stageCodes.map(code => ({
      code,
      title: STAGES.find(s => s.code === code).title,
      total: data.stageTotals[code] || 0,
      grades: data.stageGrades[code] || null,
    }));

    // "Годные" на QC-этапах = всё кроме брака — нужно для сверки с соседними этапами
    const goodAt = (code) => {
      const grades = data.stageGrades[code];
      if (!grades) return data.stageTotals[code] || 0;
      return Object.entries(grades).reduce((sum, [g, q]) => sum + (g === 'brak' ? 0 : q), 0);
    };

    // Расхождения только по цепочке поштучного учёта (без замеса)
    const deltas = [];
    for (let i = 0; i < BALANCE_CHAIN.length - 1; i++) {
      const fromCode = BALANCE_CHAIN[i];
      const toCode = BALANCE_CHAIN[i + 1];
      const fromQty = goodAt(fromCode);
      const toQty = data.stageTotals[toCode] || 0;
      if ((data.stageTotals[fromCode] || 0) === 0 && toQty === 0) continue;
      deltas.push({
        from_stage: fromCode,
        to_stage: toCode,
        from_qty: fromQty,
        to_qty: toQty,
        delta: fromQty - toQty,
      });
    }

    return { nomenclature_id: Number(nomenclatureId), nomenclature_name: data.nomenclature_name, per_stage: perStage, deltas };
  });

  res.json(result);
});

// --- Номенклатура ---
router.get('/nomenclature', (req, res) => {
  const rows = db.prepare('SELECT * FROM nomenclature ORDER BY sort_order, id').all();
  res.json(rows);
});

router.post('/nomenclature', (req, res) => {
  const { name, article, unit } = req.body;
  if (!name) return res.status(400).json({ error: 'bad_request' });
  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM nomenclature').get().m;
  const info = db.prepare('INSERT INTO nomenclature (name, article, unit, sort_order) VALUES (?, ?, ?, ?)')
    .run(name, article || null, unit || 'шт', maxOrder + 1);
  res.json({ ok: true, id: info.lastInsertRowid });
});

router.put('/nomenclature/:id', (req, res) => {
  const { name, article, unit, active } = req.body;
  db.prepare('UPDATE nomenclature SET name = COALESCE(?, name), article = COALESCE(?, article), unit = COALESCE(?, unit), active = COALESCE(?, active) WHERE id = ?')
    .run(name ?? null, article ?? null, unit ?? null, active === undefined ? null : (active ? 1 : 0), req.params.id);
  res.json({ ok: true });
});

router.delete('/nomenclature/:id', (req, res) => {
  // Мягкое удаление — просто деактивируем, чтобы не терять историю по старым записям
  db.prepare('UPDATE nomenclature SET active = 0 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
