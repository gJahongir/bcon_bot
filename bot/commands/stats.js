module.exports = function registerStatsCommand(bot, { getStats, getCatalogInfo }) {
  bot.command('stats', async (ctx) => {
    try {
      const stats = await getStats();
      const catalogInfo = getCatalogInfo();

      let text =
        `📊 <b>Bcin Statistika</b>\n\n` +
        `📦 Jami modellar: <b>${stats.totalModels}</b>\n` +
        `🧬 Embedding tayyor: <b>${stats.withEmbedding}</b>\n` +
        `📡 Kanallar soni: <b>${stats.channels.length}</b>\n`;

      if (stats.channels.length > 0) {
        text += `\n📡 <b>Kanallar:</b>\n`;
        text += stats.channels.map((ch) => `  • @${ch}`).join('\n');
      }

      if (Object.keys(stats.categories).length > 0) {
        text += `\n\n🏷 <b>Kategoriyalar:</b>\n`;
        for (const [cat, count] of Object.entries(stats.categories)) {
          text += `  • ${cat}: ${count} ta\n`;
        }
      }

      if (catalogInfo.loaded) {
        text += `\n🧠 Xotiradagi katalog: <b>${catalogInfo.count}</b> ta model`;
        if (catalogInfo.lastLoadTime) {
          text += `\n⏰ Oxirgi yuklash: ${catalogInfo.lastLoadTime.toLocaleString('uz-UZ')}`;
        }
      }

      ctx.reply(text, { parse_mode: 'HTML' });
    } catch (err) {
      console.error('/stats xatoligi:', err);
      ctx.reply('❌ Statistikani olishda xatolik yuz berdi.');
    }
  });
};
