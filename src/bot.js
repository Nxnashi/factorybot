const TelegramBot = require('node-telegram-bot-api').default;
const { db, STAGES } = require('./db');

const token = process.env.BOT_TOKEN;
const webAppUrl = process.env.WEBAPP_URL; // например https://factory-tracker.onrender.com

const bot = new TelegramBot(token, { polling: true });

function isAdmin(telegramId) {
  const user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(String(telegramId));
  return !!(user && user.is_admin);
}

bot.onText(/\/start/i, (msg) => {
  const chatId = msg.chat.id;
  const user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(String(msg.from.id));

  if (!user) {
    bot.sendMessage(chatId,
      `Привет! Твой Telegram ID: ${msg.from.id}\n\nТы ещё не зарегистрирован в системе учёта. Передай этот ID администратору, чтобы он назначил тебе этап работы.`
    );
    return;
  }

  bot.sendMessage(chatId, `Привет, ${user.full_name}! Твой этап: открой приложение ниже, чтобы внести данные.`, {
    reply_markup: {
      inline_keyboard: [[
        { text: '📋 Внести данные', web_app: { url: webAppUrl } }
      ]]
    }
  });
});

bot.onText(/\/admin/i, (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(msg.from.id)) {
    bot.sendMessage(chatId, 'Эта команда только для администраторов.');
    return;
  }
  bot.sendMessage(chatId, 'Панель администратора: сотрудники, номенклатура, экспорт отчётов.', {
    reply_markup: {
      inline_keyboard: [[
        { text: '⚙️ Открыть админку', web_app: { url: `${webAppUrl}/admin.html` } }
      ]]
    }
  });
});

bot.onText(/\/myid/i, (msg) => {
  bot.sendMessage(msg.chat.id, `Твой Telegram ID: ${msg.from.id}`);
});

console.log('Telegram bot started (polling)');

module.exports = bot;
