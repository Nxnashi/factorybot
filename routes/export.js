const express = require('express');
const ExcelJS = require('exceljs');
const { db, STAGES } = require('../src/db');

const router = express.Router();

function requireAdmin(req, res, next) {
  const telegramId = req.header('x-telegram-id');
  if (!telegramId) return res.status(401).json({ error: 'no_auth' });
  const user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegramId);
  if (!user || !user.is_admin) return res.status(403).json({ error: 'forbidden' });
  next();
}

router.use(requireAdmin);

const GRADE_LABELS = { '1': 'Сорт 1', '2': 'Сорт 2', '3': 'Сорт 3', brak: 'Брак' };

router.get('/', async (req, res) => {
  const { date_from, date_to } = req.query;
  const from = date_from || new Date().toISOString().slice(0, 10);
  const to = date_to || from;

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Factory Tracker';
  workbook.created = new Date();

  const headerFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } };

  // Лист-сводка по всем этапам
  const summarySheet = workbook.addWorksheet('Сводка');
  summarySheet.columns = [
    { header: 'Дата', key: 'entry_date', width: 12 },
    { header: 'Этап', key: 'stage_title', width: 28 },
    { header: 'Сотрудник', key: 'employee_name', width: 22 },
    { header: 'Номенклатура', key: 'nomenclature_name', width: 20 },
    { header: 'Кол-во', key: 'quantity', width: 10 },
    { header: 'Сорт', key: 'grade_label', width: 12 },
    { header: 'Комментарий', key: 'comment', width: 25 },
    { header: 'Время', key: 'created_at', width: 18 },
  ];
  summarySheet.getRow(1).eachCell(c => { c.fill = headerFill; c.font = { bold: true }; });

  const stageTitleByCode = Object.fromEntries(STAGES.map(s => [s.code, s.title]));

  const allRows = db.prepare(`
    SELECT e.entry_date, e.stage, e.employee_name, n.name AS nomenclature_name,
           e.quantity, e.grade, e.comment, e.created_at
    FROM entries e
    JOIN nomenclature n ON n.id = e.nomenclature_id
    WHERE e.entry_date BETWEEN ? AND ?
    ORDER BY e.entry_date, e.stage, e.created_at
  `).all(from, to);

  allRows.forEach(r => {
    summarySheet.addRow({
      entry_date: r.entry_date,
      stage_title: stageTitleByCode[r.stage] || r.stage,
      employee_name: r.employee_name,
      nomenclature_name: r.nomenclature_name,
      quantity: r.quantity,
      grade_label: r.grade ? (GRADE_LABELS[r.grade] || r.grade) : '',
      comment: r.comment || '',
      created_at: r.created_at,
    });
  });

  // Отдельный лист на каждый этап
  for (const stage of STAGES) {
    const sheet = workbook.addWorksheet(stage.title.slice(0, 31));
    sheet.columns = [
      { header: 'Дата', key: 'entry_date', width: 12 },
      { header: 'Сотрудник', key: 'employee_name', width: 22 },
      { header: 'Номенклатура', key: 'nomenclature_name', width: 20 },
      { header: 'Кол-во', key: 'quantity', width: 10 },
      ...(stage.needsGrade ? [{ header: 'Сорт', key: 'grade_label', width: 12 }] : []),
      { header: 'Комментарий', key: 'comment', width: 25 },
      { header: 'Время', key: 'created_at', width: 18 },
    ];
    sheet.getRow(1).eachCell(c => { c.fill = headerFill; c.font = { bold: true }; });

    const stageRows = allRows.filter(r => r.stage === stage.code);
    stageRows.forEach(r => {
      sheet.addRow({
        entry_date: r.entry_date,
        employee_name: r.employee_name,
        nomenclature_name: r.nomenclature_name,
        quantity: r.quantity,
        grade_label: r.grade ? (GRADE_LABELS[r.grade] || r.grade) : '',
        comment: r.comment || '',
        created_at: r.created_at,
      });
    });
  }

  const filename = from === to ? `otchet_${from}.xlsx` : `otchet_${from}_${to}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  await workbook.xlsx.write(res);
  res.end();
});

module.exports = router;
