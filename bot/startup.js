const mongoose = require('mongoose');
const { bot } = require('./index');
const { loadCatalog } = require('./services/vectorSearch');
const { preloadModels } = require('./services/clipClient');
const { initializeAdminConfig } = require('./services/adminService');
const { acquireSingleInstanceLock, releaseSingleInstanceLock } = require('./singleInstance');

/**
 * Telegraf botini bir nechta urinish bilan ishga tushiradi.
 * Agar token boshqa getUpdates so'rovi bilan band bo'lsa,
 * foydalanuvchiga aniq xabar beradi.
 */
async function launchBotWithRetry(maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await bot.launch({ dropPendingUpdates: true });
      console.log('');
      console.log('═══════════════════════════════════════════');
      console.log('  🤖 Bcin Bot ishga tushdi!');
      console.log('  📸 Rasm qidiruv ✅');
      console.log('  ✍️  Matn qidiruv ✅');
      console.log('  🧩 Model preview flow ✅');
      console.log('  📊 Statistika ✅');
      console.log('═══════════════════════════════════════════');
      console.log('');
      return;
    } catch (err) {
      const isTelegramConflict = err?.response?.error_code === 409
        && /getUpdates|terminated by other/i.test(err?.message || '');

      if (isTelegramConflict) {
        console.error('⚠️ Telegram polling xatoligi: ushbu bot token bilan boshqa nusxa allaqachon ishlamoqda.');
        console.error('   Avval oldingi bot/processni to‘xtating, so‘ngra qayta ishga tushiring.');
      } else {
        console.warn(`⚠️ Telegraf launch urinishi ${attempt}/${maxAttempts} muvaffaqiyatsiz: ${err.message}`);
      }

      if (attempt === maxAttempts) {
        throw err;
      }

      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

async function main() {
  if (!acquireSingleInstanceLock()) {
    console.error('❌ Bot allaqachon ishlamoqda. Bitta nusxa faqat bitta jarayon bo‘lishi kerak.');
    process.exit(1);
  }

  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ MongoDB ulandi');
    await initializeAdminConfig();
    console.log('✅ Admin konfiguratsiyasi tayyorlandi');
  } catch (err) {
    console.error('❌ MongoDB ulanishida xatolik:', err.message);
    process.exit(1);
  }

  try {
    const count = await loadCatalog(true);
    console.log(`📦 Katalogda ${count} ta model tayyor`);
  } catch (err) {
    console.error('⚠️ Katalog yuklanmadi (bot ishlashda davom etadi):', err.message);
  }

  await preloadModels();
  await launchBotWithRetry();
}

function cleanupAndExit(code = 0) {
  releaseSingleInstanceLock();
  process.exit(code);
}

process.once('SIGINT', () => {
  try { bot.stop('SIGINT'); } catch (e) { }
  cleanupAndExit(0);
});
process.once('SIGTERM', () => {
  try { bot.stop('SIGTERM'); } catch (e) { }
  cleanupAndExit(0);
});

module.exports = { main };
