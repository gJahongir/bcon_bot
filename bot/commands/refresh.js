module.exports = function registerRefreshCommand(bot, { refreshCatalog, getCatalogInfo }) {
  bot.command('refresh', async (ctx) => {
    try {
      const msg = await ctx.reply('🔄 Katalog yangilanmoqda...');
      const added = await refreshCatalog();
      const info = getCatalogInfo();
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        msg.message_id,
        null,
        `✅ Katalog yangilandi!\n\n` +
        `➕ Yangi qo'shildi: ${added} ta\n` +
        `📦 Jami xotirada: ${info.count} ta model`
      );
    } catch (err) {
      console.error('/refresh xatoligi:', err);
      ctx.reply('❌ Katalogni yangilashda xatolik yuz berdi.');
    }
  });
};
