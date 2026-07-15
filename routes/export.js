const express = require('express');
const { db } = require('../src/db');
const { buildReportWorkbook, reportFilename } = require('../src/reportGenerator');

const router = express.Router();

function requireAdmin(req, res, next) {
  const telegramId = req.header('x-telegram-id');
  if (!telegramId) return res.status(401).json({ error: 'no_auth' });
  const user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegramId);
  if (!user || !user.is_admin) return res.status(403).json({ error: 'forbidden' });
  next();
}

router.use(requireAdmin);

router.get('/', async (req, res) => {
  const { date_from, date_to } = req.query;
  const from = date_from || new Date().toISOString().slice(0, 10);
  const to = date_to || from;

  const workbook = await buildReportWorkbook(from, to);
  const filename = reportFilename(from, to);

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  await workbook.xlsx.write(res);
  res.end();
});

module.exports = router;
