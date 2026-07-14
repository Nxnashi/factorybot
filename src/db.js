const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, '..', 'factory.db'));
db.pragma('journal_mode = WAL');

// Этапы производства (фиксированный список, порядок важен для отчёта)
const STAGES = [
  { code: 'intake', title: 'Приход ТМЦ', needsGrade: false },
  { code: 'mixing', title: 'Зона замеса', needsGrade: false },
  { code: 'molding', title: 'Формовка', needsGrade: false },
  { code: 'qc_molding', title: 'QC после формовки', needsGrade: true },
  { code: 'kiln', title: 'Загрузка в печь', needsGrade: false },
  { code: 'qc_final', title: 'Учёт готовой продукции (финальный QC)', needsGrade: true },
];

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  telegram_id TEXT PRIMARY KEY,
  full_name   TEXT NOT NULL,
  stage       TEXT NOT NULL,
  is_admin    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS nomenclature (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  unit       TEXT NOT NULL DEFAULT 'шт',
  active     INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS entries (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_date      TEXT NOT NULL,        -- YYYY-MM-DD
  stage           TEXT NOT NULL,
  telegram_id     TEXT NOT NULL,
  employee_name   TEXT NOT NULL,
  nomenclature_id INTEGER NOT NULL,
  quantity        REAL NOT NULL,
  grade           TEXT,                 -- '1','2','3','brak' или NULL
  comment         TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (nomenclature_id) REFERENCES nomenclature(id)
);

CREATE INDEX IF NOT EXISTS idx_entries_date_stage ON entries(entry_date, stage);
`);

// Бутстрап первого администратора из переменной окружения (один раз, если его ещё нет)
if (process.env.ADMIN_TELEGRAM_ID) {
  const existingAdmin = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(process.env.ADMIN_TELEGRAM_ID);
  if (!existingAdmin) {
    db.prepare('INSERT INTO users (telegram_id, full_name, stage, is_admin) VALUES (?, ?, ?, 1)')
      .run(process.env.ADMIN_TELEGRAM_ID, process.env.ADMIN_FULL_NAME || 'Администратор', STAGES[0].code);
  } else if (!existingAdmin.is_admin) {
    db.prepare('UPDATE users SET is_admin = 1 WHERE telegram_id = ?').run(process.env.ADMIN_TELEGRAM_ID);
  }
}

// Дефолтная номенклатура — если таблица пустая, засеваем стартовым списком
const count = db.prepare('SELECT COUNT(*) AS c FROM nomenclature').get().c;
if (count === 0) {
  const insert = db.prepare('INSERT INTO nomenclature (name, unit, sort_order) VALUES (?, ?, ?)');
  const seed = ['Унитаз', 'Чашагён', 'Крышка'];
  seed.forEach((name, i) => insert.run(name, 'шт', i));
}

module.exports = { db, STAGES };
