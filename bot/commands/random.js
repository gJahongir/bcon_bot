const { t, lang } = require('../services/i18n');

module.exports = function registerRandomCommand(bot, { getRandomModel }) {
  const sendRandom = async (ctx) => {
    const userLang = lang(ctx);
    try {
      const model = await getRandomModel();
      if (!model) {
        return ctx.reply(t(userLang, 'random_empty'));
      }

      try {
        await ctx.telegram.forwardMessage(ctx.chat.id, `@${model.channelUsername}`, model.messageId);
      } catch (fwdErr) {
        console.warn(`Forward xatoligi (random): ${fwdErr.message}`);
      }

      let text = t(userLang, 'random_title', {
        name: model.documentFileName,
        channel: model.channelUsername
      });

      if (model.category) text += t(userLang, 'random_category', { category: model.category });
      if (model.tags && model.tags.length > 0) text += t(userLang, 'random_tags', { tags: model.tags.join(', ') });
      if (model.caption) text += `\n📝 ${model.caption.substring(0, 200)}`;

      await ctx.reply(text, { parse_mode: 'Markdown' });
    } catch (err) {
      console.error('/random xatoligi:', err);
      await ctx.reply(t(userLang, 'random_error'));
    }
  };

  bot.command('random', sendRandom);

  // Start klaviaturasidagi "Tasodifiy model" tugmasi
  bot.action('start_random', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    await sendRandom(ctx);
  });
};
