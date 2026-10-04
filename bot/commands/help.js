module.exports = function registerHelpCommand(bot) {
  bot.help(async (ctx) => {
    let text =
      `📋 *Mavjud komandalar:*\n\n` +
      `/start — Botni boshlash\n` +
      `/help — Shu yordam xabari\n` +
      `/stats — Bazadagi modellar statistikasi\n` +
      `/random — Bazadan tasodifiy model\n` +
      `/refresh — Katalogni yangilash (yangi modellar)\n\n` +
      `📸 *Qidiruv usullari:*\n` +
      `• Rasm yuboring — o'xshash 3D modellar topiladi\n` +
      `• Matn yozing — tavsif bo'yicha qidiruv\n\n` +
      `💡 *Maslahat:* Aniqroq rasm yuborsangiz, natija ham aniqroq bo'ladi!`;

    ctx.reply(text, { parse_mode: 'Markdown' });
  });
};
