const express = require('express');
const { db, STAGES, ROSTER_STAGES } = require('../src/db');
const { DRUMS } = require('../src/catalog');
const { post, cancelByRef, updateByRef } = require('../src/postings');
const { describeEntry } = require('../src/describe');
const { todayLocal, nowLocal } = require('../src/util');

const router = express.Router();

function getStageMeta(code) {
  return STAGES.find(s => s.code === code);
}

function parseStages(stageField) {
  return String(stageField).split(',').map(s => s.trim()).filter(Boolean);
}

function isDayClosed(date) {
  return !!db.prepare('SELECT 1 FROM closed_days WHERE entry_date = ?').get(date);
}

// Кто я и какие у меня этапы (может быть несколько)
router.get('/me/:telegramId', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(req.params.telegramId);
  if (!user) return res.status(404).json({ error: 'not_registered' });

  const stages = parseStages(user.stage).map(code => getStageMeta(code)).filter(Boolean).map(meta => ({
    code: meta.code,
    title: meta.title,
    form_type: meta.formType,
    header: meta.header || null,
    fields: meta.fields || null,
    hint: meta.hint || null,
    description: meta.description || null,
    grade_options: meta.gradeOptions || null,
    is_roster_stage: ROSTER_STAGES.includes(meta.code),
    drums: DRUMS[meta.code] || null,
  }));

  res.json({ telegram_id: user.telegram_id, full_name: user.full_name, is_admin: !!user.is_admin, stages });
});

// --- Замес как единица работы: сырьё + обязательный выход. За день замесов может быть много ---

// Замесы за сегодня по этапу (для экрана выбора барабана)
router.get('/mixing-batch/today', (req, res) => {
  const { stage, entry_date } = req.query;
  if (!stage) return res.status(400).json({ error: 'bad_request' });
  const rows = db.prepare(`
    SELECT id, drum_number, batch_no, code, status, output_quantity, created_at, employee_name, telegram_id
    FROM mixing_batches
    WHERE stage = ? AND entry_date = ? AND status != 'cancelled'
    ORDER BY drum_number, batch_no
  `).all(stage, entry_date || todayLocal());
  res.json(rows);
});

// Начать замес или вернуться к уже открытому (этап+барабан+сотрудник) — прогресс не теряется при сворачивании
router.post('/mixing-batch/start', (req, res) => {
  const { telegram_id, entry_date, stage, drum_number } = req.body;
  if (!telegram_id || !entry_date || !stage || !drum_number) return res.status(400).json({ error: 'bad_request' });
  if (!DRUMS[stage]) return res.status(400).json({ error: 'bad_stage' });
  if (!DRUMS[stage].includes(Number(drum_number))) return res.status(400).json({ error: 'bad_drum' });

  const user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegram_id);
  if (!user) return res.status(404).json({ error: 'not_registered' });
  if (!parseStages(user.stage).includes(stage)) return res.status(403).json({ error: 'stage_not_allowed' });
  if (isDayClosed(entry_date)) return res.status(403).json({ error: 'day_closed' });

  let batch = db.prepare(`
    SELECT * FROM mixing_batches
    WHERE telegram_id = ? AND stage = ? AND drum_number = ? AND status = 'in_progress'
    ORDER BY id DESC LIMIT 1
  `).get(telegram_id, stage, drum_number);

  if (!batch) {
    const tx = db.transaction(() => {
      const batchNo = db.prepare(`
        SELECT COUNT(*) AS c FROM mixing_batches WHERE entry_date = ? AND stage = ? AND drum_number = ? AND status != 'cancelled'
      `).get(entry_date, stage, drum_number).c + 1;
      const info = db.prepare(`
        INSERT INTO mixing_batches (entry_date, stage, telegram_id, employee_name, drum_number, batch_no, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(entry_date, stage, user.telegram_id, user.full_name, drum_number, batchNo, nowLocal());
      const id = info.lastInsertRowid;
      const code = post({
        stage, entryDate: entry_date, telegramId: user.telegram_id, actor: user.full_name,
        refTable: 'mixing_batches', refId: id, kind: 'batch',
        summary: `Замес №${batchNo}, барабан ${drum_number} (в процессе)`,
      });
      db.prepare('UPDATE mixing_batches SET code = ? WHERE id = ?').run(code, id);
      return id;
    });
    batch = db.prepare('SELECT * FROM mixing_batches WHERE id = ?').get(tx());
  }

  const materials = db.prepare(`
    SELECT me.id, me.quantity, me.created_at, me.op_code,
           CASE WHEN m.article IS NOT NULL THEN m.article || ' - ' ELSE '' END || m.name AS material_name
    FROM material_entries me
    JOIN materials m ON m.id = me.material_id
    WHERE me.batch_id = ?
    ORDER BY me.created_at, me.id
  `).all(batch.id);

  res.json({ batch, materials });
});

// Добавить сырьё в открытый замес (можно несколько раз подряд)
router.post('/mixing-batch/add-materials', (req, res) => {
  const { batch_id, telegram_id, items } = req.body;
  if (!batch_id || !telegram_id || !Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'bad_request' });

  const batch = db.prepare('SELECT * FROM mixing_batches WHERE id = ?').get(batch_id);
  if (!batch) return res.status(404).json({ error: 'not_found' });
  if (batch.telegram_id !== String(telegram_id)) return res.status(403).json({ error: 'not_yours' });
  if (batch.status !== 'in_progress') return res.status(403).json({ error: 'batch_closed' });
  if (isDayClosed(batch.entry_date)) return res.status(403).json({ error: 'day_closed' });

  const valid = items.filter(it => Number(it.quantity) > 0 && it.material_id);
  if (valid.length === 0) return res.status(400).json({ error: 'no_valid_items' });

  const insert = db.prepare(`
    INSERT INTO material_entries (entry_date, stage, telegram_id, employee_name, material_id, quantity, drum_number, batch_id, comment, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const tx = db.transaction(() => {
    for (const it of valid) {
      const mat = db.prepare('SELECT * FROM materials WHERE id = ? AND category = ? AND active = 1 AND deleted = 0').get(it.material_id, batch.stage);
      if (!mat) throw new Error('bad_material');
      const info = insert.run(batch.entry_date, batch.stage, batch.telegram_id, batch.employee_name, mat.id,
        Number(it.quantity), batch.drum_number, batch.id, it.comment || null, nowLocal());
      const code = post({
        stage: batch.stage, entryDate: batch.entry_date, telegramId: batch.telegram_id, actor: batch.employee_name,
        refTable: 'material_entries', refId: info.lastInsertRowid, kind: 'material', parentCode: batch.code,
        summary: `Списание: ${mat.article ? mat.article + ' - ' : ''}${mat.name} → замес №${batch.batch_no}, барабан ${batch.drum_number}`,
        qty: Number(it.quantity),
      });
      db.prepare('UPDATE material_entries SET op_code = ? WHERE id = ?').run(code, info.lastInsertRowid);
    }
  });
  try { tx(); } catch (e) {
    if (e.message === 'bad_material') return res.status(400).json({ error: 'bad_material' });
    throw e;
  }
  res.json({ ok: true, saved: valid.length });
});

// Завершить замес — указать фактический выход
router.post('/mixing-batch/complete', (req, res) => {
  const { batch_id, telegram_id, output_quantity } = req.body;
  if (!batch_id || !telegram_id) return res.status(400).json({ error: 'bad_request' });

  const batch = db.prepare('SELECT * FROM mixing_batches WHERE id = ?').get(batch_id);
  if (!batch) return res.status(404).json({ error: 'not_found' });
  if (batch.telegram_id !== String(telegram_id)) return res.status(403).json({ error: 'not_yours' });
  if (batch.status !== 'in_progress') return res.status(403).json({ error: 'batch_closed' });
  if (isDayClosed(batch.entry_date)) return res.status(403).json({ error: 'day_closed' });

  const agg = db.prepare('SELECT COUNT(*) AS c, COALESCE(SUM(quantity), 0) AS total FROM material_entries WHERE batch_id = ?').get(batch_id);
  if (agg.c === 0) return res.status(400).json({ error: 'no_materials' });

  // Итого вес замеса считается автоматически (сумма сырья); можно передать output_quantity, чтобы исправить вручную
  const calc = agg.total;
  const hasManual = output_quantity !== undefined && output_quantity !== null && output_quantity !== '';
  const out = hasManual ? Number(output_quantity) : calc;
  if (!(out > 0)) return res.status(400).json({ error: 'bad_request' });
  db.transaction(() => {
    db.prepare("UPDATE mixing_batches SET output_quantity = ?, calc_quantity = ?, status = 'completed', completed_at = ? WHERE id = ?").run(out, calc, nowLocal(), batch_id);
    updateByRef('mixing_batches', batch_id, {
      summary: `Замес №${batch.batch_no}, барабан ${batch.drum_number}: вес ${out} кг` + (out !== calc ? ` (исправлено вручную, авто ${calc})` : ''),
      qty: out,
    });
  })();
  res.json({ ok: true, code: batch.code, total: out, auto: calc });
});

// Активная номенклатура для формы
router.get('/nomenclature', (req, res) => {
  res.json(db.prepare('SELECT id, name, article, unit FROM nomenclature WHERE active = 1 AND deleted = 0 ORDER BY sort_order, id').all());
});

// Статичный список сырья для замеса (clay_mixing / glaze_mixing)
router.get('/materials', (req, res) => {
  const { stage } = req.query;
  if (!stage) return res.status(400).json({ error: 'bad_request' });
  res.json(db.prepare('SELECT id, name, article, unit FROM materials WHERE category = ? AND active = 1 AND deleted = 0 ORDER BY sort_order, id').all(stage));
});

// --- Ростер и смена старшего (для этапов из ROSTER_STAGES) ---

router.get('/roster', (req, res) => {
  const { stage } = req.query;
  if (!stage) return res.status(400).json({ error: 'bad_request' });
  res.json(db.prepare('SELECT id, full_name FROM employees WHERE stage = ? AND active = 1 AND deleted = 0 ORDER BY full_name').all(stage));
});

router.get('/shift-status', (req, res) => {
  const { telegram_id, stage, entry_date } = req.query;
  if (!telegram_id || !stage || !entry_date) return res.status(400).json({ error: 'bad_request' });

  const shift = db.prepare(`
    SELECT * FROM foreman_shifts WHERE telegram_id = ? AND stage = ? AND entry_date = ? ORDER BY id DESC LIMIT 1
  `).get(telegram_id, stage, entry_date);
  if (!shift) return res.json({ shift: null, employees: [] });

  const employeeIds = shift.employee_ids.split(',').map(Number);
  const employees = employeeIds.length > 0
    ? db.prepare(`SELECT id, full_name FROM employees WHERE id IN (${employeeIds.map(() => '?').join(',')})`).all(...employeeIds)
    : [];
  res.json({ shift, employees });
});

router.post('/shift/open', (req, res) => {
  const { telegram_id, entry_date, stage, employee_ids } = req.body;
  if (!telegram_id || !entry_date || !stage || !Array.isArray(employee_ids) || employee_ids.length === 0) {
    return res.status(400).json({ error: 'bad_request' });
  }
  if (!ROSTER_STAGES.includes(stage)) return res.status(400).json({ error: 'bad_stage' });

  const user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegram_id);
  if (!user) return res.status(404).json({ error: 'not_registered' });
  if (!parseStages(user.stage).includes(stage)) return res.status(403).json({ error: 'stage_not_allowed' });
  if (isDayClosed(entry_date)) return res.status(403).json({ error: 'day_closed' });

  const existingOpen = db.prepare(`
    SELECT * FROM foreman_shifts WHERE telegram_id = ? AND stage = ? AND entry_date = ? AND status = 'open'
  `).get(telegram_id, stage, entry_date);
  if (existingOpen) return res.status(409).json({ error: 'already_open', shift: existingOpen });

  const info = db.prepare('INSERT INTO foreman_shifts (telegram_id, stage, entry_date, employee_ids, opened_at) VALUES (?, ?, ?, ?, ?)')
    .run(telegram_id, stage, entry_date, employee_ids.join(','), nowLocal());
  res.json({ ok: true, shift: db.prepare('SELECT * FROM foreman_shifts WHERE id = ?').get(info.lastInsertRowid) });
});

router.post('/shift/close', (req, res) => {
  const { telegram_id, shift_id } = req.body;
  if (!telegram_id || !shift_id) return res.status(400).json({ error: 'bad_request' });

  const shift = db.prepare('SELECT * FROM foreman_shifts WHERE id = ?').get(shift_id);
  if (!shift) return res.status(404).json({ error: 'not_found' });
  if (shift.telegram_id !== String(telegram_id)) return res.status(403).json({ error: 'not_yours' });
  if (shift.status !== 'open') return res.status(403).json({ error: 'already_closed' });

  db.prepare("UPDATE foreman_shifts SET status = 'closed', closed_at = ? WHERE id = ?").run(nowLocal(), shift_id);
  res.json({ ok: true });
});

// --- Приём документов по этапам ---

const num = v => (v === undefined || v === null || v === '' ? 0 : Number(v));

// Превращает введённые рабочим значения в строку entries по правилу этапа.
// Возвращает { row } или { skip: true } (ничего не введено) или { error }.
function buildRow(meta, item, header) {
  const v = item.values || {};
  const row = {
    line_no: null, wagon_no: null, qty_total: null, qty_defect: null,
    qty_repair: null, qty_s1: null, qty_s2: null, quantity: 0, grade: null,
  };
  const bad = (msg) => ({ error: 'invalid_values', message: msg });
  const vals = Object.values(v).map(num);
  if (vals.some(x => !Number.isFinite(x) || x < 0)) return bad('Числа не могут быть отрицательными');

  switch (meta.rule) {
    case 'molding': {
      const total = num(v.qty_total);
      const good = num(v.quantity);
      if (total === 0 && good === 0) return { skip: true };
      if (total <= 0) return bad('Укажи сколько залито');
      if (good > total) return bad('Годных не может быть больше, чем залито');
      row.line_no = Number(header.line_no);
      row.qty_total = total;
      row.quantity = good;
      row.qty_defect = total - good; // автоматически возвращается в глину
      break;
    }
    case 'total_defect': {
      const total = num(v.qty_total);
      const defect = num(v.qty_defect);
      if (total === 0 && defect === 0) return { skip: true };
      if (total <= 0) return bad('Укажи общее количество');
      if (defect > total) return bad('Брак не может быть больше общего количества');
      row.qty_total = total;
      row.qty_defect = defect;
      row.quantity = total - defect;
      break;
    }
    case 'sorting': {
      const s1 = num(v.qty_s1), s2 = num(v.qty_s2), rep = num(v.qty_repair), def = num(v.qty_defect);
      if (s1 + s2 + rep + def === 0) return { skip: true };
      row.qty_s1 = s1; row.qty_s2 = s2; row.qty_repair = rep; row.qty_defect = def;
      row.qty_total = s1 + s2 + rep + def;
      row.quantity = s1 + s2;
      break;
    }
    case 'simple': {
      const q = num(v.quantity);
      if (q === 0) return { skip: true };
      row.quantity = q;
      if (meta.header && meta.header.key === 'wagon_no') row.wagon_no = Number(header.wagon_no);
      if (meta.needsGrade) {
        if (!meta.gradeOptions.some(g => g.code === item.grade)) return bad('Не выбран сорт');
        row.grade = item.grade;
      }
      break;
    }
    default:
      return bad('Неизвестный этап');
  }
  return { row };
}

// body: { telegram_id, entry_date, stage, employee_id, header: {line_no|wagon_no}, items: [{ nomenclature_id, values:{...}, grade?, comment? }] }
// Для этапов из ROSTER_STAGES employee_id обязателен и должен быть в открытой смене старшего
router.post('/submit', (req, res) => {
  const { telegram_id, entry_date, stage, employee_id, items } = req.body;
  const header = req.body.header || {};

  if (!telegram_id || !entry_date || !stage || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'bad_request' });
  }
  const meta = getStageMeta(stage);
  if (!meta || meta.formType !== 'doc') return res.status(400).json({ error: 'bad_stage' });

  const user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegram_id);
  if (!user) return res.status(404).json({ error: 'not_registered' });
  if (isDayClosed(entry_date)) return res.status(403).json({ error: 'day_closed' });
  if (!parseStages(user.stage).includes(stage)) return res.status(403).json({ error: 'stage_not_allowed' });

  if (meta.header) {
    const h = Number(header[meta.header.key]);
    if (!Number.isInteger(h) || h < 1) return res.status(400).json({ error: 'header_required', message: `Укажи: ${meta.header.label}` });
    header[meta.header.key] = h;
  }

  let employeeName = user.full_name;
  let enteredBy = null;
  let resolvedEmployeeId = null;

  if (ROSTER_STAGES.includes(stage)) {
    if (!employee_id) return res.status(400).json({ error: 'employee_required' });
    const shift = db.prepare(`
      SELECT * FROM foreman_shifts WHERE telegram_id = ? AND stage = ? AND entry_date = ? AND status = 'open'
      ORDER BY id DESC LIMIT 1
    `).get(telegram_id, stage, entry_date);
    if (!shift) return res.status(403).json({ error: 'shift_not_open' });
    if (!shift.employee_ids.split(',').map(Number).includes(Number(employee_id))) {
      return res.status(403).json({ error: 'employee_not_in_shift' });
    }
    const employee = db.prepare('SELECT * FROM employees WHERE id = ?').get(employee_id);
    if (!employee) return res.status(404).json({ error: 'employee_not_found' });
    employeeName = employee.full_name;
    enteredBy = user.full_name;
    resolvedEmployeeId = employee.id;
  }

  // Сначала проверяем все строки, потом пишем всё одной транзакцией
  const built = [];
  for (const item of items) {
    const nom = db.prepare('SELECT * FROM nomenclature WHERE id = ?').get(item.nomenclature_id);
    if (!nom) return res.status(400).json({ error: 'bad_nomenclature' });
    const r = buildRow(meta, item, header);
    if (r.error) return res.status(400).json({ error: r.error, message: `${nom.name}: ${r.message}` });
    if (r.skip) continue;
    built.push({ nom, row: r.row, comment: item.comment || null });
  }
  if (built.length === 0) return res.status(400).json({ error: 'no_valid_items' });

  const insert = db.prepare(`
    INSERT INTO entries (entry_date, stage, telegram_id, employee_name, employee_id, entered_by, nomenclature_id,
                         quantity, grade, comment, line_no, wagon_no, qty_total, qty_defect, qty_repair, qty_s1, qty_s2, created_at)
    VALUES (@entry_date, @stage, @telegram_id, @employee_name, @employee_id, @entered_by, @nomenclature_id,
            @quantity, @grade, @comment, @line_no, @wagon_no, @qty_total, @qty_defect, @qty_repair, @qty_s1, @qty_s2, @created_at)
  `);
  const codes = [];
  db.transaction(() => {
    for (const b of built) {
      const info = insert.run({
        entry_date, stage, telegram_id: user.telegram_id, employee_name: employeeName,
        employee_id: resolvedEmployeeId, entered_by: enteredBy, nomenclature_id: b.nom.id,
        comment: b.comment, created_at: nowLocal(), ...b.row,
      });
      const code = post({
        stage, entryDate: entry_date, telegramId: user.telegram_id, actor: employeeName, enteredBy,
        refTable: 'entries', refId: info.lastInsertRowid, kind: 'post', qty: b.row.quantity,
        summary: `${b.nom.name}${b.nom.article ? ' (' + b.nom.article + ')' : ''} — ${describeEntry(stage, b.row)}`,
      });
      db.prepare('UPDATE entries SET op_code = ? WHERE id = ?').run(code, info.lastInsertRowid);
      codes.push(code);
    }
  })();

  res.json({ ok: true, saved: built.length, codes });
});

// Удалить свою запись (только за сегодня). id с префиксом "material-<id>" — расход сырья
router.delete('/entries/:id', (req, res) => {
  const { telegram_id } = req.query;
  const { id } = req.params;
  if (!telegram_id) return res.status(400).json({ error: 'bad_request' });

  const isMaterial = id.startsWith('material-');
  const table = isMaterial ? 'material_entries' : 'entries';
  const realId = isMaterial ? id.replace('material-', '') : id;
  const entry = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(realId);

  if (!entry) return res.status(404).json({ error: 'not_found' });
  if (entry.telegram_id !== String(telegram_id)) return res.status(403).json({ error: 'not_yours' });
  if (entry.entry_date !== todayLocal()) return res.status(403).json({ error: 'not_today' });
  if (isDayClosed(entry.entry_date)) return res.status(403).json({ error: 'day_closed' });
  if (isMaterial && entry.batch_id) {
    const b = db.prepare('SELECT status FROM mixing_batches WHERE id = ?').get(entry.batch_id);
    if (b && b.status === 'completed') return res.status(403).json({ error: 'batch_closed' });
  }

  const who = db.prepare('SELECT full_name FROM users WHERE telegram_id = ?').get(telegram_id);
  db.transaction(() => {
    db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(realId);
    cancelByRef(table, Number(realId), who ? who.full_name : String(telegram_id));
  })();
  res.json({ ok: true });
});

// Внесено сегодня этим пользователем (документы + расход сырья)
router.get('/today/:telegramId', (req, res) => {
  const today = todayLocal();

  const rows = db.prepare(`
    SELECT e.*, n.name AS nomenclature_name
    FROM entries e
    JOIN nomenclature n ON n.id = e.nomenclature_id
    WHERE e.telegram_id = ? AND e.entry_date = ?
    ORDER BY e.created_at DESC, e.id DESC
  `).all(req.params.telegramId, today).map(r => ({
    id: String(r.id), stage: r.stage, employee_name: r.employee_name, quantity: r.quantity,
    nomenclature_name: r.nomenclature_name, description: describeEntry(r.stage, r),
    op_code: r.op_code, created_at: r.created_at,
  }));

  const materialRows = db.prepare(`
    SELECT me.id, me.stage, me.quantity, me.drum_number, me.created_at, me.op_code,
           CASE WHEN m.article IS NOT NULL THEN m.article || ' - ' ELSE '' END || m.name AS nomenclature_name
    FROM material_entries me
    JOIN materials m ON m.id = me.material_id
    WHERE me.telegram_id = ? AND me.entry_date = ?
    ORDER BY me.created_at DESC, me.id DESC
  `).all(req.params.telegramId, today).map(r => ({
    id: `material-${r.id}`, stage: r.stage, employee_name: null, quantity: r.quantity,
    nomenclature_name: r.nomenclature_name, description: `${r.quantity} кг, барабан ${r.drum_number}`,
    op_code: r.op_code, created_at: r.created_at,
  }));

  const all = [...rows, ...materialRows].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  res.json(all.map(r => ({ ...r, stage_title: (getStageMeta(r.stage) || {}).title || r.stage })));
});

module.exports = router;
