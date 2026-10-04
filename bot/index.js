require('dotenv').config();
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const mongoose = require('mongoose');
const axios = require('axios');
const { Telegraf, Markup } = require('telegraf');

const { getImageEmbedding, getTextEmbedding, preloadModels } = require('./services/clipClient');
const { loadCatalog, findBestMatches, findTextMatches, refreshCatalog, getCatalogInfo, removeFromCatalog, updateCatalogItem } = require('./services/vectorSearch');
const { describeImage, analyzeTextQuery } = require('./services/cloudflareAi');
const { searchCGTrader } = require('./services/cgtraderSearch');
const { createSession, getSession, getCurrentPage, nextPage, prevPage } = require('./services/userSession');
const { t, lang } = require('./services/i18n');
const { getStats, getRandomModel, incrementSearchCounts } = require('./services/statsService');
const { acquireSingleInstanceLock, releaseSingleInstanceLock } = require('./singleInstance');

const registerStartCommand = require('./commands/start');
const registerHelpCommand = require('./commands/help');
const registerStatsCommand = require('./commands/stats');
const registerRandomCommand = require('./commands/random');
const registerRefreshCommand = require('./commands/refresh');
const registerAdminCommand = require('./commands/admin');

if (!process.env.BOT_TOKEN) {
  console.error('❌ BOT_TOKEN topilmadi. .env faylini tekshiring.');
  process.exit(1);
}
if (!process.env.MONGODB_URI) {
  console.error('❌ MONGODB_URI topilmadi. .env faylini tekshiring.');
  process.exit(1);
}

const axiosInstance = axios.create({
  timeout: 60000,
  httpAgent: new http.Agent({ keepAlive: true, family: 4 }),
  httpsAgent: new https.Agent({ keepAlive: true, keepAliveMsecs: 10000, family: 4 }),
  maxRedirects: 5,
  headers: {
    'User-Agent': 'TheKalonBot/1.0 (+https://github.com)',
    Accept: 'application/octet-stream, image/*'
  }
});

const bot = new Telegraf(process.env.BOT_TOKEN, {
  telegram: {
    apiRoot: 'https://api.telegram.org',
    timeout: 600000,
    agent: new https.Agent({
      family: 4,
      keepAlive: true,
      keepAliveMsecs: 10000,
      lookup: (hostname, options, callback) => {
        dns.lookup(hostname, { family: 4, all: false }, callback);
      }
    })
  },
  handlerTimeout: Infinity
});

// Admin panel BIRINCHI ro'yxatdan o'tadi — foydalanuvchilarni kuzatish,
// blok tekshiruvi va admin wizard xabarlarini qidiruvdan oldin ushlab olish uchun.
registerAdminCommand(bot, { refreshCatalog, getCatalogInfo, loadCatalog, removeFromCatalog, updateCatalogItem });
registerStartCommand(bot);
registerHelpCommand(bot);
registerStatsCommand(bot, { getStats, getCatalogInfo });
registerRandomCommand(bot, { getRandomModel });
registerRefreshCommand(bot, { refreshCatalog, getCatalogInfo });

// ─── Rasm qidiruv ────────────────────────────────────────────────────────────
bot.on('photo', async (ctx) => {
  const statusMsg = await ctx.reply(t(lang(ctx), 'photo_analyzing'));
  let tempImagePath = null;

  try {
    const photos = ctx.message.photo;
    const fileId = photos[photos.length - 1].file_id;
    const fileLink = await ctx.telegram.getFileLink(fileId);

    let imageResponse;
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        imageResponse = await axiosInstance.get(fileLink.href, {
          responseType: 'arraybuffer',
          timeout: 60000 + (attempt * 10000)
        });
        break;
      } catch (err) {
        lastError = err;
        if (attempt < 3) {
          const delay = Math.pow(2, attempt - 1) * 1000;
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }

    if (!imageResponse) {
      throw new Error(`Rasm yuklanib bo'lmadi: ${lastError?.message || 'Noma\'lum xatolik'}`);
    }

    const userLang = lang(ctx);

    tempImagePath = path.join(os.tmpdir(), `grabit3d_query_${ctx.from.id}_${Date.now()}.jpg`);
    fs.writeFileSync(tempImagePath, Buffer.from(imageResponse.data));

    await updateStatus(ctx, statusMsg, t(userLang, 'ai_analyzing'));

    const base64Image = Buffer.from(imageResponse.data).toString('base64');
    const [queryEmbedding, cloudflareResult] = await Promise.allSettled([
      getImageEmbedding(tempImagePath),
      describeImage(base64Image, 'image/jpeg').catch(() => null)
    ]);

    const aiData = cloudflareResult.status === 'fulfilled' ? cloudflareResult.value : null;

    let embedding = null;
    if (queryEmbedding.status === 'fulfilled' && queryEmbedding.value) {
      embedding = queryEmbedding.value;
    } else if (aiData?.englishDescription) {
      embedding = await getTextEmbedding(aiData.englishDescription);
      if (!embedding) {
        const lexicalMatches = await findTextMatches(aiData.englishDescription, 10);
        if (lexicalMatches.length > 0) {
          await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
          createSession(ctx.from.id, lexicalMatches, 'image', aiData.description || '');
          incrementSearchCounts(lexicalMatches.map((m) => m._id)).catch(() => {});
          await sendResultsPage(ctx, ctx.from.id, aiData);
          return;
        }
      }
    }

    if (!embedding) {
      throw new Error('Rasm embedding hisoblashda xatolik. Iltimos, matn bilan qidirib ko\'ring.');
    }

    if (aiData && aiData.description) {
      await updateStatus(ctx, statusMsg, t(userLang, 'found_then_search', { desc: aiData.description }));
    } else {
      await updateStatus(ctx, statusMsg, t(userLang, 'searching_db'));
    }

    // Gibrid qidiruv: 70% rasm + 30% matn embeddingi
    if (aiData && aiData.englishDescription) {
      try {
        const textEmbedding = await getTextEmbedding(aiData.englishDescription);
        if (textEmbedding && textEmbedding.length === embedding.length) {
          const combined = new Float32Array(embedding.length);
          for (let i = 0; i < combined.length; i++) {
            combined[i] = 0.7 * embedding[i] + 0.3 * textEmbedding[i];
          }
          let norm = 0;
          for (let i = 0; i < combined.length; i++) norm += combined[i] * combined[i];
          norm = Math.sqrt(norm);
          if (norm > 0.001) {
            for (let i = 0; i < combined.length; i++) combined[i] /= norm;
            embedding = Array.from(combined);
          }
        }
      } catch (e) {
        console.warn('Gibrid qidiruv xatoligi:', e.message);
      }
    }

    const matches = await findBestMatches(embedding, 50, 0.5);

    if (matches.length === 0) {
      let fallbackText = t(userLang, 'not_found_image');
      if (aiData && aiData.keywords && aiData.keywords.length > 0) {
        await updateStatus(ctx, statusMsg, t(userLang, 'searching_db'));
        const cgResults = await searchCGTrader(aiData.keywords.join(' '), 4);
        if (cgResults.length > 0) {
          fallbackText += t(userLang, 'online_results');
          cgResults.forEach((r, i) => { fallbackText += `\n${i + 1}. [${r.name}](${r.url})`; });
        }
      }
      fallbackText += t(userLang, 'try_another_photo');
      await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null, fallbackText, {
        parse_mode: 'Markdown', disable_web_page_preview: true
      });
      return;
    }

    createSession(ctx.from.id, matches, 'image', aiData?.description || '');
    incrementSearchCounts(matches.map((m) => m._id)).catch(() => {});
    await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
    await sendResultsPage(ctx, ctx.from.id, aiData);

  } catch (error) {
    console.error('Rasm qidiruv xatoligi:', error);
    let errorMsg = t(lang(ctx), 'error_generic');
    if (error.message?.includes('ETIMEDOUT') || error.code === 'ETIMEDOUT') {
      errorMsg = t(lang(ctx), 'error_timeout');
    }
    ctx.reply(errorMsg);
  } finally {
    if (tempImagePath && fs.existsSync(tempImagePath)) {
      fs.unlinkSync(tempImagePath);
    }
  }
});

// ─── Matn qidiruv ───────────────────────────────────────────────────────────
bot.on('text', async (ctx) => {
  if (ctx.message.text.startsWith('/')) return;

  const query = ctx.message.text.trim();
  if (query.length < 2) {
    return ctx.reply(t(lang(ctx), 'min_chars'));
  }
  if (query.length > 200) {
    return ctx.reply(t(lang(ctx), 'too_long'));
  }

  const userLang = lang(ctx);
  const statusMsg = await ctx.reply(t(userLang, 'text_searching'));

  try {
    let searchTerms = query;
    let aiDesc = null;

    try {
      const parsed = await analyzeTextQuery(query);
      if (parsed.english) searchTerms = parsed.english;
      if (parsed.description) aiDesc = parsed.description;
    } catch (cfErr) {
      console.warn('Cloudflare AI tarjima xatoligi:', cfErr.message);
    }

    await updateStatus(ctx, statusMsg, t(userLang, 'searching_terms', { terms: searchTerms }));

    let textEmbedding = null;
    try {
      textEmbedding = await getTextEmbedding(searchTerms);
    } catch (e) {
      try { textEmbedding = await getTextEmbedding(query); } catch (_) {}
    }

    let matches = [];
    if (textEmbedding) {
      try {
        matches = await findBestMatches(textEmbedding, 50, 0.3);
      } catch (e) {
        console.warn('Vektor qidiruv xatoligi:', e.message);
      }
    }

    if (matches.length === 0) {
      matches = await findTextMatches(query, 50);
    }

    if (matches.length === 0) {
      let fallbackText = t(userLang, 'not_found_text', { query });
      const cgResults = await searchCGTrader(searchTerms, 4);
      if (cgResults.length > 0) {
        fallbackText += t(userLang, 'online_results');
        cgResults.forEach((r, i) => { fallbackText += `\n${i + 1}. [${r.name}](${r.url})`; });
      } else {
        fallbackText += t(userLang, 'try_another_word');
      }
      await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null, fallbackText, {
        parse_mode: 'Markdown', disable_web_page_preview: true
      });
      return;
    }

    createSession(ctx.from.id, matches, 'text', aiDesc || query);
    incrementSearchCounts(matches.map((m) => m._id)).catch(() => {});
    await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
    await sendResultsPage(ctx, ctx.from.id, { description: aiDesc });

  } catch (error) {
    console.error('Matn qidiruv xatoligi:', error);
    ctx.reply(t(lang(ctx), 'error_search'));
  }
});

// ─── Inline tugmalar ─────────────────────────────────────────────────────────
bot.on('callback_query', async (ctx) => {
  const data = ctx.callbackQuery.data;

  try {
    if (data === 'next_page') {
      const page = nextPage(ctx.from.id);
      if (!page) return ctx.answerCbQuery(t(lang(ctx), 'session_expired'));
      await ctx.answerCbQuery(t(lang(ctx), 'page_answer', { page: page.page + 1, total: page.totalPages }));
      await sendResultsPage(ctx, ctx.from.id, null, false);
    } else if (data === 'prev_page') {
      const page = prevPage(ctx.from.id);
      if (!page) return ctx.answerCbQuery(t(lang(ctx), 'session_expired'));
      await ctx.answerCbQuery(t(lang(ctx), 'page_answer', { page: page.page + 1, total: page.totalPages }));
      await sendResultsPage(ctx, ctx.from.id, null, false);
    } else if (data.startsWith('download_')) {
      const parts = data.replace(/^download_/, '').split('|');
      if (parts.length < 2) return ctx.answerCbQuery(t(lang(ctx), 'download_params_error'));
      let channelUsername = decodeURIComponent(parts[0]);
      const primaryMessageId = Number(parts[1]);
      if (channelUsername.startsWith('@')) channelUsername = channelUsername.substring(1);
      await ctx.answerCbQuery(t(lang(ctx), 'download_redirect')).catch(() => {});
      await ctx.reply(`${t(lang(ctx), 'download_source')}\nhttps://t.me/${channelUsername}/${primaryMessageId}`);
    }
  } catch (err) {
    console.error('Callback xatoligi:', err);
    ctx.answerCbQuery(t(lang(ctx), 'callback_error')).catch(() => {});
  }
});

// ─── Yordamchi funksiyalar ───────────────────────────────────────────────────
async function sendResultsPage(ctx, userId, aiInfo, isEdit = false) {
  const pageData = getCurrentPage(userId);
  if (!pageData || pageData.items.length === 0) {
    return ctx.reply(t(lang(ctx), 'no_results'));
  }

  const userLang = lang(ctx);
  const match = pageData.items[0];
  const percent = Math.round(match.score * 100);
  const username = match.channelUsername.startsWith('@')
    ? match.channelUsername.substring(1)
    : match.channelUsername;
  const sourceUrl = `https://t.me/${username}/${match.messageId}`;

  let text = '';
  if (!isEdit && aiInfo?.description) {
    text += t(userLang, 'result_ai', { desc: aiInfo.description });
  }
  text += t(userLang, 'result_model', { page: pageData.page + 1, total: pageData.totalPages });
  text += `📦 *${match.documentFileName}*\n`;
  text += t(userLang, 'result_similarity', { percent });
  text += t(userLang, 'result_source', { channel: match.channelUsername });
  if (match.category) text += `🏷 ${match.category}\n`;
  if (match.tags && match.tags.length > 0) {
    text += `🔖 ${match.tags.slice(0, 5).join(', ')}\n`;
  }

  const buttons = [[Markup.button.url(t(userLang, 'btn_download'), sourceUrl)]];
  const navRow = [];
  if (pageData.hasPrev) navRow.push(Markup.button.callback(t(userLang, 'btn_back'), 'prev_page'));
  if (pageData.hasNext) navRow.push(Markup.button.callback(t(userLang, 'btn_next'), 'next_page'));
  if (navRow.length > 0) buttons.push(navRow);

  const keyboard = Markup.inlineKeyboard(buttons);

  const previewBuffer = getPreviewPhotoBuffer(match.imagePath);
  if (previewBuffer) {
    try {
      await ctx.replyWithPhoto({ source: previewBuffer }, { caption: text, parse_mode: 'Markdown', ...keyboard });
      return;
    } catch (sendErr) {
      console.warn('Photo preview yuborishda xatolik:', sendErr.message);
    }
  }

  // Lokal rasm topilmasa — kanaldan to'g'ridan-to'g'ri nusxalaymiz
  if (match.channelUsername && match.photoMessageId) {
    try {
      if (isEdit) {
        await ctx.deleteMessage().catch(() => {});
      }
      await ctx.telegram.copyMessage(ctx.chat.id, match.channelUsername, match.photoMessageId, {
        caption: text,
        parse_mode: 'Markdown',
        reply_markup: keyboard.reply_markup
      });
      return;
    } catch (copyErr) {
      console.warn('Kanaldan rasm nusxalashda xatolik:', copyErr.message);
    }
  }

  if (isEdit) {
    try {
      await ctx.editMessageText(text, { parse_mode: 'Markdown', ...keyboard });
    } catch (editErr) {
      await ctx.reply(text, { parse_mode: 'Markdown', ...keyboard });
    }
  } else {
    await ctx.reply(text, { parse_mode: 'Markdown', ...keyboard });
  }
}

function getPreviewPhotoBuffer(imagePath = '') {
  if (!imagePath) return null;
  const normalized = String(imagePath).trim();
  if (!normalized) return null;

  const candidatePaths = [
    normalized,
    path.resolve(process.cwd(), normalized),
    path.resolve(__dirname, '..', normalized),
    path.resolve(__dirname, '..', 'downloaded_images', path.basename(normalized))
  ];

  for (const candidate of candidatePaths) {
    try {
      if (candidate && fs.existsSync(candidate)) {
        return fs.readFileSync(candidate);
      }
    } catch (err) {
      console.warn('⚠️ Preview faylni o\'qishda xatolik:', err.message);
    }
  }
  return null;
}

async function updateStatus(ctx, statusMsg, text) {
  try {
    await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null, text, { parse_mode: 'Markdown' });
  } catch (err) { /* xabar o'zgarmagan bo'lishi mumkin */ }
}

bot.catch((err, ctx) => {
  console.error('Bot xatoligi:', err);
  if (ctx) {
    ctx.reply(t(lang(ctx), 'error_unexpected')).catch(() => {});
  }
});

async function launchBotWithRetry(maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const launchPromise = bot.launch({ dropPendingUpdates: true });
      console.log('🤖 Bot ishga tushdi! (rasm + matn qidiruv, statistika)');
      launchPromise.catch((err) => {
        const isTelegramConflict = err?.response?.error_code === 409 && /getUpdates|terminated by other/i.test(err?.message || '');
        if (isTelegramConflict) {
          console.error('⚠️ Shu token bilan boshqa bot nusxasi ishlamoqda. Avval uni to\'xtating.');
        } else {
          console.error('Bot polling xatoligi:', err);
        }
      });
      return;
    } catch (err) {
      const isTelegramConflict = err?.response?.error_code === 409 && /getUpdates|terminated by other/i.test(err?.message || '');
      if (isTelegramConflict) {
        console.error('⚠️ Shu token bilan boshqa bot nusxasi ishlamoqda. Avval uni to\'xtating.');
      } else {
        console.warn(`⚠️ Launch urinishi ${attempt}/${maxAttempts} muvaffaqiyatsiz: ${err.message}`);
      }
      if (attempt === maxAttempts) throw err;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

async function main() {
  if (!acquireSingleInstanceLock()) {
    console.error('❌ Bot allaqachon ishlamoqda.');
    process.exit(1);
  }

  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ MongoDB ulandi');
  } catch (err) {
    console.error('❌ MongoDB ulanishida xatolik:', err.message);
    process.exit(1);
  }

  try {
    const count = await loadCatalog(true);
    console.log(`📦 Katalogda ${count} ta model tayyor`);
  } catch (err) {
    console.error('⚠️ Katalog yuklanmadi:', err.message);
  }

  await launchBotWithRetry();
  void preloadModels().catch((err) => {
    console.warn('⚠️ CLIP modellarini oldindan yuklashda xatolik:', err?.message || err);
  });
}

main().catch((err) => {
  console.error('Ishga tushirishda xatolik:', err);
  process.exit(1);
});

process.once('SIGINT', () => {
  try { bot.stop('SIGINT'); } catch (e) {}
  releaseSingleInstanceLock();
  process.exit(0);
});
process.once('SIGTERM', () => {
  try { bot.stop('SIGTERM'); } catch (e) {}
  releaseSingleInstanceLock();
  process.exit(0);
});
