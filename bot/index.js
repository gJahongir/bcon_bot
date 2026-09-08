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
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { Readable } = require('stream');
const Model3D = require('./models/Models3D');

const { getImageEmbedding, getTextEmbedding, preloadModels } = require('./services/clipClient');
const { loadCatalog, findBestMatches, findTextMatches, refreshCatalog, getCatalogInfo } = require('./services/vectorSearch');
const { describeImage, analyzeTextQuery } = require('./services/cloudflareAi');

const { createSession, getSession, getCurrentPage, nextPage, prevPage } = require('./services/userSession');
const { getStats, getRandomModel, incrementSearchCounts } = require('./services/statsService');
const { shouldBypassAccessCheck } = require('./publicAccess');
const { acquireSingleInstanceLock, releaseSingleInstanceLock } = require('./singleInstance');

const registerStartCommand = require('./commands/start');
const registerHelpCommand = require('./commands/help');
const registerAdminCommand = require('./commands/admin');
const registerStatsCommand = require('./commands/stats');
const registerRandomCommand = require('./commands/random');
const registerRefreshCommand = require('./commands/refresh');

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
const { sendDbModelToChat, sendChannelMediaToChat } = require('./services/mediaService');
const {
  initializeAdminConfig,
  isAdminUser,
  getAllowedUsers,
  getRequiredChannels,
  setRequiredChannels,
  checkSubscriptions,
  getAds,
  setAds,
  setAllowedUsers,
  normalizeAdEntry,
  normalizeChannelName,
  buildSubscriptionKeyboard
} = require('./services/adminService');

// ─── Muhit o'zgaruvchilarini tekshirish ──────────────────────────────────────
if (!process.env.BOT_TOKEN) {
  console.error('❌ BOT_TOKEN topilmadi. .env faylini tekshiring.');
  process.exit(1);
}
if (!process.env.MONGODB_URI) {
  console.error('❌ MONGODB_URI topilmadi. .env faylini tekshiring.');
  process.exit(1);
}

// ─── Telegraf bilan Telegram API timeout muammosini hal qilish ──────────────
const bot = new Telegraf(process.env.BOT_TOKEN, {
  telegram: {
    apiRoot: 'https://api.telegram.org',
    timeout: 600000, // 10 daqiqa (katta fayllar uchun)
    agent: new https.Agent({
      family: 4,
      keepAlive: true,
      keepAliveMsecs: 10000,
      lookup: (hostname, options, callback) => {
        dns.lookup(hostname, { family: 4, all: false }, callback);
      }
    })
  },
  handlerTimeout: Infinity // Telegraf middleware'ni uzib qoymasligi uchun
});

const TG_API_ID = Number(process.env.TG_API_ID || 0);
const TG_API_HASH = process.env.TG_API_HASH || '';
const TG_SESSION = process.env.TG_SESSION || '';
let channelClient = null;
let channelClientPromise = null;
const pendingAdDrafts = new Map();
const startedUsers = new Set();

function getPendingAdDraft(userId) {
  return pendingAdDrafts.get(userId) || { text: '', photoFileId: null };
}

function setPendingAdDraft(userId, draft) {
  pendingAdDrafts.set(userId, draft);
}

registerStartCommand(bot, { trackStartedUser, Markup });
registerHelpCommand(bot, { getAds });
registerAdminCommand(bot, { isAdminUser, getAdminMenuKeyboard });
registerStatsCommand(bot, { getStats, getCatalogInfo });
registerRandomCommand(bot, { getRandomModel });
registerRefreshCommand(bot, { refreshCatalog, getCatalogInfo });

function clearPendingAdDraft(userId) {
  pendingAdDrafts.delete(userId);
}

function formatAdForDisplay(ad) {
  const normalized = normalizeAdEntry(ad);
  if (!normalized) {
    return '—';
  }

  if (normalized.type === 'photo') {
    return `📸 ${normalized.text || 'Rasmli reklama'}`;
  }

  return `📝 ${normalized.text || 'Reklama matni'}`;
}

function getAdConfirmationKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('✅ Tasdiqlash', 'admin_confirm_ad')],
    [Markup.button.callback('❌ Bekor qilish', 'admin_cancel_ad')]
  ]);
}

function getAdStepKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📷 Rasm qo‘shish', 'admin_add_ad_photo')],
    [Markup.button.callback('📝 Matn qo‘shish', 'admin_add_ad_text')],
    [Markup.button.callback('✅ Tekshirish', 'admin_check_ad')],
    [Markup.button.callback('❌ Bekor qilish', 'admin_cancel_ad')]
  ]);
}

function trackStartedUser(userId) {
  if (userId) {
    startedUsers.add(Number(userId));
  }
}

async function sendAdToChat(telegram, chatId, ad) {
  const normalized = normalizeAdEntry(ad);
  if (!normalized) {
    return false;
  }

  try {
    if (normalized.type === 'photo' && normalized.photoFileId) {
      await telegram.sendPhoto(chatId, normalized.photoFileId, {
        caption: normalized.text || '',
        parse_mode: 'Markdown'
      });
    } else {
      await telegram.sendMessage(chatId, normalized.text || '');
    }
    return true;
  } catch (err) {
    console.warn('⚠️ Reklama yuborishda xatolik:', err.message);
    return false;
  }
}

async function sendAdPreview(ctx, ad) {
  await sendAdToChat(ctx.telegram, ctx.chat.id, ad).catch(() => { });
}

async function broadcastAdToStartedUsers(ad) {
  const recipients = Array.from(startedUsers);
  let sentCount = 0;

  for (const userId of recipients) {
    const ok = await sendAdToChat(bot.telegram, Number(userId), ad);
    if (ok) {
      sentCount += 1;
    }
  }

  return sentCount;
}

async function ensureBotAccess(ctx) {
  const userId = Number(ctx.from?.id || 0);
  if (!userId) {
    return false;
  }

  const allowedUsers = await getAllowedUsers();
  if (!allowedUsers.includes(userId)) {
    await ctx.reply('⛔ Sizga bu botdan foydalanishga ruxsat yo\'q.');
    return false;
  }

  return true;
}

async function ensureRequiredChannelMembership(ctx) {
  const subscriptionCheck = await checkSubscriptions(ctx.telegram, ctx.from.id);
  if (subscriptionCheck.isSubscribed) {
    return true;
  }

  const missing = (subscriptionCheck.unjoinedChannels || []).map((channel) => normalizeChannelName(channel)).filter(Boolean);
  if (!missing.length) {
    return true;
  }

  const keyboard = Markup.inlineKeyboard(buildSubscriptionKeyboard(missing));
  await ctx.reply(
    '📣 Botdan foydalanish uchun quyidagi kanallarga a\'zo bo\'lishingiz kerak:\n' +
    missing.map((channel) => `• ${channel}`).join('\n') +
    '\n\nObuna bo\'lgach, quyidagi tugmani bosing.',
    { reply_markup: keyboard.reply_markup }
  );
  return false;
}

function getAdminMenuKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('➕ Reklama qo\'shish', 'admin_add_ad')],
    [Markup.button.callback('📣 Majburiy kanal qo\'shish', 'admin_add_channel')],
    [Markup.button.callback('👤 Foydalanuvchi qo\'shish', 'admin_add_user')],
    [Markup.button.callback('🚫 Foydalanuvchi chiqarish', 'admin_remove_user')],
    [Markup.button.callback('📋 Konfiguratsiyani ko\'rish', 'admin_show_config')]
  ]);
}

bot.use(async (ctx, next) => {
  if (!ctx.from?.id) {
    return next();
  }

  const messageText = ctx.message?.text || '';
  const isHelpCommand = messageText.startsWith('/help');
  const isAdminCommand = messageText.startsWith('/admin') || messageText.startsWith('/admin_');

  if (shouldBypassAccessCheck(ctx) || isHelpCommand) {
    return next();
  }

  const allowed = await ensureBotAccess(ctx);
  if (!allowed) {
    return;
  }

  if (isAdminCommand) {
    const isAdmin = await isAdminUser(ctx.from.id);
    if (isAdmin) {
      return next();
    }
  }

  const canProceed = await ensureRequiredChannelMembership(ctx);
  if (!canProceed) {
    return;
  }

  return next();
});

bot.on('text', async (ctx, next) => {
  const userId = Number(ctx.from?.id || 0);
  const draft = userId ? pendingAdDrafts.get(userId) : null;

  if (!draft) {
    return next();
  }

  const text = ctx.message.text?.trim() || '';
  if (!text || text.startsWith('/')) {
    return next();
  }

  if (text === '/cancel_ad') {
    clearPendingAdDraft(userId);
    return ctx.reply('❌ Reklama yaratish bekor qilindi.');
  }

  if (text === '/confirm_ad') {
    const normalized = normalizeAdEntry(draft);
    if (!normalized) {
      clearPendingAdDraft(userId);
      return ctx.reply('⚠️ Reklama matni yoki rasm yo‘q. Iltimos, avval matn yoki rasm yuboring.');
    }

    const existingAds = await getAds();
    existingAds.push(normalized);
    await setAds(existingAds);
    clearPendingAdDraft(userId);
    await ctx.reply('✅ Reklama saqlandi.');
    await sendAdPreview(ctx, normalized);
    return;
  }

  draft.text = text;
  setPendingAdDraft(userId, draft);
  await ctx.reply('📝 Matn saqlandi. Tasdiqlash uchun tugmani bosing:', {
    reply_markup: getAdConfirmationKeyboard().reply_markup
  });
  return;
});

bot.on('photo', async (ctx, next) => {
  const userId = Number(ctx.from?.id || 0);
  const draft = userId ? pendingAdDrafts.get(userId) : null;

  if (!draft) {
    return next();
  }

  const photo = ctx.message.photo?.[ctx.message.photo.length - 1];
  if (!photo) {
    return next();
  }

  draft.photoFileId = photo.file_id;
  setPendingAdDraft(userId, draft);
  await ctx.reply('Rasm saqlandi. Endi matn yuboring yoki /confirm_ad bilan tasdiqlang.', {
    reply_markup: getAdConfirmationKeyboard().reply_markup
  });
  return;
});

// Command handlers are registered from bot/commands/*.js modules.

// ─── Rasm qidiruv ────────────────────────────────────────────────────────────
bot.on('photo', async (ctx) => {
  const userId = Number(ctx.from?.id || 0);
  if (userId && pendingAdDrafts.has(userId)) {
    const draft = pendingAdDrafts.get(userId);
    const photo = ctx.message.photo?.[ctx.message.photo.length - 1];
    if (photo) {
      draft.photoFileId = photo.file_id;
      setPendingAdDraft(userId, draft);
      await ctx.reply('📸 Rasm saqlandi. Endi matn yuboring yoki /confirm_ad bilan tasdiqlang.', {
        reply_markup: getAdConfirmationKeyboard().reply_markup
      });
      return;
    }
  }

  if (!(await ensureBotAccess(ctx))) {
    return;
  }

  const statusMsg = await ctx.reply('🔍 Rasm tahlil qilinmoqda...');
  let tempImagePath = null;

  try {
    // 1. Rasmni yuklab olish (retry logic bilan)
    const photos = ctx.message.photo;
    const fileId = photos[photos.length - 1].file_id;
    const fileLink = await ctx.telegram.getFileLink(fileId);

    let imageResponse;
    let lastError;

    // Retry logic: 3 ta harakat
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        console.log(`📥 Rasm yuklanmoqda (${attempt}/3): ${fileLink.href}`);
        imageResponse = await axiosInstance.get(fileLink.href, {
          responseType: 'arraybuffer',
          timeout: 60000 + (attempt * 10000) // 60s, 70s, 80s
        });
        console.log(`✅ Rasm yuklandi (${imageResponse.data.length} bayt)`);
        break; // Muvaffaqiyat
      } catch (err) {
        lastError = err;
        if (attempt < 3) {
          const delay = Math.pow(2, attempt - 1) * 1000; // 1s, 2s, 4s
          console.warn(`⚠️ Rasm yuklanish xatosi (${attempt}/3), ${delay}ms kutilmoqda...`);
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }

    if (!imageResponse) {
      throw new Error(`Rasm yuklanib bo'lmadi: ${lastError?.message || 'Noma\'lum xatolik'}`);
    }

    tempImagePath = path.join(os.tmpdir(), `grabit3d_query_${ctx.from.id}_${Date.now()}.jpg`);
    fs.writeFileSync(tempImagePath, Buffer.from(imageResponse.data));

    // 2. Parallel: CLIP embedding + Cloudflare Vision tahlil
    await updateStatus(ctx, statusMsg, '🧠 AI tahlil qilmoqda...');

    const base64Image = Buffer.from(imageResponse.data).toString('base64');
    const [queryEmbedding, cloudflareResult] = await Promise.allSettled([
      getImageEmbedding(tempImagePath),
      describeImage(base64Image, 'image/jpeg').catch((err) => {
        console.warn('Cloudflare Vision xatoligi (davom etiladi):', err.message);
        return null;
      })
    ]);

    const aiData = cloudflareResult.status === 'fulfilled' ? cloudflareResult.value : null;

    let embedding = null;
    if (queryEmbedding.status === 'fulfilled' && queryEmbedding.value) {
      embedding = queryEmbedding.value;
    } else {
      console.warn('⚠️ Image CLIP embedding mavjud emas:', queryEmbedding.reason?.message || 'unknown');
      if (aiData?.englishDescription) {
        await updateStatus(ctx, statusMsg, '🧠 Rasm embedding ishlamadi, tasvir tavsifidan qidirilmoqda...');
        const fallbackEmbedding = await getTextEmbedding(aiData.englishDescription);
        if (fallbackEmbedding) {
          embedding = fallbackEmbedding;
        } else {
          const lexicalMatches = await findTextMatches(aiData.englishDescription, 10);
          if (lexicalMatches.length > 0) {
            await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
            const session = createSession(ctx.from.id, lexicalMatches, 'image', aiData.description || '');
            incrementSearchCounts(lexicalMatches.map((m) => m._id)).catch(() => {});
            await sendResultsPage(ctx, ctx.from.id, aiData);
            return;
          }
        }
      }
    }

    if (!embedding) {
      throw new Error('Rasm embedding hisoblashda xatolik. Iltimos, matn bilan qidirib ko\'ring.');
    }

    // 3. AI tavsifini ko'rsatish
    if (aiData && aiData.description) {
      await updateStatus(
        ctx, statusMsg,
        `🔎 *Topildi:* ${aiData.description}\n🔍 Bazadan mos model qidirilmoqda...`
      );
    } else {
      await updateStatus(ctx, statusMsg, '🔎 Bazadan mos model qidirilmoqda...');
    }

    // Gibrid qidiruv logikasi: Rasm embedding va Matn embeddingini birlashtirish
    if (aiData && aiData.englishDescription) {
      try {
        const textEmbedding = await getTextEmbedding(aiData.englishDescription);
        if (textEmbedding && textEmbedding.length === embedding.length) {
          const combined = new Float32Array(embedding.length);
          for (let i = 0; i < combined.length; i++) {
            // 70% vizual rasm + 30% semantik matn
            combined[i] = 0.7 * embedding[i] + 0.3 * textEmbedding[i];
          }
          // Normalizatsiya
          let norm = 0;
          for (let i = 0; i < combined.length; i++) {
            norm += combined[i] * combined[i];
          }
          norm = Math.sqrt(norm);
          if (norm > 0.001) {
            for (let i = 0; i < combined.length; i++) {
              combined[i] /= norm;
            }
            embedding = Array.from(combined);
            console.log(`🧠 Gibrid qidiruv faollashtirildi (Vizual: 70%, Semantik: 30%): "${aiData.englishDescription}"`);
          }
        }
      } catch (textEmbedErr) {
        console.error('⚠️ Gibrid qidiruvda matn embeddingini olishda xato:', textEmbedErr.message);
      }
    }

    // 4. Vektor qidiruv
    const matches = await findBestMatches(embedding, 10, 0.5);

    if (matches.length === 0) {
      // Bazada topilmadi — CGTrader'dan qidiramiz
      let fallbackText =
        '😕 Bazamda bunga o\'xshash model topilmadi.';

      if (aiData && aiData.keywords && aiData.keywords.length > 0) {
        await updateStatus(ctx, statusMsg, '🌐 Onlayn bazalardan qidirilmoqda...');
        const cgResults = await searchCGTrader(aiData.keywords.join(' '), 4);
        if (cgResults.length > 0) {
          fallbackText += '\n\n🌐 *Onlayn topilgan natijalar (CGTrader):*\n';
          cgResults.forEach((r, i) => {
            fallbackText += `\n${i + 1}. [${r.name}](${r.url})`;
          });
          fallbackText += '\n\n💡 Boshqa burchakdan rasm bilan ham sinab ko\'ring!';
        } else {
          fallbackText += '\n\n💡 Boshqa burchakdan olingan yoki aniqroq rasm bilan urinib ko\'ring.';
        }
      } else {
        fallbackText += '\n\n💡 Boshqa burchakdan olingan yoki aniqroq rasm bilan urinib ko\'ring.';
      }

      await ctx.telegram.editMessageText(
        ctx.chat.id, statusMsg.message_id, null,
        fallbackText,
        { parse_mode: 'Markdown', disable_web_page_preview: true }
      );
      return;
    }

    // 5. Natijalarni saqlash va statistika yangilash
    const session = createSession(
      ctx.from.id,
      matches,
      'image',
      aiData?.description || ''
    );

    incrementSearchCounts(matches.map((m) => m._id)).catch(() => { });

    // 6. Birinchi sahifani ko'rsatish
    await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => { });
    await sendResultsPage(ctx, ctx.from.id, aiData);

  } catch (error) {
    console.error('Rasm qidiruv xatoligi:', error);

    let errorMsg = '❌ Xatolik yuz berdi';

    if (error.message?.includes('ETIMEDOUT') || error.code === 'ETIMEDOUT') {
      errorMsg = '⏱️ Rasm yuklanish vaqti tugadi.\n\n💡 Iltimos:\n• Broyzer keshini tozalang\n• Internet ulanishini tekshiring\n• Bir oz vaqtdan keyin qayta urinib ko\'ring';
    } else if (error.message?.includes('Rasm embedding')) {
      errorMsg = '🧠 Rasm tahlilida xatolik.\n\n💡 Boshqa rasm bilan urinib ko\'ring.';
    } else if (error.message?.includes('Rasm yuklanib')) {
      errorMsg = '📥 Rasm yuklanib bo\'lmadi.\n\n💡 Internet ulanishini tekshiring va qayta urinib ko\'ring.';
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
  // Komandalarni o'tkazib yuborish (/ bilan boshlangan xabarlar)
  if (ctx.message.text.startsWith('/')) return;

  const query = ctx.message.text.trim();
  if (query.length < 2) {
    return ctx.reply('✍️ Kamida 2 ta harf yozing yoki rasm yuboring.');
  }
  if (query.length > 200) {
    return ctx.reply('⚠️ So\'rov juda uzun. Qisqaroq yozing.');
  }

  const statusMsg = await ctx.reply('🔍 Matn bo\'yicha qidirilmoqda...');

  try {
    // 1. Cloudflare orqali inglizchaga tarjima + kalit so'zlar olish
    let searchTerms = query;
    let aiDesc = null;

    try {
      const parsed = await analyzeTextQuery(query);
      if (parsed.english) searchTerms = parsed.english;
      if (parsed.description) aiDesc = parsed.description;
    } catch (cfErr) {
      console.warn('Cloudflare AI tarjima xatoligi (davom etiladi):', cfErr.message);
    }

    // 2. CLIP text embedding
    await updateStatus(ctx, statusMsg, `🧠 "${searchTerms}" qidirilmoqda...`);

    let textEmbedding;
    try {
      textEmbedding = await getTextEmbedding(searchTerms);
    } catch (embErr) {
      console.warn('Text embedding xatoligi, asl matn bilan urinilmoqda:', embErr.message);
      try {
        textEmbedding = await getTextEmbedding(query);
      } catch (fallbackErr) {
        console.warn('Text embedding fallback xatoligi:', fallbackErr.message);
        textEmbedding = null;
      }
    }

    // 3. Vektor qidiruv (matn uchun threshold biroz pastroq)
    let matches = [];
    if (textEmbedding) {
      try {
        matches = await findBestMatches(textEmbedding, 10, 0.3);
        console.log('🔎 Text vector search results:', matches.length, 'scores:', matches.map((m) => m.score));
      } catch (vecErr) {
        console.warn('Text vector search xatoligi (fallback ishlatilmoqda):', vecErr.message);
        textEmbedding = null;
      }
    }

    if (matches.length === 0) {
      console.log('📝 Text vector search bo\'sh, lexical fallback ishlatilmoqda');
      matches = await findTextMatches(query, 10);
      console.log('📝 Text lexical fallback results:', matches.length, 'scores:', matches.map((m) => m.score));
    }

    if (matches.length === 0) {
      let fallbackText = `😕 "${query}" bo'yicha bazamda mos model topilmadi.`;

      // CGTrader'dan qidirish
      const cgResults = await searchCGTrader(searchTerms, 4);
      if (cgResults.length > 0) {
        fallbackText += '\n\n🌐 *Onlayn topilgan natijalar (CGTrader):*\n';
        cgResults.forEach((r, i) => {
          fallbackText += `\n${i + 1}. [${r.name}](${r.url})`;
        });
      } else {
        fallbackText += '\n\n💡 Boshqa so\'z bilan yoki rasm yuborib qidirib ko\'ring.';
      }

      await ctx.telegram.editMessageText(
        ctx.chat.id, statusMsg.message_id, null,
        fallbackText,
        { parse_mode: 'Markdown', disable_web_page_preview: true }
      );
      return;
    }

    // 4. Natijalarni saqlash
    createSession(ctx.from.id, matches, 'text', aiDesc || query);
    incrementSearchCounts(matches.map((m) => m._id)).catch(() => { });

    // 5. Natijalarni ko'rsatish
    await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => { });
    await sendResultsPage(ctx, ctx.from.id, { description: aiDesc });

  } catch (error) {
    console.error('Matn qidiruv xatoligi:', error);

    let errorMsg = '❌ Qidiruv xatoligi';

    if (error.message?.includes('embedding')) {
      errorMsg = '🧠 Matn tahlilida xatolik.\n\n💡 Boshqa so\'zlar bilan urinib ko\'ring.';
    }

    ctx.reply(errorMsg);
  }
});

// ─── Inline tugmalar callback ────────────────────────────────────────────────
bot.on('callback_query', async (ctx) => {
  const data = ctx.callbackQuery.data;

  try {
    if (data === 'next_page') {
      const page = nextPage(ctx.from.id);
      if (!page) {
        return ctx.answerCbQuery('⏳ Sessiya tugagan. Qaytadan qidiring.');
      }
      await ctx.answerCbQuery(`📄 Model ${page.page + 1}/${page.totalPages}`);
      await sendResultsPage(ctx, ctx.from.id, null, false);

    } else if (data === 'prev_page') {
      const page = prevPage(ctx.from.id);
      if (!page) {
        return ctx.answerCbQuery('⏳ Sessiya tugagan. Qaytadan qidiring.');
      }
      await ctx.answerCbQuery(`📄 Model ${page.page + 1}/${page.totalPages}`);
      await sendResultsPage(ctx, ctx.from.id, null, false);

    } else if (data === 'start_help') {
      await ctx.answerCbQuery('🆘 Yordam ko‘rilmoqda...');
      await ctx.reply('/help');

    } else if (data === 'start_stats') {
      await ctx.answerCbQuery('📊 Statistika ko‘rilmoqda...');
      await ctx.reply('/stats');

    } else if (data === 'start_random') {
      await ctx.answerCbQuery('🎲 Tasodifiy model ko‘rilmoqda...');
      await ctx.reply('/random');

    } else if (data === 'admin_add_ad') {
      const userId = Number(ctx.from?.id || 0);
      setPendingAdDraft(userId, { text: '', photoFileId: null });
      await ctx.answerCbQuery('📝 Reklama yaratish boshlandi.');
      await ctx.reply('📝 Reklama yaratish uchun:\n1) 📷 Rasm qo‘shish\n2) 📝 Matn qo‘shish\n3) ✅ Tekshirish\n\nAgar rasm kerak bo\'lmasa, faqat matn yozing.', {
        reply_markup: getAdStepKeyboard().reply_markup
      });

    } else if (data === 'admin_add_ad_photo') {
      await ctx.answerCbQuery('📷 Rasm yuboring.');
      await ctx.reply('📷 Endi reklama uchun rasm yuboring.');

    } else if (data === 'admin_add_ad_text') {
      await ctx.answerCbQuery('📝 Matn yuboring.');
      await ctx.reply('📝 Endi reklama uchun matn yuboring.');

    } else if (data === 'admin_check_ad') {
      const userId = Number(ctx.from?.id || 0);
      const draft = userId ? pendingAdDrafts.get(userId) : null;
      if (!draft) {
        await ctx.answerCbQuery('ℹ️ Hech qanday reklama drafti yo‘q.');
        return;
      }

      const normalized = normalizeAdEntry(draft);
      if (!normalized) {
        await ctx.answerCbQuery('⚠️ Reklama uchun hech narsa yo‘q.');
        await ctx.reply('⚠️ Reklama uchun matn yoki rasm qo‘shing.');
        return;
      }

      let previewText = '🧾 Reklama tekshirilmoqda:\n\n';
      previewText += normalized.type === 'photo' ? '📷 Rasmli reklama' : '📝 Matnli reklama';
      previewText += '\n\n';
      previewText += normalized.text || 'Matn yo‘q';

      await ctx.answerCbQuery('✅ Reklama tayyor.');
      await ctx.reply(previewText, {
        reply_markup: getAdConfirmationKeyboard().reply_markup
      });

    } else if (data === 'admin_confirm_ad') {
      const userId = Number(ctx.from?.id || 0);
      const draft = userId ? pendingAdDrafts.get(userId) : null;
      if (!draft) {
        await ctx.answerCbQuery('ℹ️ Hech qanday reklama drafti yo‘q.');
        return;
      }

      const normalized = normalizeAdEntry(draft);
      if (!normalized) {
        clearPendingAdDraft(userId);
        await ctx.answerCbQuery('⚠️ Reklama matni yoki rasm yo‘q.');
        return;
      }

      const existingAds = await getAds();
      existingAds.push(normalized);
      await setAds(existingAds);
      clearPendingAdDraft(userId);
      await ctx.answerCbQuery('✅ Reklama saqlandi.');
      const sentCount = await broadcastAdToStartedUsers(normalized);
      await ctx.reply(`✅ Reklama saqlandi. ${sentCount} ta foydalanuvchiga yuborildi.`);
      await sendAdPreview(ctx, normalized);

    } else if (data === 'admin_cancel_ad') {
      const userId = Number(ctx.from?.id || 0);
      clearPendingAdDraft(userId);
      await ctx.answerCbQuery('❌ Reklama yaratish bekor qilindi.');
      await ctx.reply('❌ Reklama yaratish bekor qilindi.');

    } else if (data === 'check_required_channels') {
      const subscriptionCheck = await checkSubscriptions(ctx.telegram, ctx.from.id);
      if (subscriptionCheck.isSubscribed) {
        await ctx.answerCbQuery('✅ Hamma majburiy kanallarga obuna bo\'lgansiz.');
        await ctx.reply('✅ Hamma majburiy kanallarga obuna bo\'lgansiz.');
      } else {
        const missing = (subscriptionCheck.unjoinedChannels || []).map((channel) => normalizeChannelName(channel)).filter(Boolean);
        await ctx.answerCbQuery('⚠️ Hali ba\'zi kanallarga obuna emassiz.');
        await ctx.reply(
          '⚠️ Hali quyidagi kanallarga obuna emassiz:\n' +
          missing.map((channel) => `• ${channel}`).join('\n')
        );
      }

    } else if (data === 'admin_add_channel') {
      await ctx.answerCbQuery('📣 Kanalni /admin_add_channel @username formatida qo\'shing.');
      await ctx.reply('📣 Majburiy kanal qo\'shish uchun quyidagi formatdan foydalaning:\n/admin_add_channel @username');

    } else if (data === 'admin_add_user') {
      await ctx.answerCbQuery('👤 Foydalanuvchi ID sini /admin_add_user <id> formatida yuboring.');
      await ctx.reply('👤 Foydalanuvchi qo\'shish uchun quyidagi formatdan foydalaning:\n/admin_add_user <telegram_user_id>');

    } else if (data === 'admin_remove_user') {
      await ctx.answerCbQuery('🚫 Foydalanuvchi ID sini /admin_remove_user <id> formatida yuboring.');
      await ctx.reply('🚫 Foydalanuvchi chiqarish uchun quyidagi formatdan foydalaning:\n/admin_remove_user <telegram_user_id>');

    } else if (data === 'admin_show_config') {
      await ctx.answerCbQuery('📋 Konfiguratsiya ko\'rilmoqda...');
      const allowedUsers = await getAllowedUsers();
      const requiredChannels = await getRequiredChannels();
      const ads = await getAds();
      await ctx.reply(
        '📋 Admin konfiguratsiyasi:\n\n' +
        `👤 Foydalanuvchilar: ${allowedUsers.join(', ') || 'yo\'q'}\n` +
        `📣 Majburiy kanallar: ${requiredChannels.join(', ') || 'yo\'q'}\n` +
        `📢 Reklamalar: ${ads.length || 0} ta`
      );

    } else if (data.startsWith('download_')) {
      // download_[encodedUsername]|[messageId]|[photoMessageId?]
      const payload = data.replace(/^download_/, '');
      const parts = payload.split('|');

      if (parts.length < 2) {
        return ctx.answerCbQuery('⚠️ Download parametrlari xato.');
      }

      let channelUsername = decodeURIComponent(parts[0]);
      const primaryMessageId = Number(parts[1]);

      if (channelUsername.startsWith('@')) {
        channelUsername = channelUsername.substring(1);
      }

      const sourceLink = `https://t.me/${channelUsername}/${primaryMessageId}`;
      await ctx.answerCbQuery('🔗 Kanalga yo\'naltirilmoqda...').catch(() => { });
      await ctx.reply(`🔗 Arxivning asl manbasi:\n${sourceLink}`, {
        disable_web_page_preview: false
      });
    }
  } catch (err) {
    console.error('Callback xatoligi:', err);
    ctx.answerCbQuery('❌ Xatolik yuz berdi').catch(() => { });
  }
});

// ─── Yordamchi funksiyalar ───────────────────────────────────────────────────

/**
 * Natijalar sahifasini chiroyli formatda ko'rsatadi (inline tugmalar bilan).
 */
async function sendResultsPage(ctx, userId, aiInfo, isEdit = false) {
  const pageData = getCurrentPage(userId);
  if (!pageData || pageData.items.length === 0) {
    return ctx.reply('😕 Natija topilmadi.');
  }

  const session = getSession(userId);
  const match = pageData.items[0];
  const percent = Math.round(match.score * 100);
  const username = match.channelUsername.startsWith('@')
    ? match.channelUsername.substring(1)
    : match.channelUsername;
  const sourceUrl = `https://t.me/${username}/${match.messageId}`;

  let text = '';
  if (!isEdit && aiInfo?.description) {
    text += `🤖 *AI tahlili:* ${aiInfo.description}\n\n`;
  }
  text += `📄 *Model ${pageData.page + 1}/${pageData.totalPages}*\n\n`;
  text += `📦 *${match.documentFileName}*\n`;
  text += `🎯 O'xshashlik: *${percent}%*\n`;
  text += `📡 Manba: ${match.channelUsername}\n`;
  if (match.category) text += `🏷 ${match.category}\n`;
  if (match.tags && match.tags.length > 0) {
    text += `🔖 ${match.tags.slice(0, 5).join(', ')}\n`;
  }
  text += `\n⬇️ Download tugmasi bosilganda kanal arxiviga otiladi.`;

  const buttons = [];
  buttons.push([Markup.button.url('⬇️ Download', sourceUrl)]);

  const navRow = [];
  if (pageData.hasPrev) navRow.push(Markup.button.callback('⬅️ Back', 'prev_page'));
  if (pageData.hasNext) navRow.push(Markup.button.callback('Next ➡️', 'next_page'));
  if (navRow.length > 0) buttons.push(navRow);


  const keyboard = Markup.inlineKeyboard(buttons);

  const previewBuffer = await getPreviewPhotoBuffer(username, match.photoMessageId, match.imagePath);
  if (previewBuffer) {
    try {
      await ctx.replyWithPhoto(
        { source: Buffer.from(previewBuffer) },
        { caption: text, parse_mode: 'Markdown', ...keyboard }
      );
      return;
    } catch (sendErr) {
      console.warn('Photo preview yuborishda xatolik, textga qaytish:', sendErr.message);
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

async function getPreviewPhotoBuffer(channelUsername, photoMessageId, imagePath = '') {
  const candidatePaths = [];

  if (imagePath) {
    const normalized = String(imagePath).trim();
    if (normalized) {
      if (path.isAbsolute(normalized)) {
        candidatePaths.push(normalized);
      } else {
        candidatePaths.push(
          path.resolve(process.cwd(), normalized),
          path.resolve(__dirname, '..', normalized),
          path.resolve(__dirname, '..', 'downloaded_images', path.basename(normalized))
        );
      }
    }
  }

  for (const candidate of candidatePaths) {
    try {
      if (candidate && fs.existsSync(candidate)) {
        return fs.readFileSync(candidate);
      }
    } catch (err) {
      console.warn('⚠️ Preview fayl yo‘lini tekshirishda xatolik:', err.message);
    }
  }

  if (!photoMessageId) {
    return null;
  }

  try {
    const client = await getChannelClient();
    const channel = channelUsername.startsWith('@') ? channelUsername.substring(1) : channelUsername;
    const inputEntity = await client.getInputEntity(channel);
    const messages = await client.getMessages(inputEntity, { ids: [photoMessageId] });
    const photoMessage = messages.find((msg) => msg.id === photoMessageId) || messages[0];

    if (!photoMessage || !photoMessage.photo) {
      return null;
    }

    const media = await client.downloadMedia(photoMessage);

    if (Buffer.isBuffer(media)) {
      return media;
    }
    if (media instanceof ArrayBuffer) {
      return Buffer.from(media);
    }
    if (ArrayBuffer.isView(media)) {
      return Buffer.from(media.buffer, media.byteOffset, media.byteLength);
    }
    if (media && typeof media === 'object' && media.data) {
      return Buffer.from(media.data);
    }

    return null;
  } catch (err) {
    console.warn(`⚠️ Preview rasmni olishda xatolik (${channelUsername}/${photoMessageId}):`, err.message);
    return null;
  }
}

async function getChannelClient() {
  if (!TG_API_ID || !TG_API_HASH || !TG_SESSION) {
    throw new Error('TG_API_ID / TG_API_HASH / TG_SESSION mavjud emas. Kanal media olish uchun user session kerak.');
  }

  if (channelClient) {
    return channelClient;
  }

  if (!channelClientPromise) {
    channelClientPromise = (async () => {
      const client = new TelegramClient(new StringSession(TG_SESSION), TG_API_ID, TG_API_HASH, {
        connectionRetries: 3
      });

      await client.connect();
      console.log('✅ Telegram user session bilan kanal client ulanmoqda');
      channelClient = client;
      return client;
    })().catch((err) => {
      channelClientPromise = null;
      throw err;
    });
  }

  return await channelClientPromise;
}


/**
 * Status xabarini yangilaydi (xatolikni yashiradi).
 */
async function updateStatus(ctx, statusMsg, text) {
  try {
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      null,
      text,
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    // Xabar o'zgarmagan bo'lishi mumkin — e'tiborsiz qoldiramiz
  }
}

// ─── Xatolik boshqaruvi ─────────────────────────────────────────────────────
bot.catch((err, ctx) => {
  console.error('Bot xatoligi:', err);
  if (ctx) {
    ctx.reply('❌ Kutilmagan xatolik yuz berdi. Iltimos, qaytadan urinib ko\'ring.')
      .catch(() => { });
  }
});

// ─── Botni ishga tushirish ──────────────────────────────────────────────────
async function launchBotWithRetry(maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await bot.launch({ dropPendingUpdates: true });
      console.log('');
      console.log('═══════════════════════════════════════════');
      console.log('  🤖 Bcon Bot ishga tushdi!');
      console.log('  📸 Rasm qidiruv ✅');
      console.log('  ✍️ Matn qidiruv ✅');
      console.log('  🧩 Model preview flow ✅');
      console.log('  📊 Statistika ✅');
      console.log('═══════════════════════════════════════════');
      console.log('');
      return;
    } catch (err) {
      const isTelegramConflict = err?.response?.error_code === 409 && /getUpdates|terminated by other/i.test(err?.message || '');

      if (isTelegramConflict) {
        console.error('⚠️ Telegram polling xatoligi: ushbu bot token bilan boshqa nusxa allaqachon ishlamoqda. Avval oldingi bot/processni to\'xtating, so\'ngra qayta ishga tushiring.');
      } else {
        console.warn(`⚠️ Telegraf launch urinishi ${attempt}/${maxAttempts} muvaffaqiyatsiz: ${err.message}`);
      }

      if (attempt === maxAttempts) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

async function main() {
  if (!acquireSingleInstanceLock()) {
    console.error('❌ Bot allaqachon ishlamoqda. Bitta nusxa faqat bitta jarayon bo‘lishi kerak.');
    process.exit(1);
  }

  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ MongoDB ulandi');
    await initializeAdminConfig();
    console.log('✅ Admin konfiguratsiyasi tayyorlandi');
  } catch (err) {
    console.error('❌ MongoDB ulanishida xatolik:', err.message);
    process.exit(1);
  }

  try {
    const count = await loadCatalog(true);
    console.log(`📦 Katalogda ${count} ta model tayyor`);
  } catch (err) {
    console.error('⚠️ Katalog yuklanmadi (bot ishlashda davom etadi):', err.message);
  }

  // CLIP modellarini oldindan yuklash (birinchi qidiruvda timeout bo'lmasligi uchun)
  await preloadModels();

  await launchBotWithRetry();
}

main().catch((err) => {
  console.error('Ishga tushirishda xatolik:', err);
  process.exit(1);
});

process.once('SIGINT', () => {
  try { bot.stop('SIGINT'); } catch (e) { }
  releaseSingleInstanceLock();
  process.exit(0);
});
process.once('SIGTERM', () => {
  try { bot.stop('SIGTERM'); } catch (e) { }
  releaseSingleInstanceLock();
  process.exit(0);
});


//kmefojnojlnonfoenojnfrkjo