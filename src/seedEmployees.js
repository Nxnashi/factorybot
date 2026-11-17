// Загрузка списков сотрудников по цехам (src/data/employees.json).
// Не дублирует (ФИО+цех), удалённых/скрытых не возвращает. Ошибка чтения файла сервер не роняет.
const fs = require('fs');
const path = require('path');
const { db } = require('./db');

function load() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'employees.json'), 'utf8'));
}

function seedEmployees() {
  const list = load();
  const exists = db.prepare('SELECT id FROM employees WHERE full_name = ? AND stage = ?');
  const ins = db.prepare('INSERT INTO employees (full_name, stage, tab_no, mark) VALUES (?, ?, ?, ?)');
  const setTab = db.prepare('UPDATE employees SET tab_no = COALESCE(tab_no, ?), mark = COALESCE(mark, ?) WHERE id = ?');
  let added = 0, existing = 0;
  db.transaction(() => {
    for (const e of list) {
      const found = exists.get(e.full_name, e.stage);
      if (found) { setTab.run(e.tab_no, e.mark, found.id); existing++; }
      else { ins.run(e.full_name, e.stage, e.tab_no, e.mark); added++; }
    }
  })();
  return { added, existing, total: list.length };
}

// Один раз при старте
function runOnce() {
  try {
    if (db.prepare("SELECT 1 FROM app_meta WHERE key = 'seed_employees_v2'").get()) return;
    const r = seedEmployees();
    db.prepare("INSERT INTO app_meta (key, value) VALUES ('seed_employees_v2', datetime('now'))").run();
    console.log(`Сотрудники загружены: добавлено ${r.added}, уже были ${r.existing}`);
  } catch (e) {
    console.error('Не удалось загрузить список сотрудников:', e.message);
  }
}

module.exports = { seedEmployees, runOnce };
