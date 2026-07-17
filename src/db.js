const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, '..', 'factory.db'));
db.pragma('journal_mode = WAL');

// Этапы производства (фиксированный список, порядок важен для отчёта)
// formType: 'quantity' — обычная форма номенклатура+количество, 'photo' — фото документа
const STAGES = [
  { code: 'intake', title: 'Приход ТМЦ', needsGrade: false, formType: 'photo' },
  { code: 'mixing', title: 'Замес глины', needsGrade: false, formType: 'quantity' },
  { code: 'molding', title: 'Формовочный цех', needsGrade: false, formType: 'quantity' },
  { code: 'qc_molding', title: 'QC промежуточный контроль качества', needsGrade: true, formType: 'quantity' },
  { code: 'glazing', title: 'Глазировка', needsGrade: false, formType: 'quantity' },
  { code: 'kiln', title: 'Печь', needsGrade: false, formType: 'quantity' },
  { code: 'breakage', title: 'Учёт боя после закаливания', needsGrade: false, formType: 'quantity' },
  { code: 'qc_final', title: 'Участок сортировки', needsGrade: true, formType: 'quantity' },
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
  article    TEXT,
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

CREATE TABLE IF NOT EXISTS closed_days (
  entry_date TEXT PRIMARY KEY,
  closed_by  TEXT NOT NULL,
  closed_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS intake_photos (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_date    TEXT NOT NULL,
  telegram_id   TEXT NOT NULL,
  employee_name TEXT NOT NULL,
  caption       TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// Миграция: если база создана до появления поля article — добавляем колонку
const nomCols = db.prepare("PRAGMA table_info(nomenclature)").all().map(c => c.name);
if (!nomCols.includes('article')) {
  db.exec('ALTER TABLE nomenclature ADD COLUMN article TEXT');
}

// Миграция: если этап был удалён из STAGES (например "Приход ТМЦ"), но кому-то ещё назначен —
// убираем его из списка этапов пользователя, чтобы не остаться с несуществующим этапом
const validCodes = new Set(STAGES.map(s => s.code));
const allUsers = db.prepare('SELECT telegram_id, stage FROM users').all();
const fixStage = db.prepare('UPDATE users SET stage = ? WHERE telegram_id = ?');
for (const u of allUsers) {
  const codes = String(u.stage).split(',').map(s => s.trim()).filter(Boolean);
  const cleaned = codes.filter(c => validCodes.has(c));
  const finalCodes = cleaned.length > 0 ? cleaned : [STAGES[0].code];
  if (finalCodes.join(',') !== u.stage) {
    fixStage.run(finalCodes.join(','), u.telegram_id);
  }
}

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

// Каталог продукции — добавляем при старте те позиции, которых ещё нет (по артикулу),
// не трогая то, что уже накопилось или было изменено вручную через админку
const CATALOG = [
  { name: 'Раковина "Уголок" с ножкой', article: '1' },
  { name: 'Раковина "Россо" с ножкой', article: '2' },
  { name: 'Раковина "Тюльпан" с ножкой', article: '3' },
  { name: 'Раковина "Капля" с ножкой', article: '4' },
  { name: 'Раковина "Верона" с ножкой', article: '5' },
  { name: '60см. Раковина с ножкой', article: '6' },
  { name: '65см. Раковина с ножкой', article: '7' },
  { name: 'Стандартная ножка для раковины', article: '22' },
  { name: 'Раковина "Семья" с ножкой', article: '8' },
  { name: 'Ножка "Семья"', article: '23' },
  { name: 'Раковина "Детская" с ножкой', article: '9' },
  { name: 'Ножка "Детская"', article: '24' },
  { name: 'Раковина "ТВ" под тумбу', article: '12' },
  { name: 'Унитаз "Детский" с бачком', article: '13' },
  { name: 'Бачок "Детский"', article: '19' },
  { name: 'Унитаз "Турецкий" с бачком', article: '14' },
  { name: 'Бачок "Турецкий"', article: '20' },
  { name: 'Унитаз "КОКО" с бачком', article: '15' },
  { name: 'Бачок "КОКО"', article: '21' },
  { name: 'Чашаген с сифоном', article: '16' },
  { name: 'Чашаген без сифона (прямой)', article: '18' },
];
const existingArticles = new Set(db.prepare('SELECT article FROM nomenclature WHERE article IS NOT NULL').all().map(r => r.article));
const maxOrderRow = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM nomenclature').get();
let nextOrder = maxOrderRow.m + 1;
const insertCatalogItem = db.prepare('INSERT INTO nomenclature (name, article, unit, sort_order) VALUES (?, ?, ?, ?)');
for (const item of CATALOG) {
  if (existingArticles.has(item.article)) continue;
  insertCatalogItem.run(item.name, item.article, 'шт', nextOrder);
  nextOrder++;
}

// Дефолтная номенклатура — если таблица совсем пустая (первый запуск без каталога выше)
const count = db.prepare('SELECT COUNT(*) AS c FROM nomenclature').get().c;
if (count === 0) {
  const insert = db.prepare('INSERT INTO nomenclature (name, unit, sort_order) VALUES (?, ?, ?)');
  const seed = ['Унитаз', 'Чашагён', 'Крышка'];
  seed.forEach((name, i) => insert.run(name, 'шт', i));
}

module.exports = { db, STAGES };
