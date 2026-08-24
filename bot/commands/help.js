module.exports = function registerHelpCommand(bot, { getAds, Markup }) {
  bot.help(async (ctx) => {
    const ads = await getAds();
    let text =
      `📋 *Mavjud komandalar:*\n\n` +
      `/start — Botni boshlash\n` +
      `/help — Shu yordam xabari\n` +
      `/stats — Bazadagi modellar statistikasi\n` +
      `/random — Bazadan tasodifiy model\n` +
      `/refresh — Katalogni yangilash (yangi modellar)\n` +
      `/admin — Admin paneli\n\n` +
      `📸 *Qidiruv usullari:*\n` +
      `• Rasm yuboring — o'xshash 3D modellar topiladi\n` +
      `• Matn yozing — tavsif bo'yicha qidiruv\n\n` +
      `💡 *Maslahat:* Aniqroq rasm yuborsangiz, natija ham aniqroq bo'ladi!`;

    if (ads.length > 0) {
      text += `\n\n📢 *Reklamalar:*\n`;
    }

    ctx.reply(text, { parse_mode: 'Markdown' });
  });
};
