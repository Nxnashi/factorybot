const cron = require('node-cron');
const { db, STAGES } = require('./db');
const { buildReportWorkbook, reportFilename } = require('./reportGenerator');

function getStageMeta(code) {
  return STAGES.find(s => s.code === code);
}

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

const REMINDER_TIME = process.env.REMINDER_TIME || '18:00';
const REMINDER_TIMEZONE = process.env.REMINDER_TIMEZONE || REPORT_TIMEZONE;

async function checkAndSendReminders(bot) {
  const today = new Date().toISOString().slice(0, 10);
  const workers = db.prepare('SELECT telegram_id, full_name, stage FROM users WHERE is_admin = 0').all();
  const admins = db.prepare('SELECT telegram_id FROM users WHERE is_admin = 1').all();

  const missingSummary = [];

  for (const worker of workers) {
    const assignedStages = String(worker.stage).split(',').map(s => s.trim()).filter(Boolean);
    const submittedStages = db.prepare(
      'SELECT DISTINCT stage FROM entries WHERE telegram_id = ? AND entry_date = ?'
    ).all(worker.telegram_id, today).map(r => r.stage);

    const missingCodes = assignedStages.filter(code => !submittedStages.includes(code));
    if (missingCodes.length === 0) continue;

    const missingTitles = missingCodes.map(code => (getStageMeta(code) || {}).title || code);
    missingSummary.push({ name: worker.full_name, titles: missingTitles });

    try {
      await bot.sendMessage(
        worker.telegram_id,
        `Напоминание: сегодня (${today}) ты ещё не внёс данные по этапу(ам): ${missingTitles.join(', ')}. Не забудь до конца смены!`
      );
    } catch (err) {
      console.error(`Не удалось отправить напоминание сотруднику ${worker.telegram_id}:`, err.message);
    }
  }

  if (admins.length === 0) return;

  const summaryText = missingSummary.length === 0
    ? `На ${today} все сотрудники уже всё внесли ✅`
    : `Не все внесли данные за ${today}:\n` + missingSummary.map(m => `— ${m.name}: ${m.titles.join(', ')}`).join('\n');

  for (const admin of admins) {
    try {
      await bot.sendMessage(admin.telegram_id, summaryText);
    } catch (err) {
      console.error(`Не удалось отправить сводку админу ${admin.telegram_id}:`, err.message);
    }
  }
}

function startScheduler(bot) {
  const reportCronPattern = parseTimeToCron(REPORT_TIME);
  cron.schedule(reportCronPattern, () => sendDailyReport(bot), { timezone: REPORT_TIMEZONE });
  console.log(`Планировщик отчётов запущен: каждый день в ${REPORT_TIME} (${REPORT_TIMEZONE})`);

  const reminderCronPattern = parseTimeToCron(REMINDER_TIME);
  cron.schedule(reminderCronPattern, () => checkAndSendReminders(bot), { timezone: REMINDER_TIMEZONE });
  console.log(`Планировщик напоминаний запущен: каждый день в ${REMINDER_TIME} (${REMINDER_TIMEZONE})`);
}

module.exports = { startScheduler, sendDailyReport, checkAndSendReminders };
