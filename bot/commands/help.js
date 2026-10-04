const { t, lang } = require('../services/i18n');

module.exports = function registerHelpCommand(bot) {
  const sendHelp = async (ctx) => {
    await ctx.reply(t(lang(ctx), 'help_text'), { parse_mode: 'Markdown' });
  };

  bot.help(sendHelp);

  // Start klaviaturasidagi "Yordam" tugmasi
  bot.action('start_help', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    await sendHelp(ctx);
  });
};
