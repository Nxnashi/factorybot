const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, '..', 'factory.db'));
db.pragma('journal_mode = WAL');

const { CLAY_MATERIALS, GLAZE_MATERIALS } = require('./catalog');

// Этапы производства (порядок важен для отчёта). Структура этапов повторяет документы 1С.
// formType:
//   'materials' — замес (сырьё по замесам + выход)
//   'doc'       — документ-строка на сотрудника+модель; поля описаны в fields, шапка (линия/вагон) в header
// fields: key — колонка в entries; kind: 'in' (вводит рабочий), role: как поле участвует в балансе
//   total — "поступило в работу", good — "ушло дальше", defect — потери, repair — на ремонт
const STAGES = [
  { code: 'clay_mixing', description: 'Замес глины. Выбери барабан (1–3) и начни замес. Вноси сырьё по списку — количество в кг по каждой позиции, можно в несколько приёмов. Итого вес замеса считается сам, при необходимости его можно исправить. За день на барабане можно сделать несколько замесов, у каждого свой код и время.', title: 'Глина (замес)', formType: 'materials' },
  { code: 'glaze_mixing', description: 'Замес глазури. Барабан всегда один. Начни замес, внеси сырьё по списку (кг). Итого вес замеса считается сам, при необходимости его можно исправить. Замесов в день может быть несколько — у каждого свой код и время.', title: 'Глазурь (замес)', formType: 'materials' },
  {
    code: 'molding', description: 'Формовка. Открой смену и выбери сотрудника. Укажи номер линии, затем по каждой модели — сколько залито и сколько годных. Разница (залито − годных) автоматически возвращается в глину.', title: 'Формовка', formType: 'doc',
    header: { key: 'line_no', label: 'Номер линии', min: 1 },
    fields: [
      { key: 'qty_total', label: 'Залито, шт' },
      { key: 'quantity', label: 'Годных, шт' },
    ],
    // разница залито − годных автоматически возвращается в глину (qty_defect)
    rule: 'molding',
    hint: 'Разница (залито − годных) автоматически вернётся в глину',
  },
  {
    code: 'fettling', description: 'Оправка. Открой смену, выбери сотрудника. По каждой модели вноси общее количество и брак. Квалифицированное количество (общее − брак) считается автоматически.', title: 'Оправка', formType: 'doc',
    fields: [
      { key: 'qty_total', label: 'Общее количество' },
      { key: 'qty_defect', label: 'Брак', bad: true },
    ],
    rule: 'total_defect',
    hint: 'Квалифицированное количество = общее − брак (считается само)',
  },
  {
    code: 'glazing', description: 'Глазурирование. Открой смену, выбери сотрудника. По каждой модели вноси общее количество и брак. Квалифицированное количество (общее − брак) считается автоматически.', title: 'Глазурирование', formType: 'doc',
    fields: [
      { key: 'qty_total', label: 'Общее количество' },
      { key: 'qty_defect', label: 'Брак', bad: true },
    ],
    rule: 'total_defect',
    hint: 'Квалифицированное количество = общее − брак (считается само)',
  },
  {
    code: 'kiln', description: 'Загрузка в печь. Выбери номер вагона и вноси количество по каждой модели, загруженной в этот вагон. Для следующего вагона смени номер и сохрани ещё раз.', title: 'Загрузка в печь', formType: 'doc',
    header: { key: 'wagon_no', label: 'Номер вагона', min: 1 },
    fields: [{ key: 'quantity', label: 'Количество, шт' }],
    rule: 'simple',
    hint: 'Выбери вагон и вноси количество по каждой модели. Другой вагон — смени номер и сохрани ещё раз',
  },
  {
    code: 'sorting', description: 'Сортировка (после обжига). Открой смену, выбери сотрудника. По каждой модели вноси: Сорт-1, Сорт-2, Ремонт и Брак/Бой.', title: 'Сортировка', formType: 'doc',
    fields: [
      { key: 'qty_s1', label: 'Сорт-1' },
      { key: 'qty_s2', label: 'Сорт-2' },
      { key: 'qty_repair', label: 'Ремонт' },
      { key: 'qty_defect', label: 'Брак/Бой', bad: true },
    ],
    rule: 'sorting',
  },
  {
    code: 'finished', description: 'Готовая продукция. Открой смену, выбери сотрудника. По каждой модели вноси количество отдельно по сортам (Сорт 1, Сорт 2).', title: 'Готовая продукция', formType: 'doc',
    gradeOptions: [
      { code: '1', label: 'Сорт 1', countsAsGood: true },
      { code: '2', label: 'Сорт 2', countsAsGood: true },
    ],
    needsGrade: true,
    fields: [{ key: 'quantity', label: 'Количество, шт' }],
    rule: 'simple',
  },
];

// Старые этапы: больше не вносятся, но история по ним остаётся видна в админке
const LEGACY_STAGES = [
  { code: 'intake', title: 'Приход ТМЦ (старое)', formType: 'legacy' },
  { code: 'qc_molding', title: 'QC промежуточный (старое)', formType: 'legacy' },
  { code: 'breakage', title: 'Учёт боя (старое)', formType: 'legacy' },
  { code: 'qc_final', title: 'Участок сортировки (старое)', formType: 'legacy' },
];

// Этапы со сменой старшего: старший набирает состав и вносит выработку за каждого сотрудника
const ROSTER_STAGES = ['molding', 'fettling', 'glazing', 'kiln', 'sorting', 'finished'];

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

-- Журнал проводок: у каждой операции уникальный код; строки не удаляются, только отменяются
CREATE TABLE IF NOT EXISTS postings (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  op_code      TEXT NOT NULL UNIQUE,
  parent_code  TEXT,                         -- для строк замеса — код самого замеса
  stage        TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'post', -- 'batch' | 'material' | 'post'
  entry_date   TEXT NOT NULL,
  telegram_id  TEXT,
  actor_name   TEXT,                         -- кто выполнил работу
  entered_by   TEXT,                         -- кто внёс (старший)
  ref_table    TEXT,
  ref_id       INTEGER,
  summary      TEXT,
  qty          REAL,
  status       TEXT NOT NULL DEFAULT 'posted', -- 'posted' | 'cancelled'
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  cancelled_at TEXT,
  cancelled_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_postings_date ON postings(entry_date, stage);
CREATE INDEX IF NOT EXISTS idx_postings_ref ON postings(ref_table, ref_id);

-- Заготовки справочников (структура; данные зальём позже)
CREATE TABLE IF NOT EXISTS tmc_catalog (          -- все ТМЦ
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT, name TEXT NOT NULL, unit TEXT NOT NULL DEFAULT 'шт', group_name TEXT,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS semi_products (        -- полуфабрикаты (п/ф)
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT, name TEXT NOT NULL, unit TEXT NOT NULL DEFAULT 'шт', stage TEXT,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS kits (                 -- комплекты готовой продукции
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT, name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS kit_items (            -- состав комплекта
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kit_id INTEGER NOT NULL,
  nomenclature_id INTEGER,
  semi_product_id INTEGER,
  quantity REAL NOT NULL DEFAULT 1,
  FOREIGN KEY (kit_id) REFERENCES kits(id)
);
`);

function addColumn(table, col, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
}
// Новые поля операций (формовка/оправка/глазурирование/сортировка/печь)
addColumn('entries', 'op_code', 'TEXT');
addColumn('entries', 'line_no', 'INTEGER');
addColumn('entries', 'wagon_no', 'INTEGER');
addColumn('entries', 'qty_total', 'REAL');
addColumn('entries', 'qty_defect', 'REAL');
addColumn('entries', 'qty_repair', 'REAL');
addColumn('entries', 'qty_s1', 'REAL');
addColumn('entries', 'qty_s2', 'REAL');
// Замесы: порядковый номер за день по барабану + уникальный код
addColumn('mixing_batches', 'batch_no', 'INTEGER');
addColumn('mixing_batches', 'code', 'TEXT');
addColumn('mixing_batches', 'calc_quantity', 'REAL');   // авто-итог веса замеса (сумма сырья)
addColumn('material_entries', 'op_code', 'TEXT');
// "Удалено" как в iiko: запись остаётся в базе (история цела), в списках для работы не показывается
addColumn('materials', 'deleted', 'INTEGER NOT NULL DEFAULT 0');
addColumn('materials', 'is_custom', 'INTEGER NOT NULL DEFAULT 0');   // добавлено админом, а не из catalog.js
addColumn('employees', 'deleted', 'INTEGER NOT NULL DEFAULT 0');
addColumn('nomenclature', 'deleted', 'INTEGER NOT NULL DEFAULT 0');

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
const LEGACY_REMAP = { qc_final: 'sorting', breakage: 'sorting', qc_molding: 'molding' };
const validCodes = new Set(STAGES.map(s => s.code));
// Ростер: сотрудников старых цехов переносим в новые
for (const [from, to] of Object.entries(LEGACY_REMAP)) {
  db.prepare('UPDATE employees SET stage = ? WHERE stage = ?').run(to, from);
}
const allUsers = db.prepare('SELECT telegram_id, stage FROM users').all();
const fixStage = db.prepare('UPDATE users SET stage = ? WHERE telegram_id = ?');
for (const u of allUsers) {
  const codes = String(u.stage).split(',').map(s => s.trim()).filter(Boolean);
  const remapped = codes.map(c => LEGACY_REMAP[c] || c);
  const cleaned = remapped.filter((c, i) => validCodes.has(c) && remapped.indexOf(c) === i);
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

// Сырьё (ТМЦ) для замесов — СТАТИЧНЫЙ список из src/catalog.js, через админку не меняется.
// При старте приводим таблицу к каталогу: совпавшие позиции включаем и выставляем порядок,
// лишние (старые) скрываем — историю по ним не трогаем.
function syncMaterials(category, list) {
  const existing = db.prepare('SELECT * FROM materials WHERE category = ? AND is_custom = 0').all(category);
  const used = new Set();
  const upd = db.prepare('UPDATE materials SET name = ?, article = ?, active = CASE WHEN deleted = 1 THEN 0 ELSE 1 END, sort_order = ? WHERE id = ?');
  const ins = db.prepare('INSERT INTO materials (name, article, category, unit, sort_order) VALUES (?, ?, ?, ?, ?)');
  list.forEach((m, i) => {
    const found = existing.find(e => !used.has(e.id) && (e.article || '') === (m.article || '') && e.name === m.name);
    if (found) { used.add(found.id); upd.run(m.name, m.article, i, found.id); }
    else ins.run(m.name, m.article, category, 'кг', i);
  });
  for (const e of existing) {
    if (!used.has(e.id) && !list.some(m => (m.article || '') === (e.article || '') && m.name === e.name)) {
      db.prepare('UPDATE materials SET active = 0 WHERE id = ?').run(e.id);
    }
  }
}
db.transaction(() => {
  syncMaterials('clay_mixing', CLAY_MATERIALS);
  syncMaterials('glaze_mixing', GLAZE_MATERIALS);
})();

module.exports = { db, STAGES, LEGACY_STAGES, ROSTER_STAGES };
