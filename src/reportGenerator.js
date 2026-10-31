const ExcelJS = require('exceljs');
const { db, STAGES } = require('./db');
const { buildMixingMatrix } = require('./mixing');

const headerFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } };
const STATUS_LABELS = { completed: 'Завершён', in_progress: 'В процессе', cancelled: 'Отменён' };
const POSTING_STATUS = { posted: 'Проведено', cancelled: 'Отменено' };

function styleHeader(sheet, rowNumber = 1) {
  sheet.getRow(rowNumber).eachCell(c => { c.fill = headerFill; c.font = { bold: true }; });
}
const time = ts => (ts ? String(ts).slice(11, 16) : '');

// Колонки по этапам (повторяют документы 1С)
const DOC_COLUMNS = {
  molding: [
    { header: 'Линия', key: 'line_no', width: 8 },
    { header: 'Залито, шт', key: 'qty_total', width: 12 },
    { header: 'Годных, шт', key: 'quantity', width: 12 },
    { header: 'Возврат в глину, шт', key: 'qty_defect', width: 18 },
  ],
  fettling: [
    { header: 'Общее количество', key: 'qty_total', width: 16 },
    { header: 'Брак', key: 'qty_defect', width: 10 },
    { header: 'Квалифицированное количество', key: 'quantity', width: 26 },
  ],
  glazing: [
    { header: 'Общее количество', key: 'qty_total', width: 16 },
    { header: 'Брак', key: 'qty_defect', width: 10 },
    { header: 'Квалифицированное количество', key: 'quantity', width: 26 },
  ],
  kiln: [
    { header: 'Вагон', key: 'wagon_no', width: 8 },
    { header: 'Количество, шт', key: 'quantity', width: 14 },
  ],
  sorting: [
    { header: 'Сорт-1', key: 'qty_s1', width: 10 },
    { header: 'Сорт-2', key: 'qty_s2', width: 10 },
    { header: 'Ремонт', key: 'qty_repair', width: 10 },
    { header: 'Брак/Бой', key: 'qty_defect', width: 10 },
  ],
  finished: [
    { header: 'Сорт', key: 'grade', width: 8 },
    { header: 'Количество, шт', key: 'quantity', width: 14 },
  ],
};

async function buildReportWorkbook(from, to) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Factory Tracker';
  workbook.created = new Date();

  const stageTitleByCode = Object.fromEntries(STAGES.map(s => [s.code, s.title]));

  const allRows = db.prepare(`
    SELECT e.*, n.name || CASE WHEN n.article IS NOT NULL THEN ' (' || n.article || ')' ELSE '' END AS nomenclature_name
    FROM entries e
    JOIN nomenclature n ON n.id = e.nomenclature_id
    WHERE e.entry_date BETWEEN ? AND ?
    ORDER BY e.entry_date, e.stage, e.created_at, e.id
  `).all(from, to);

  // --- Сводка: все документы по порядку этапов ---
  const summary = workbook.addWorksheet('Сводка');
  summary.columns = [
    { header: 'Код операции', key: 'op_code', width: 20 },
    { header: 'Дата', key: 'entry_date', width: 12 },
    { header: 'Время', key: 'time', width: 8 },
    { header: 'Этап', key: 'stage_title', width: 20 },
    { header: 'Сотрудник', key: 'employee_name', width: 22 },
    { header: 'Старший', key: 'entered_by', width: 20 },
    { header: 'Модель', key: 'nomenclature_name', width: 30 },
    { header: 'Линия / вагон', key: 'place', width: 13 },
    { header: 'Всего', key: 'qty_total', width: 10 },
    { header: 'Годных / вышло', key: 'quantity', width: 15 },
    { header: 'Брак / возврат', key: 'qty_defect', width: 14 },
    { header: 'Ремонт', key: 'qty_repair', width: 10 },
    { header: 'Сорт-1', key: 'qty_s1', width: 8 },
    { header: 'Сорт-2', key: 'qty_s2', width: 8 },
    { header: 'Сорт', key: 'grade', width: 8 },
    { header: 'Комментарий', key: 'comment', width: 25 },
  ];
  styleHeader(summary);
  const orderIndex = Object.fromEntries(STAGES.map((s, i) => [s.code, i]));
  [...allRows]
    .sort((a, b) => a.entry_date.localeCompare(b.entry_date) || (orderIndex[a.stage] ?? 99) - (orderIndex[b.stage] ?? 99) || a.id - b.id)
    .forEach(r => summary.addRow({
      ...r,
      time: time(r.created_at),
      stage_title: stageTitleByCode[r.stage] || r.stage,
      entered_by: r.entered_by || '',
      place: r.line_no ? `Линия ${r.line_no}` : (r.wagon_no ? `Вагон ${r.wagon_no}` : ''),
      comment: r.comment || '',
    }));

  // --- Листы по этапам ---
  for (const stage of STAGES) {
    const sheet = workbook.addWorksheet(stage.title.slice(0, 31));

    if (stage.formType === 'materials') {
      // Матрица как в 1С: Замес 1..N + Сумма, отдельный блок на дату и барабан
      const groups = buildMixingMatrix(stage.code, from, to);
      sheet.getColumn(1).width = 12;
      sheet.getColumn(2).width = 44;
      for (let c = 3; c <= 12; c++) sheet.getColumn(c).width = 16;

      if (groups.length === 0) sheet.addRow(['За выбранный период замесов нет']);
      for (const g of groups) {
        const title = sheet.addRow([`Дата ${g.entry_date} · Барабан №${g.drum_number}`]);
        title.font = { bold: true, size: 12 };
        const head = sheet.addRow(['Код', 'Номенклатура', ...g.batches.map(b => `Замес ${b.batch_no}`), 'Сумма']);
        styleHeader(sheet, head.number);
        const codeRow = sheet.addRow(['', 'Код замеса', ...g.batches.map(b => b.code || ''), '']);
        codeRow.font = { italic: true, color: { argb: 'FF666666' } };
        sheet.addRow(['', 'Время / сотрудник', ...g.batches.map(b => `${b.time} · ${b.employee_name}`), '']).font = { italic: true, color: { argb: 'FF666666' } };
        for (const r of g.rows) {
          if (r.sum === 0) continue;
          sheet.addRow([r.article || '', r.name, ...r.values.map(v => v || ''), r.sum]);
        }
        const totalRow = sheet.addRow(['', 'Итого сырья, кг', ...g.totals, g.totals_sum]);
        totalRow.font = { bold: true };
        const outRow = sheet.addRow(['', 'Итого вес замеса, кг', ...g.batches.map(b => (b.output_quantity == null ? STATUS_LABELS[b.status] || '' : b.output_quantity)), g.output_sum]);
        if (g.batches.some(b => b.output_quantity != null && b.calc_quantity != null && b.output_quantity !== b.calc_quantity)) {
          sheet.addRow(['', 'Исправлено вручную (авто)', ...g.batches.map(b => (b.output_quantity != null && b.calc_quantity != null && b.output_quantity !== b.calc_quantity ? `авто ${b.calc_quantity}` : '')), '']).font = { italic: true, color: { argb: 'FFB3372C' } };
        }
        outRow.font = { bold: true };
        sheet.addRow([]);
      }
      continue;
    }

    sheet.columns = [
      { header: 'Код операции', key: 'op_code', width: 20 },
      { header: 'Дата', key: 'entry_date', width: 12 },
      { header: 'Время', key: 'time', width: 8 },
      { header: 'Сотрудник', key: 'employee_name', width: 22 },
      { header: 'Старший', key: 'entered_by', width: 20 },
      { header: 'Модель', key: 'nomenclature_name', width: 32 },
      ...(DOC_COLUMNS[stage.code] || []),
      { header: 'Комментарий', key: 'comment', width: 25 },
    ];
    styleHeader(sheet);
    allRows.filter(r => r.stage === stage.code).forEach(r => sheet.addRow({
      ...r, time: time(r.created_at), entered_by: r.entered_by || '', comment: r.comment || '',
    }));
  }

  // --- Журнал проводок ---
  const journal = workbook.addWorksheet('Журнал проводок');
  journal.columns = [
    { header: 'Код', key: 'op_code', width: 22 },
    { header: 'Родитель (замес)', key: 'parent_code', width: 22 },
    { header: 'Дата', key: 'entry_date', width: 12 },
    { header: 'Дата и время проводки', key: 'created_at', width: 20 },
    { header: 'Этап', key: 'stage_title', width: 20 },
    { header: 'Сотрудник', key: 'actor_name', width: 22 },
    { header: 'Старший', key: 'entered_by', width: 20 },
    { header: 'Содержание', key: 'summary', width: 70 },
    { header: 'Кол-во', key: 'qty', width: 10 },
    { header: 'Статус', key: 'status_label', width: 12 },
    { header: 'Отменил', key: 'cancelled_by', width: 18 },
    { header: 'Когда отменено', key: 'cancelled_at', width: 20 },
  ];
  styleHeader(journal);
  db.prepare('SELECT * FROM postings WHERE entry_date BETWEEN ? AND ? ORDER BY created_at, id').all(from, to).forEach(p => {
    journal.addRow({
      ...p,
      stage_title: stageTitleByCode[p.stage] || p.stage,
      status_label: POSTING_STATUS[p.status] || p.status,
      parent_code: p.parent_code || '', entered_by: p.entered_by || '', cancelled_by: p.cancelled_by || '', cancelled_at: p.cancelled_at || '',
    });
  });

  return workbook;
}

function reportFilename(from, to) {
  return from === to ? `otchet_${from}.xlsx` : `otchet_${from}_${to}.xlsx`;
}

module.exports = { buildReportWorkbook, reportFilename };
