module.exports = function registerAdminCommand(bot, { isAdminUser, getAdminMenuKeyboard }) {
  bot.command('admin', async (ctx) => {
    const isAdmin = await isAdminUser(ctx.from.id);
    if (!isAdmin) {
      return ctx.reply('⛔ Siz admin emasiz.');
    }

    await ctx.reply('🛠️ Admin paneli', {
      reply_markup: getAdminMenuKeyboard().reply_markup
    });
  });
};
