const { t, lang } = require('../services/i18n');

module.exports = function registerStatsCommand(bot, { getStats, getCatalogInfo }) {
  const sendStats = async (ctx) => {
    const userLang = lang(ctx);
    try {
      const stats = await getStats();
      const catalogInfo = getCatalogInfo();

      let text = t(userLang, 'stats_title');
      text += t(userLang, 'stats_total_models', { count: stats.totalModels });
      text += t(userLang, 'stats_embeddings', { count: stats.withEmbedding });
      text += t(userLang, 'stats_channels_count', { count: stats.channels.length });

      if (stats.channels.length > 0) {
        text += t(userLang, 'stats_channels_title');
        text += stats.channels.map((ch) => `  • @${ch}`).join('\n');
      }

      if (Object.keys(stats.categories).length > 0) {
        text += t(userLang, 'stats_categories_title');
        for (const [cat, count] of Object.entries(stats.categories)) {
          text += `  • ${cat}: ${count}\n`;
        }
      }

      if (catalogInfo.loaded) {
        text += t(userLang, 'stats_catalog', { count: catalogInfo.count });
        if (catalogInfo.lastLoadTime) {
          text += t(userLang, 'stats_last_load', { time: catalogInfo.lastLoadTime.toLocaleString('uz-UZ') });
        }
      }

      await ctx.reply(text, { parse_mode: 'HTML' });
    } catch (err) {
      console.error('/stats xatoligi:', err);
      await ctx.reply(t(userLang, 'stats_error'));
    }
  };

  bot.command('stats', sendStats);

  // Start klaviaturasidagi "Statistika" tugmasi
  bot.action('start_stats', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    await sendStats(ctx);
  });
};
