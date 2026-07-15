const cron = require('node-cron');
const { db } = require('./db');
const { buildReportWorkbook, reportFilename } = require('./reportGenerator');

// Во сколько присылать отчёт (по умолчанию 20:00) и в каком часовом поясе
const REPORT_TIME = process.env.REPORT_TIME || '20:00';
const REPORT_TIMEZONE = process.env.REPORT_TIMEZONE || 'Asia/Tashkent';

function parseTimeToCron(time) {
  const [hour, minute] = time.split(':').map(Number);
  return `${minute} ${hour} * * *`;
}

async function sendDailyReport(bot) {
  const today = new Date().toISOString().slice(0, 10);
  const admins = db.prepare('SELECT telegram_id FROM users WHERE is_admin = 1').all();

  if (admins.length === 0) {
    console.log('Автоотправка: нет ни одного администратора, отчёт некому слать');
    return;
  }

  const hasEntries = db.prepare('SELECT COUNT(*) AS c FROM entries WHERE entry_date = ?').get(today).c;
  if (hasEntries === 0) {
    console.log(`Автоотправка: за ${today} нет ни одной записи, отчёт не отправляется`);
    return;
  }

  const workbook = await buildReportWorkbook(today, today);
  const buffer = await workbook.xlsx.writeBuffer();
  const filename = reportFilename(today, today);

  for (const admin of admins) {
    try {
      await bot.sendDocument(
        admin.telegram_id,
        Buffer.from(buffer),
        { caption: `Отчёт по производству за ${today}` },
        { filename, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }
      );
    } catch (err) {
      console.error(`Не удалось отправить отчёт админу ${admin.telegram_id}:`, err.message);
    }
  }
  console.log(`Автоотправка: отчёт за ${today} разослан ${admins.length} администратор(ам)`);
}

function startScheduler(bot) {
  const cronPattern = parseTimeToCron(REPORT_TIME);
  cron.schedule(cronPattern, () => sendDailyReport(bot), { timezone: REPORT_TIMEZONE });
  console.log(`Планировщик отчётов запущен: каждый день в ${REPORT_TIME} (${REPORT_TIMEZONE})`);
}

module.exports = { startScheduler, sendDailyReport };
