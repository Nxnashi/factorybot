// Время и дата по часовому поясу завода (Ташкент по умолчанию), а не по UTC сервера
const TZ = () => process.env.REPORT_TIMEZONE || 'Asia/Tashkent';

function parts(d = new Date()) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ(), year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  const o = {};
  for (const p of f.formatToParts(d)) o[p.type] = p.value;
  return o;
}
function todayLocal() { const p = parts(); return `${p.year}-${p.month}-${p.day}`; }
function nowLocal() { const p = parts(); return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`; }

module.exports = { todayLocal, nowLocal };
