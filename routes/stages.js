const express = require('express');
const multer = require('multer');
const { db, STAGES } = require('../src/db');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

function getStageMeta(code) {
  return STAGES.find(s => s.code === code);
}

function parseStages(stageField) {
  return String(stageField).split(',').map(s => s.trim()).filter(Boolean);
}

// Кто я и какие у меня этапы (может быть несколько)
router.get('/me/:telegramId', (req, res) => {
  const { telegramId } = req.params;
  const user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegramId);
  if (!user) {
    return res.status(404).json({ error: 'not_registered' });
  }
  const stageCodes = parseStages(user.stage);
  const stages = stageCodes.map(code => {
    const meta = getStageMeta(code);
    return {
      code,
      title: meta ? meta.title : code,
      needs_grade: meta ? meta.needsGrade : false,
      form_type: meta ? meta.formType : 'quantity',
    };
  });
  res.json({
    telegram_id: user.telegram_id,
    full_name: user.full_name,
    is_admin: !!user.is_admin,
    stages,
  });
});

// Приём фото накладной (этап "Приход ТМЦ") — сохраняем метаданные и пересылаем админам в Telegram
// multipart/form-data: telegram_id, entry_date, caption?, photo (файл)
router.post('/intake-photo', upload.single('photo'), async (req, res) => {
  const { telegram_id, entry_date, caption } = req.body;

  if (!telegram_id || !entry_date || !req.file) {
    return res.status(400).json({ error: 'bad_request' });
  }

  const user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegram_id);
  if (!user) {
    return res.status(404).json({ error: 'not_registered' });
  }

  const closedDay = db.prepare('SELECT 1 FROM closed_days WHERE entry_date = ?').get(entry_date);
  if (closedDay) {
    return res.status(403).json({ error: 'day_closed' });
  }

  const allowedStages = parseStages(user.stage);
  if (!allowedStages.includes('intake')) {
    return res.status(403).json({ error: 'stage_not_allowed' });
  }

  db.prepare(`
    INSERT INTO intake_photos (entry_date, telegram_id, employee_name, caption)
    VALUES (?, ?, ?, ?)
  `).run(entry_date, user.telegram_id, user.full_name, caption || null);

  // Пересылаем фото всем администраторам в Telegram
  if (process.env.BOT_TOKEN) {
    try {
      const bot = require('../src/bot');
      const admins = db.prepare('SELECT telegram_id FROM users WHERE is_admin = 1').all();
      const captionText = `📷 Накладная от ${user.full_name} за ${entry_date}` + (caption ? `\n${caption}` : '');
      for (const admin of admins) {
        await bot.sendPhoto(admin.telegram_id, req.file.buffer, { caption: captionText });
      }
    } catch (err) {
      console.error('Не удалось переслать фото накладной админам:', err.message);
    }
  }

  res.json({ ok: true });
});

// Сколько фото накладных отправлено сегодня этим сотрудником
router.get('/today-photos/:telegramId', (req, res) => {
  const { telegramId } = req.params;
  const today = new Date().toISOString().slice(0, 10);
  const rows = db.prepare(`
    SELECT id, caption, created_at FROM intake_photos
    WHERE telegram_id = ? AND entry_date = ?
    ORDER BY created_at DESC
  `).all(telegramId, today);
  res.json(rows);
});

// Активная номенклатура для формы
router.get('/nomenclature', (req, res) => {
  const rows = db.prepare('SELECT id, name, article, unit FROM nomenclature WHERE active = 1 ORDER BY sort_order, id').all();
  res.json(rows);
});

// Отправка партии записей за один сабмит формы
// body: { telegram_id, entry_date, stage, items: [{ nomenclature_id, quantity, grade?, comment? }] }
router.post('/submit', (req, res) => {
  const { telegram_id, entry_date, stage, items } = req.body;

  if (!telegram_id || !entry_date || !stage || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'bad_request' });
  }

  const user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegram_id);
  if (!user) {
    return res.status(404).json({ error: 'not_registered' });
  }

  const closedDay = db.prepare('SELECT 1 FROM closed_days WHERE entry_date = ?').get(entry_date);
  if (closedDay) {
    return res.status(403).json({ error: 'day_closed' });
  }

  const allowedStages = parseStages(user.stage);
  if (!allowedStages.includes(stage)) {
    return res.status(403).json({ error: 'stage_not_allowed' });
  }

  const stageMeta = getStageMeta(stage);

  const insert = db.prepare(`
    INSERT INTO entries (entry_date, stage, telegram_id, employee_name, nomenclature_id, quantity, grade, comment)
    VALUES (@entry_date, @stage, @telegram_id, @employee_name, @nomenclature_id, @quantity, @grade, @comment)
  `);

  const insertMany = db.transaction((rows) => {
    for (const row of rows) insert.run(row);
  });

  const rows = items
    .filter(it => Number(it.quantity) > 0)
    .map(it => ({
      entry_date,
      stage,
      telegram_id: user.telegram_id,
      employee_name: user.full_name,
      nomenclature_id: it.nomenclature_id,
      quantity: Number(it.quantity),
      grade: stageMeta && stageMeta.needsGrade ? (it.grade || null) : null,
      comment: it.comment || null,
    }));

  if (rows.length === 0) {
    return res.status(400).json({ error: 'no_valid_items' });
  }

  insertMany(rows);
  res.json({ ok: true, saved: rows.length });
});

// Удалить свою запись (только за сегодня — чтобы нельзя было редактировать закрытую историю)
router.delete('/entries/:id', (req, res) => {
  const { telegram_id } = req.query;
  const { id } = req.params;
  if (!telegram_id) return res.status(400).json({ error: 'bad_request' });

  const today = new Date().toISOString().slice(0, 10);
  const entry = db.prepare('SELECT * FROM entries WHERE id = ?').get(id);

  if (!entry) return res.status(404).json({ error: 'not_found' });
  if (entry.telegram_id !== String(telegram_id)) return res.status(403).json({ error: 'not_yours' });
  if (entry.entry_date !== today) return res.status(403).json({ error: 'not_today' });

  const closedDay = db.prepare('SELECT 1 FROM closed_days WHERE entry_date = ?').get(entry.entry_date);
  if (closedDay) return res.status(403).json({ error: 'day_closed' });

  db.prepare('DELETE FROM entries WHERE id = ?').run(id);
  res.json({ ok: true });
});

// История за сегодня для этого сотрудника (чтобы видел что уже вбил)
router.get('/today/:telegramId', (req, res) => {
  const { telegramId } = req.params;
  const today = new Date().toISOString().slice(0, 10);
  const rows = db.prepare(`
    SELECT e.id, e.stage, e.quantity, e.grade, e.comment, e.created_at, n.name AS nomenclature_name
    FROM entries e
    JOIN nomenclature n ON n.id = e.nomenclature_id
    WHERE e.telegram_id = ? AND e.entry_date = ?
    ORDER BY e.created_at DESC
  `).all(telegramId, today);
  const withTitles = rows.map(r => ({ ...r, stage_title: (getStageMeta(r.stage) || {}).title || r.stage }));
  res.json(withTitles);
});

module.exports = router;
