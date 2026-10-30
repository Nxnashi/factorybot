// Журнал проводок: каждая операция получает уникальный код и строку в журнале.
// Записи журнала никогда не удаляются — при удалении операции статус меняется на "cancelled",
// чтобы по коду всегда можно было найти источник ошибки.
const { db } = require('./db');
const { CODE_PREFIX } = require('./catalog');
const { nowLocal } = require('./util');

function compactDate(isoDate) {
  return String(isoDate).replace(/-/g, '');
}

// Следующий код вида FM-20261030-0007 (порядок по префиксу и дате)
function nextCode(stage, entryDate) {
  const prefix = CODE_PREFIX[stage] || 'XX';
  const base = `${prefix}-${compactDate(entryDate)}-`;
  const row = db.prepare('SELECT COUNT(*) AS c FROM postings WHERE op_code LIKE ?').get(base + '%');
  let seq = row.c + 1;
  // Страховка от коллизий (на случай ручных правок)
  while (db.prepare('SELECT 1 FROM postings WHERE op_code = ?').get(base + String(seq).padStart(4, '0'))) seq++;
  return base + String(seq).padStart(4, '0');
}

// Создать запись в журнале; возвращает код операции
function post({ stage, entryDate, telegramId, actor, enteredBy, refTable, refId, summary, qty, parentCode, kind }) {
  const code = nextCode(stage, entryDate);
  db.prepare(`
    INSERT INTO postings (op_code, parent_code, stage, kind, entry_date, telegram_id, actor_name, entered_by, ref_table, ref_id, summary, qty, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(code, parentCode || null, stage, kind || 'post', entryDate, telegramId || null, actor || null, enteredBy || null,
    refTable || null, refId || null, summary || null, qty == null ? null : qty, nowLocal());
  return code;
}

function cancelByRef(refTable, refId, cancelledBy) {
  db.prepare(`
    UPDATE postings SET status = 'cancelled', cancelled_at = ?, cancelled_by = ?
    WHERE ref_table = ? AND ref_id = ? AND status = 'posted'
  `).run(nowLocal(), cancelledBy || null, refTable, refId);
}

function updateByRef(refTable, refId, fields) {
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(fields)) { sets.push(`${k} = ?`); vals.push(v); }
  if (!sets.length) return;
  db.prepare(`UPDATE postings SET ${sets.join(', ')} WHERE ref_table = ? AND ref_id = ?`).run(...vals, refTable, refId);
}

module.exports = { nextCode, post, cancelByRef, updateByRef };
