const ExcelJS = require('exceljs');
const { db, STAGES } = require('./db');

const GRADE_LABELS = { '1': 'Сорт 1', '2': 'Сорт 2', '3': 'Сорт 3', brak: 'Брак' };

async function buildReportWorkbook(from, to) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Factory Tracker';
  workbook.created = new Date();

  const headerFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } };

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
    SELECT e.entry_date, e.stage, e.employee_name,
           n.name || CASE WHEN n.article IS NOT NULL THEN ' (' || n.article || ')' ELSE '' END AS nomenclature_name,
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

  for (const stage of STAGES) {
    const sheet = workbook.addWorksheet(stage.title.slice(0, 31));

    if (stage.formType === 'materials') {
      sheet.columns = [
        { header: 'Дата', key: 'entry_date', width: 12 },
        { header: 'Сотрудник', key: 'employee_name', width: 22 },
        { header: 'Сырьё', key: 'material_name', width: 30 },
        { header: 'Кол-во (кг)', key: 'quantity', width: 12 },
        { header: 'Комментарий', key: 'comment', width: 25 },
        { header: 'Время', key: 'created_at', width: 18 },
      ];
      sheet.getRow(1).eachCell(c => { c.fill = headerFill; c.font = { bold: true }; });

      const materialRows = db.prepare(`
        SELECT me.entry_date, me.employee_name,
               m.name || CASE WHEN m.article IS NOT NULL THEN ' (' || m.article || ')' ELSE '' END AS material_name,
               me.quantity, me.comment, me.created_at
        FROM material_entries me
        JOIN materials m ON m.id = me.material_id
        WHERE me.stage = ? AND me.entry_date BETWEEN ? AND ?
        ORDER BY me.entry_date, me.created_at
      `).all(stage.code, from, to);

      materialRows.forEach(r => {
        sheet.addRow({
          entry_date: r.entry_date,
          employee_name: r.employee_name,
          material_name: r.material_name,
          quantity: r.quantity,
          comment: r.comment || '',
          created_at: r.created_at,
        });
      });
      continue;
    }

    if (stage.formType === 'photo') {
      sheet.columns = [
        { header: 'Дата', key: 'entry_date', width: 12 },
        { header: 'Сотрудник', key: 'employee_name', width: 22 },
        { header: 'Комментарий', key: 'caption', width: 35 },
        { header: 'Время', key: 'created_at', width: 18 },
      ];
      sheet.getRow(1).eachCell(c => { c.fill = headerFill; c.font = { bold: true }; });

      const photoRows = db.prepare(`
        SELECT entry_date, employee_name, caption, created_at
        FROM intake_photos
        WHERE entry_date BETWEEN ? AND ?
        ORDER BY entry_date, created_at
      `).all(from, to);

      photoRows.forEach(r => {
        sheet.addRow({
          entry_date: r.entry_date,
          employee_name: r.employee_name,
          caption: r.caption || '',
          created_at: r.created_at,
        });
      });
      continue;
    }

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

  return workbook;
}

function reportFilename(from, to) {
  return from === to ? `otchet_${from}.xlsx` : `otchet_${from}_${to}.xlsx`;
}

module.exports = { buildReportWorkbook, reportFilename };
