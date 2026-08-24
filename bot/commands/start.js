module.exports = function registerStartCommand(bot, { trackStartedUser, Markup }) {
  bot.start((ctx) => {
    const userId = Number(ctx.from?.id || 0);
    trackStartedUser(userId);

    const name = ctx.from.first_name || 'do\'stim';
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('🆘 Yordam', 'start_help')],
      [Markup.button.callback('📊 Statistika', 'start_stats')],
      [Markup.button.callback('🎲 Tasodifiy model', 'start_random')]
    ]);

    ctx.reply(
      `Salom, ${name}! 👋\n\n` +
      `🤖 Men *Bcon bot* — 3D modellar qidiruv yordamchisiman.\n\n` +
      `📸 *Rasm yuborib qidiring:*\n` +
      `Menga istalgan 3D model rasmini yuboring — men bazamdan o'xshash modellarni topib, arxiv faylini yuboraman.\n\n`,
      { parse_mode: 'Markdown', ...keyboard }
    );
  });
};
