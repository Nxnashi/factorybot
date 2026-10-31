// Матрица замесов как в документе 1С: строки — сырьё, колонки — Замес 1..N по барабану + Сумма
const { db } = require('./db');

function buildMixingMatrix(stage, from, to) {
  const materials = db.prepare('SELECT id, name, article FROM materials WHERE category = ? ORDER BY sort_order, id').all(stage);
  const batches = db.prepare(`
    SELECT * FROM mixing_batches
    WHERE stage = ? AND entry_date BETWEEN ? AND ? AND status != 'cancelled'
    ORDER BY entry_date, drum_number, batch_no, id
  `).all(stage, from, to);

  const lines = db.prepare(`
    SELECT batch_id, material_id, SUM(quantity) AS qty
    FROM material_entries WHERE batch_id IN (SELECT id FROM mixing_batches WHERE stage = ? AND entry_date BETWEEN ? AND ? AND status != 'cancelled')
    GROUP BY batch_id, material_id
  `).all(stage, from, to);
  const qtyBy = {};
  for (const l of lines) qtyBy[`${l.batch_id}|${l.material_id}`] = l.qty;

  // Группа = дата + барабан
  const groups = [];
  const index = {};
  for (const b of batches) {
    const key = `${b.entry_date}|${b.drum_number}`;
    if (!index[key]) {
      index[key] = { entry_date: b.entry_date, drum_number: b.drum_number, batches: [] };
      groups.push(index[key]);
    }
    index[key].batches.push(b);
  }

  // Материалы, которые встречались в замесах, но уже скрыты из каталога (история) — добавляем в конец
  const known = new Set(materials.map(m => m.id));
  const extraIds = lines.map(l => l.material_id).filter(id => !known.has(id));
  const extra = extraIds.length
    ? db.prepare(`SELECT id, name, article FROM materials WHERE id IN (${[...new Set(extraIds)].map(() => '?').join(',')})`).all(...new Set(extraIds))
    : [];
  const allMaterials = [...materials, ...extra];

  return groups.map(g => {
    const cols = g.batches.map(b => ({
      id: b.id, batch_no: b.batch_no, code: b.code, status: b.status,
      time: (b.created_at || '').slice(11, 16), employee_name: b.employee_name,
      output_quantity: b.output_quantity, calc_quantity: b.calc_quantity,
    }));
    const rows = allMaterials.map(m => {
      const values = g.batches.map(b => qtyBy[`${b.id}|${m.id}`] || 0);
      return { material_id: m.id, article: m.article, name: m.name, values, sum: values.reduce((a, v) => a + v, 0) };
    });
    const totals = g.batches.map((b, i) => rows.reduce((a, r) => a + r.values[i], 0));
    return {
      entry_date: g.entry_date, drum_number: g.drum_number, batches: cols, rows,
      totals, totals_sum: totals.reduce((a, v) => a + v, 0),
      output_sum: cols.reduce((a, c) => a + (c.output_quantity || 0), 0),
    };
  });
}

module.exports = { buildMixingMatrix };
