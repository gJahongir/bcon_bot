module.exports = function registerRandomCommand(bot, { getRandomModel }) {
  bot.command('random', async (ctx) => {
    try {
      const model = await getRandomModel();
      if (!model) {
        return ctx.reply('😕 Bazada hali hech qanday model yo\'q.');
      }

      try {
        await ctx.telegram.forwardMessage(ctx.chat.id, `@${model.channelUsername}`, model.messageId);
      } catch (fwdErr) {
        console.warn(`Forward xatoligi (random): ${fwdErr.message}`);
      }

      let text =
        `🎲 *Tasodifiy model:*\n\n` +
        `📦 ${model.documentFileName}\n` +
        `📡 Manba: @${model.channelUsername}`;

      if (model.category) text += `\n🏷 Kategoriya: ${model.category}`;
      if (model.tags && model.tags.length > 0) text += `\n🔖 Teglar: ${model.tags.join(', ')}`;
      if (model.caption) text += `\n📝 ${model.caption.substring(0, 200)}`;

      ctx.reply(text, { parse_mode: 'Markdown' });
    } catch (err) {
      console.error('/random xatoligi:', err);
      ctx.reply('❌ Tasodifiy model olishda xatolik yuz berdi.');
    }
  });
};
