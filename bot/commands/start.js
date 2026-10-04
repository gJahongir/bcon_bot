const { Markup } = require('telegraf');
const { LANGUAGES, t, lang, isValidLanguage } = require('../services/i18n');
const { setLanguage } = require('../services/userService');

/**
 * Til tanlash klaviaturasi — 11 til, har qatorda 2 tadan.
 */
function languageKeyboard() {
  const rows = [];
  for (let i = 0; i < LANGUAGES.length; i += 2) {
    const row = LANGUAGES
      .slice(i, i + 2)
      .map((l) => Markup.button.callback(`${l.flag} ${l.name}`, `setlang:${l.code}`));
    rows.push(row);
  }
  return Markup.inlineKeyboard(rows);
}

/**
 * Asosiy menyu klaviaturasi (foydalanuvchi tilida).
 */
function mainKeyboard(userLang) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback(t(userLang, 'btn_help'), 'start_help'),
      Markup.button.callback(t(userLang, 'btn_stats'), 'start_stats')
    ],
    [Markup.button.callback(t(userLang, 'btn_random'), 'start_random')],
    [Markup.button.callback(t(userLang, 'btn_change_language'), 'start_lang')]
  ]);
}

/**
 * Xush kelibsiz xabarini yuboradi.
 */
async function sendWelcome(ctx, userLang) {
  const name = ctx.from.first_name || 'do\'stim';
  await ctx.reply(t(userLang, 'welcome', { name }), {
    parse_mode: 'Markdown',
    ...mainKeyboard(userLang)
  });
}

module.exports = function registerStartCommand(bot) {
  // /start — tili tanlanmagan bo'lsa avval til tanlash, aks holda xush kelibsiz xabari
  bot.start(async (ctx) => {
    const userLang = lang(ctx);
    const hasLanguage = !!(ctx.state.userDoc && ctx.state.userDoc.language);

    if (!hasLanguage) {
      await ctx.reply(t('uz', 'choose_language'), languageKeyboard());
      return;
    }

    await sendWelcome(ctx, userLang);
  });

  // /language — istalgan vaqtda tilni o'zgartirish
  bot.command('language', async (ctx) => {
    await ctx.reply(t('uz', 'choose_language'), languageKeyboard());
  });

  // Start klaviaturasidagi "Tilni o'zgartirish" tugmasi
  bot.action('start_lang', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    await ctx.reply(t('uz', 'choose_language'), languageKeyboard());
  });

  // Til tanlandi — saqlaymiz va xush kelibsiz xabarini ko'rsatamiz
  bot.action(/^setlang:(\w+)$/, async (ctx) => {
    const code = ctx.match[1];
    if (!isValidLanguage(code)) {
      return ctx.answerCbQuery('⚠️').catch(() => {});
    }

    await setLanguage(ctx.from.id, code).catch(() => {});

    // Kontekstdagi hujjatni ham yangilaymiz — keyingi handler'lar yangi tilni ko'radi
    if (ctx.state.userDoc) {
      ctx.state.userDoc.language = code;
    }

    await ctx.answerCbQuery(t(code, 'language_set')).catch(() => {});

    const name = ctx.from.first_name || 'do\'stim';
    await ctx.editMessageText(t(code, 'welcome', { name }), {
      parse_mode: 'Markdown',
      ...mainKeyboard(code)
    }).catch(async () => {
      await sendWelcome(ctx, code);
    });
  });
};
