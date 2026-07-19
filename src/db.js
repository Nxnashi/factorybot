const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, '..', 'factory.db'));
db.pragma('journal_mode = WAL');

// Этапы производства (фиксированный список, порядок важен для отчёта)
// formType: 'quantity' — номенклатура готовой продукции, 'photo' — фото документа, 'materials' — сырьё (ТМЦ)
// gradeOptions — если задано, на этапе вместо простого количества показывается разбивка по этим статусам.
//   countsAsGood: false — статус не считается потерей в "Балансе" (напр. "Возврат" уходит в переработку, а не теряется)
const STAGES = [
  { code: 'intake', title: 'Приход ТМЦ', needsGrade: false, formType: 'photo', gradeOptions: null },
  { code: 'clay_mixing', title: 'Замес глины', needsGrade: false, formType: 'materials', gradeOptions: null },
  { code: 'glaze_mixing', title: 'Замес глазури', needsGrade: false, formType: 'materials', gradeOptions: null },
  { code: 'molding', title: 'Формовочный цех', needsGrade: false, formType: 'quantity', gradeOptions: null },
  {
    code: 'qc_molding',
    title: 'QC промежуточный контроль качества',
    needsGrade: true,
    formType: 'quantity',
    gradeOptions: [
      { code: 'good', label: 'Годно', countsAsGood: true },
      { code: 'return', label: 'Возврат', countsAsGood: false },
    ],
  },
  { code: 'glazing', title: 'Глазировка', needsGrade: false, formType: 'quantity', gradeOptions: null },
  { code: 'kiln', title: 'Печь', needsGrade: false, formType: 'quantity', gradeOptions: null },
  { code: 'breakage', title: 'Учёт боя после закаливания', needsGrade: false, formType: 'quantity', gradeOptions: null },
  {
    code: 'qc_final',
    title: 'Участок сортировки',
    needsGrade: true,
    formType: 'quantity',
    gradeOptions: [
      { code: '1', label: 'Сорт 1', countsAsGood: true },
      { code: '2', label: 'Сорт 2', countsAsGood: true },
      { code: 'brak', label: 'Брак', countsAsGood: false },
    ],
  },
];

// Этапы, где введена система "старший + состав смены": старший сначала набирает
// состав смены (кто сегодня работает), потом вносит выработку за каждого сотрудника отдельно
const ROSTER_STAGES = ['molding', 'qc_molding', 'glazing', 'kiln', 'breakage', 'qc_final'];

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
  telegram_id     TEXT NOT NULL,        -- кто внёс (старший)
  employee_name   TEXT NOT NULL,        -- кто фактически выполнил работу
  employee_id     INTEGER,              -- ссылка на employees(id), если это ростер-сотрудник
  entered_by      TEXT,                 -- имя старшего, внёсшего запись (аудит)
  nomenclature_id INTEGER NOT NULL,
  quantity        REAL NOT NULL,
  grade           TEXT,                 -- код из gradeOptions этапа, либо NULL
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

CREATE TABLE IF NOT EXISTS materials (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  article    TEXT,
  category   TEXT NOT NULL,   -- 'clay_mixing' или 'glaze_mixing'
  unit       TEXT NOT NULL DEFAULT 'кг',
  active     INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS mixing_batches (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_date      TEXT NOT NULL,
  stage           TEXT NOT NULL,
  telegram_id     TEXT NOT NULL,
  employee_name   TEXT NOT NULL,
  drum_number     INTEGER NOT NULL,
  output_quantity REAL,
  status          TEXT NOT NULL DEFAULT 'in_progress', -- 'in_progress' | 'completed' | 'cancelled'
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at    TEXT
);

CREATE TABLE IF NOT EXISTS material_entries (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_date    TEXT NOT NULL,
  stage         TEXT NOT NULL,
  telegram_id   TEXT NOT NULL,
  employee_name TEXT NOT NULL,
  material_id   INTEGER NOT NULL,
  quantity      REAL NOT NULL,
  drum_number   INTEGER,
  batch_id      INTEGER,
  comment       TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (material_id) REFERENCES materials(id),
  FOREIGN KEY (batch_id) REFERENCES mixing_batches(id)
);

CREATE INDEX IF NOT EXISTS idx_material_entries_date_stage ON material_entries(entry_date, stage);

-- Ростер сотрудников по этапам (не имеют своего доступа в бот — только старший вносит за них)
CREATE TABLE IF NOT EXISTS employees (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name  TEXT NOT NULL,
  stage      TEXT NOT NULL,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Личная смена старшего на этапе: открывается перед началом работы, закрывается по завершению
CREATE TABLE IF NOT EXISTS foreman_shifts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id   TEXT NOT NULL,
  stage         TEXT NOT NULL,
  entry_date    TEXT NOT NULL,
  employee_ids  TEXT NOT NULL,                 -- через запятую — состав смены, выбранный при открытии
  status        TEXT NOT NULL DEFAULT 'open',  -- 'open' | 'closed'
  opened_at     TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at     TEXT
);

CREATE INDEX IF NOT EXISTS idx_foreman_shifts_lookup ON foreman_shifts(telegram_id, stage, entry_date);
`);

// Миграция: если база создана до появления поля article — добавляем колонку
const nomCols = db.prepare("PRAGMA table_info(nomenclature)").all().map(c => c.name);
if (!nomCols.includes('article')) {
  db.exec('ALTER TABLE nomenclature ADD COLUMN article TEXT');
}

// Миграция: номер барабана для расхода сырья по замесу
const matEntryCols = db.prepare("PRAGMA table_info(material_entries)").all().map(c => c.name);
if (!matEntryCols.includes('drum_number')) {
  db.exec('ALTER TABLE material_entries ADD COLUMN drum_number INTEGER');
}
if (!matEntryCols.includes('batch_id')) {
  db.exec('ALTER TABLE material_entries ADD COLUMN batch_id INTEGER');
}

// Миграция: старший/ростер-сотрудник в entries
const entryCols = db.prepare("PRAGMA table_info(entries)").all().map(c => c.name);
if (!entryCols.includes('employee_id')) {
  db.exec('ALTER TABLE entries ADD COLUMN employee_id INTEGER');
}
if (!entryCols.includes('entered_by')) {
  db.exec('ALTER TABLE entries ADD COLUMN entered_by TEXT');
}

// Миграция: старый единый этап "Замес" (mixing) разделили на два — переносим всех,
// кто был на старом коде, на оба новых, чтобы не потеряли доступ
const legacyMixingUsers = db.prepare("SELECT telegram_id, stage FROM users WHERE stage LIKE '%mixing%'").all()
  .filter(u => u.stage.split(',').map(s => s.trim()).includes('mixing'));
for (const u of legacyMixingUsers) {
  const codes = u.stage.split(',').map(s => s.trim()).filter(c => c !== 'mixing');
  if (!codes.includes('clay_mixing')) codes.push('clay_mixing');
  if (!codes.includes('glaze_mixing')) codes.push('glaze_mixing');
  db.prepare('UPDATE users SET stage = ? WHERE telegram_id = ?').run(codes.join(','), u.telegram_id);
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

// Каталог сырья (ТМЦ) для замеса глины и замеса глазури — отдельный от готовой продукции,
// добавляем то, чего ещё нет (по названию+категории), не трогая накопленное
const MATERIALS_CATALOG = [
  // Замес глины — с артикулами
  { name: 'Полевой шпат', article: '1', category: 'clay_mixing' },
  { name: 'Сырье полевой шпат', article: 'R1', category: 'clay_mixing' },
  { name: 'Кварц', article: '2', category: 'clay_mixing' },
  { name: 'Доломит', article: '3', category: 'clay_mixing' },
  { name: 'Каолин серый обогащенный', article: '4', category: 'clay_mixing' },
  { name: 'Каолин серый необогащенный', article: 'R4', category: 'clay_mixing' },
  { name: 'Каолин 30 обогащенный', article: '5', category: 'clay_mixing' },
  { name: 'Каолин 30 необогащенный', article: 'R5', category: 'clay_mixing' },
  { name: 'Глинозем', article: 'R7', category: 'clay_mixing' },
  { name: 'Каолин 78 необогащенный', article: 'R6', category: 'clay_mixing' },
  { name: 'Каолин 78 обогащенный', article: '6', category: 'clay_mixing' },
  { name: 'Сода', article: '8', category: 'clay_mixing' },
  { name: 'Жидкое стекло', article: '9', category: 'clay_mixing' },
  { name: 'Глинозем', article: '10', category: 'clay_mixing' },
  { name: 'Вода', article: '11', category: 'clay_mixing' },
  { name: 'Глина', article: '12', category: 'clay_mixing' },
  { name: 'Камни для перемолки', article: '13', category: 'clay_mixing' },
  // Замес глазури — пока без артикулов
  { name: 'Полевой шпат', article: null, category: 'glaze_mixing' },
  { name: 'Кварц', article: null, category: 'glaze_mixing' },
  { name: 'Кальцит', article: null, category: 'glaze_mixing' },
  { name: 'Тальк', article: null, category: 'glaze_mixing' },
  { name: 'Оксид алюминия', article: null, category: 'glaze_mixing' },
  { name: 'Барий карбонат', article: null, category: 'glaze_mixing' },
  { name: 'Силикат циркония', article: null, category: 'glaze_mixing' },
  { name: 'Оксид цинка', article: null, category: 'glaze_mixing' },
  { name: 'Каолин', article: null, category: 'glaze_mixing' },
  { name: 'КМЦ клей', article: null, category: 'glaze_mixing' },
];
const existingMaterials = new Set(
  db.prepare('SELECT name, category, article FROM materials').all()
    .map(r => `${r.name}|${r.category}|${r.article || ''}`)
);
const maxMatOrderRow = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM materials').get();
let nextMatOrder = maxMatOrderRow.m + 1;
const insertMaterial = db.prepare('INSERT INTO materials (name, article, category, unit, sort_order) VALUES (?, ?, ?, ?, ?)');
for (const m of MATERIALS_CATALOG) {
  const key = `${m.name}|${m.category}|${m.article || ''}`;
  if (existingMaterials.has(key)) continue;
  insertMaterial.run(m.name, m.article, m.category, 'кг', nextMatOrder);
  nextMatOrder++;
}

module.exports = { db, STAGES, ROSTER_STAGES };
