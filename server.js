require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const stagesRouter = require('./routes/stages');
const adminRouter = require('./routes/admin');
const exportRouter = require('./routes/export');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api', stagesRouter);
app.use('/api/admin', adminRouter);
app.use('/api/export', exportRouter);

app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Factory tracker running on port ${PORT}`));

// Бот и планировщик отчётов запускаем в этом же процессе, если задан токен
if (process.env.BOT_TOKEN) {
  const bot = require('./src/bot');
  const { startScheduler } = require('./src/scheduler');
  startScheduler(bot);
}
