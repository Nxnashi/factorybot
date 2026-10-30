const express = require('express');
const { db, STAGES, LEGACY_STAGES } = require('../src/db');
const { cancelByRef } = require('../src/postings');
const { describeEntry } = require('../src/describe');
const { buildMixingMatrix } = require('../src/mixing');
const { todayLocal, nowLocal } = require('../src/util');

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
  // legacy — старые этапы: в назначение не попадают, но их история видна в ленте
  res.json([...STAGES, ...LEGACY_STAGES.map(s => ({ ...s, legacy: true }))]);
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

// --- Просмотр смены (лента операций) ---
router.get('/entries', (req, res) => {
  const { date_from, date_to } = req.query;
  const from = date_from || todayLocal();
  const to = date_to || from;

  const rows = db.prepare(`
    SELECT e.*, n.name || CASE WHEN n.article IS NOT NULL THEN ' (' || n.article || ')' ELSE '' END AS nomenclature_name
    FROM entries e
    JOIN nomenclature n ON n.id = e.nomenclature_id
    WHERE e.entry_date BETWEEN ? AND ?
    ORDER BY e.stage, e.employee_name, e.created_at, e.id
  `).all(from, to).map(r => ({
    id: String(r.id), entry_date: r.entry_date, stage: r.stage, telegram_id: r.telegram_id,
    employee_name: r.employee_name, entered_by: r.entered_by, nomenclature_name: r.nomenclature_name,
    quantity: r.quantity, grade: r.grade, comment: r.comment, created_at: r.created_at, is_photo: 0,
    op_code: r.op_code, line_no: r.line_no, wagon_no: r.wagon_no, qty_total: r.qty_total, qty_defect: r.qty_defect,
    description: describeEntry(r.stage, r),
  }));

  // Старые фото накладных (этап "Приход ТМЦ" убран, история остаётся)
  const photoRows = db.prepare(`
    SELECT id, entry_date, telegram_id, employee_name, caption, created_at
    FROM intake_photos WHERE entry_date BETWEEN ? AND ? ORDER BY employee_name, created_at
  `).all(from, to).map(p => ({
    id: `photo-${p.id}`, entry_date: p.entry_date, stage: 'intake', telegram_id: p.telegram_id,
    employee_name: p.employee_name, nomenclature_name: null, quantity: null, grade: null,
    comment: p.caption, created_at: p.created_at, is_photo: 1,
  }));

  // Расход сырья по замесам
  const materialRows = db.prepare(`
    SELECT me.id, me.entry_date, me.stage, me.telegram_id, me.employee_name, me.op_code,
           CASE WHEN m.article IS NOT NULL THEN m.article || ' - ' ELSE '' END || m.name AS nomenclature_name,
           me.quantity, me.drum_number, me.comment, me.created_at, b.batch_no
    FROM material_entries me
    JOIN materials m ON m.id = me.material_id
    LEFT JOIN mixing_batches b ON b.id = me.batch_id
    WHERE me.entry_date BETWEEN ? AND ?
    ORDER BY me.stage, me.employee_name, me.created_at, me.id
  `).all(from, to).map(r => ({
    id: `material-${r.id}`, entry_date: r.entry_date, stage: r.stage, telegram_id: r.telegram_id,
    employee_name: r.employee_name, nomenclature_name: r.nomenclature_name, quantity: r.quantity, grade: null,
    drum_number: r.drum_number, batch_no: r.batch_no, comment: r.comment, created_at: r.created_at, is_photo: 0,
    op_code: r.op_code, description: `${r.quantity} кг`,
  }));

  // Сами замесы
  const batchRows = db.prepare(`
    SELECT id, entry_date, stage, telegram_id, employee_name, drum_number, batch_no, code, output_quantity, status, created_at
    FROM mixing_batches WHERE entry_date BETWEEN ? AND ? ORDER BY stage, employee_name, created_at
  `).all(from, to).map(b => ({
    id: `batch-${b.id}`, entry_date: b.entry_date, stage: b.stage, telegram_id: b.telegram_id,
    employee_name: b.employee_name,
    nomenclature_name: `🧪 Замес №${b.batch_no}, барабан ${b.drum_number} — ` +
      (b.status === 'completed' ? 'выход' : b.status === 'cancelled' ? 'отменён' : 'в процессе'),
    quantity: b.output_quantity, grade: null, drum_number: null, comment: null,
    created_at: b.created_at, is_photo: 0, op_code: b.code,
  }));

  res.json([...rows, ...photoRows, ...materialRows, ...batchRows]);
});

// Удалить запись (админ — любую, за любую дату). Запись в журнале проводок не стирается, а помечается отменённой
router.delete('/entries/:id', (req, res) => {
  const raw = req.params.id;
  let table = 'entries';
  let realId = raw;
  if (raw.startsWith('photo-')) { table = 'intake_photos'; realId = raw.replace('photo-', ''); }
  else if (raw.startsWith('material-')) { table = 'material_entries'; realId = raw.replace('material-', ''); }

  const admin = db.prepare('SELECT full_name FROM users WHERE telegram_id = ?').get(req.header('x-telegram-id'));
  const info = db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(realId);
  if (info.changes === 0) return res.status(404).json({ error: 'not_found' });
  if (table !== 'intake_photos') cancelByRef(table, Number(realId), admin ? admin.full_name : 'admin');
  res.json({ ok: true });
});

// --- Баланс по этапам ---
// На каждом этапе: "вход" (что поступило в работу), "выход" (что ушло дальше), потери.
// Расхождение между этапами = выход предыдущего − вход следующего.
const BALANCE_CHAIN = ['molding', 'fettling', 'glazing', 'kiln', 'sorting', 'finished'];

router.get('/balance', (req, res) => {
  const { date_from, date_to } = req.query;
  const from = date_from || todayLocal();
  const to = date_to || from;

  const rows = db.prepare(`
    SELECT n.id AS nomenclature_id,
           n.name || CASE WHEN n.article IS NOT NULL THEN ' (' || n.article || ')' ELSE '' END AS nomenclature_name,
           e.stage, e.grade,
           SUM(e.quantity) AS out_qty, SUM(e.qty_total) AS total_qty, SUM(e.qty_defect) AS defect_qty,
           SUM(e.qty_repair) AS repair_qty
    FROM entries e
    JOIN nomenclature n ON n.id = e.nomenclature_id
    WHERE e.entry_date BETWEEN ? AND ? AND e.stage IN (${BALANCE_CHAIN.map(() => '?').join(',')})
    GROUP BY n.id, e.stage, e.grade
  `).all(from, to, ...BALANCE_CHAIN);

  const byNom = {};
  let returnedToClay = 0;
  for (const r of rows) {
    const nom = byNom[r.nomenclature_id] || (byNom[r.nomenclature_id] = { name: r.nomenclature_name, stages: {} });
    const st = nom.stages[r.stage] || (nom.stages[r.stage] = { in: 0, out: 0, defect: 0, repair: 0, grades: {} });
    st.out += r.out_qty || 0;
    st.in += (r.total_qty != null ? r.total_qty : (r.out_qty || 0));
    st.defect += r.defect_qty || 0;
    st.repair += r.repair_qty || 0;
    if (r.grade) st.grades[r.grade] = (st.grades[r.grade] || 0) + (r.out_qty || 0);
    if (r.stage === 'molding') returnedToClay += r.defect_qty || 0;
  }

  const items = Object.entries(byNom).map(([id, nom]) => {
    const per_stage = BALANCE_CHAIN.map(code => {
      const st = nom.stages[code];
      return {
        code, title: STAGES.find(s => s.code === code).title,
        in: st ? st.in : 0, out: st ? st.out : 0, defect: st ? st.defect : 0, repair: st ? st.repair : 0,
        grades: st && Object.keys(st.grades).length ? st.grades : null,
      };
    });
    const deltas = [];
    for (let i = 0; i < BALANCE_CHAIN.length - 1; i++) {
      const a = per_stage[i], b = per_stage[i + 1];
      if (a.out === 0 && b.in === 0) continue;
      deltas.push({ from_stage: a.code, to_stage: b.code, from_qty: a.out, to_qty: b.in, delta: a.out - b.in });
    }
    return { nomenclature_id: Number(id), nomenclature_name: nom.name, per_stage, deltas };
  });

  res.json({ items, returned_to_clay: returnedToClay });
});

// --- Матрица замесов (как в 1С: Замес 1..N + Сумма) ---
router.get('/mixing-matrix', (req, res) => {
  const { stage, date_from, date_to } = req.query;
  if (!['clay_mixing', 'glaze_mixing'].includes(stage)) return res.status(400).json({ error: 'bad_stage' });
  const from = date_from || todayLocal();
  res.json(buildMixingMatrix(stage, from, date_to || from));
});

// --- Журнал проводок ---
router.get('/postings', (req, res) => {
  const { date_from, date_to, stage, q, status } = req.query;
  const from = date_from || todayLocal();
  const to = date_to || from;
  const where = ['entry_date BETWEEN ? AND ?'];
  const params = [from, to];
  if (stage) { where.push('stage = ?'); params.push(stage); }
  if (status) { where.push('status = ?'); params.push(status); }
  if (q) {
    where.push('(op_code LIKE ? OR parent_code LIKE ? OR summary LIKE ? OR actor_name LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like, like);
  }
  const rows = db.prepare(`SELECT * FROM postings WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT 2000`).all(...params);
  res.json(rows);
});

// --- Справочники-заготовки (комплекты ГП, все ТМЦ, п/ф): структура есть, данные зальём позже ---
router.get('/catalogs', (req, res) => {
  const kits = db.prepare('SELECT * FROM kits ORDER BY id').all().map(k => ({
    ...k,
    items: db.prepare('SELECT * FROM kit_items WHERE kit_id = ?').all(k.id),
  }));
  res.json({
    tmc: db.prepare('SELECT * FROM tmc_catalog ORDER BY id').all(),
    semi_products: db.prepare('SELECT * FROM semi_products ORDER BY id').all(),
    kits,
  });
});

// --- Замесы (батчи) — на случай если рабочий забыл завершить и барабан "зависает" ---
router.get('/mixing-batches', (req, res) => {
  const { status } = req.query;
  const rows = status
    ? db.prepare('SELECT * FROM mixing_batches WHERE status = ? ORDER BY created_at DESC').all(status)
    : db.prepare('SELECT * FROM mixing_batches ORDER BY created_at DESC LIMIT 100').all();
  res.json(rows);
});

router.post('/mixing-batches/:id/cancel', (req, res) => {
  const batch = db.prepare("SELECT * FROM mixing_batches WHERE id = ? AND status = 'in_progress'").get(req.params.id);
  if (!batch) return res.status(404).json({ error: 'not_found_or_not_in_progress' });
  const admin = db.prepare('SELECT full_name FROM users WHERE telegram_id = ?').get(req.header('x-telegram-id'));
  const by = admin ? admin.full_name : 'admin';
  db.transaction(() => {
    db.prepare("UPDATE mixing_batches SET status = 'cancelled' WHERE id = ?").run(batch.id);
    cancelByRef('mixing_batches', batch.id, by);
    // списания сырья этого замеса тоже отменяем
    const lines = db.prepare('SELECT id FROM material_entries WHERE batch_id = ?').all(batch.id);
    for (const l of lines) cancelByRef('material_entries', l.id, by);
  })();
  res.json({ ok: true });
});

// --- Ростер сотрудников по этапам (не имеют доступа в бот — вносит за них старший) ---
router.get('/employees', (req, res) => {
  const { stage } = req.query;
  const rows = stage
    ? db.prepare('SELECT * FROM employees WHERE stage = ? ORDER BY full_name').all(stage)
    : db.prepare('SELECT * FROM employees ORDER BY stage, full_name').all();
  res.json(rows);
});

router.post('/employees', (req, res) => {
  const { full_name, stage } = req.body;
  if (!full_name || !stage) return res.status(400).json({ error: 'bad_request' });
  if (!STAGES.find(s => s.code === stage)) return res.status(400).json({ error: 'unknown_stage' });
  const info = db.prepare('INSERT INTO employees (full_name, stage) VALUES (?, ?)').run(full_name, stage);
  res.json({ ok: true, id: info.lastInsertRowid });
});

router.put('/employees/:id', (req, res) => {
  const { full_name, active } = req.body;
  db.prepare('UPDATE employees SET full_name = COALESCE(?, full_name), active = COALESCE(?, active) WHERE id = ?')
    .run(full_name ?? null, active === undefined ? null : (active ? 1 : 0), req.params.id);
  res.json({ ok: true });
});

router.delete('/employees/:id', (req, res) => {
  db.prepare('UPDATE employees SET active = 0 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// --- Смены старших — оверсайт на случай если кто-то забыл закрыть смену ---
router.get('/shifts', (req, res) => {
  const { status, date_from, date_to } = req.query;
  const from = date_from || todayLocal();
  const to = date_to || from;
  const rows = status
    ? db.prepare('SELECT * FROM foreman_shifts WHERE status = ? AND entry_date BETWEEN ? AND ? ORDER BY opened_at DESC').all(status, from, to)
    : db.prepare('SELECT * FROM foreman_shifts WHERE entry_date BETWEEN ? AND ? ORDER BY opened_at DESC').all(from, to);
  res.json(rows);
});

router.post('/shifts/:id/force-close', (req, res) => {
  const info = db.prepare("UPDATE foreman_shifts SET status = 'closed', closed_at = datetime('now') WHERE id = ? AND status = 'open'").run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'not_found_or_not_open' });
  res.json({ ok: true });
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

// --- Сырьё (ТМЦ) для замесов: список СТАТИЧНЫЙ (src/catalog.js), через админку только просмотр ---
router.get('/materials', (req, res) => {
  res.json(db.prepare('SELECT * FROM materials WHERE active = 1 ORDER BY category, sort_order, id').all());
});

router.post('/materials', (req, res) => res.status(403).json({ error: 'static_list' }));
router.put('/materials/:id', (req, res) => res.status(403).json({ error: 'static_list' }));

module.exports = router;
