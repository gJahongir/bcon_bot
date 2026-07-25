require('dotenv').config();
require('dns').setDefaultResultOrder('ipv4first');

const fs = require('fs');
const os = require('os');
const path = require('path');
const mongoose = require('mongoose');
const axios = require('axios');
const { Telegraf, Markup } = require('telegraf');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');

const { getImageEmbedding, getTextEmbedding, preloadModels } = require('./services/clipClient');
const { loadCatalog, findBestMatches, refreshCatalog, getCatalogInfo } = require('./services/vectorSearch');
const { describeImage } = require('./services/geminiVision');
const { searchCGTrader } = require('./services/cgtraderSearch');
const { createSession, getSession, getCurrentPage, nextPage, prevPage } = require('./services/userSession');
const { getStats, getRandomModel, incrementSearchCounts } = require('./services/statsService');

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
    timeout: 60000 // 60 sekund
  }
});

const TG_API_ID = Number(process.env.TG_API_ID || 0);
const TG_API_HASH = process.env.TG_API_HASH || '';
const TG_SESSION = process.env.TG_SESSION || '';
let channelClient = null;
let channelClientPromise = null;

// ─── /start ──────────────────────────────────────────────────────────────────
bot.start((ctx) => {
  const name = ctx.from.first_name || 'do\'stim';
  ctx.reply(
    `Salom, ${name}! 👋\n\n` +
    `🤖 Men *Grabit3D Bot* — 3D modellar qidiruv yordamchisiman.\n\n` +
    `📸 *Rasm yuborib qidiring:*\n` +
    `Menga istalgan 3D model rasmini yuboring — men bazamdan o'xshash modellarni topib, arxiv faylini yuboraman.\n\n` +
    `✍️ *Matn yozib qidiring:*\n` +
    `"kreslo", "mashina", "bino" kabi so'z yozing — men shu turdagi modellarni topaman.\n\n` +
    `📋 *Komandalar:*\n` +
    `/help — barcha komandalar\n` +
    `/stats — bazadagi modellar statistikasi\n` +
    `/random — tasodifiy model ko'rish`,
    { parse_mode: 'Markdown' }
  );
});

// ─── /help ───────────────────────────────────────────────────────────────────
bot.help((ctx) => {
  ctx.reply(
    `📋 *Mavjud komandalar:*\n\n` +
    `/start — Botni boshlash\n` +
    `/help — Shu yordam xabari\n` +
    `/stats — Bazadagi modellar statistikasi\n` +
    `/random — Bazadan tasodifiy model\n` +
    `/refresh — Katalogni yangilash (yangi modellar)\n\n` +
    `📸 *Qidiruv usullari:*\n` +
    `• Rasm yuboring — o'xshash 3D modellar topiladi\n` +
    `• Matn yozing — tavsif bo'yicha qidiruv\n\n` +
    `💡 *Maslahat:* Aniqroq rasm yuborsangiz, natija ham aniqroq bo'ladi!`,
    { parse_mode: 'Markdown' }
  );
});

// ─── /stats ──────────────────────────────────────────────────────────────────
bot.command('stats', async (ctx) => {
  try {
    const stats = await getStats();
    const catalogInfo = getCatalogInfo();

    let text =
      `📊 <b>Grabit3D Statistika</b>\n\n` +
      `📦 Jami modellar: <b>${stats.totalModels}</b>\n` +
      `🧬 Embedding tayyor: <b>${stats.withEmbedding}</b>\n` +
      `📡 Kanallar soni: <b>${stats.channels.length}</b>\n`;

    if (stats.channels.length > 0) {
      text += `\n📡 <b>Kanallar:</b>\n`;
      text += stats.channels.map((ch) => `  • @${ch}`).join('\n');
    }

    if (Object.keys(stats.categories).length > 0) {
      text += `\n\n🏷 <b>Kategoriyalar:</b>\n`;
      for (const [cat, count] of Object.entries(stats.categories)) {
        text += `  • ${cat}: ${count} ta\n`;
      }
    }

    if (catalogInfo.loaded) {
      text += `\n🧠 Xotiradagi katalog: <b>${catalogInfo.count}</b> ta model`;
      if (catalogInfo.lastLoadTime) {
        text += `\n⏰ Oxirgi yuklash: ${catalogInfo.lastLoadTime.toLocaleString('uz-UZ')}`;
      }
    }

    ctx.reply(text, { parse_mode: 'HTML' });
  } catch (err) {
    console.error('/stats xatoligi:', err);
    ctx.reply('❌ Statistikani olishda xatolik yuz berdi.');
  }
});

// ─── /random ─────────────────────────────────────────────────────────────────
bot.command('random', async (ctx) => {
  try {
    const model = await getRandomModel();
    if (!model) {
      return ctx.reply('😕 Bazada hali hech qanday model yo\'q.');
    }

    try {
      await ctx.telegram.forwardMessage(ctx.chat.id, `@${model.channelUsername}`, model.messageId);
    } catch (fwdErr) {
      // Forward ishlamasa, ma'lumotni matn sifatida ko'rsatamiz
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

// ─── /refresh ────────────────────────────────────────────────────────────────
bot.command('refresh', async (ctx) => {
  try {
    const msg = await ctx.reply('🔄 Katalog yangilanmoqda...');
    const added = await refreshCatalog();
    const info = getCatalogInfo();
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      msg.message_id,
      null,
      `✅ Katalog yangilandi!\n\n` +
      `➕ Yangi qo'shildi: ${added} ta\n` +
      `📦 Jami xotirada: ${info.count} ta model`
    );
  } catch (err) {
    console.error('/refresh xatoligi:', err);
    ctx.reply('❌ Katalogni yangilashda xatolik yuz berdi.');
  }
});

// ─── Rasm qidiruv ────────────────────────────────────────────────────────────
bot.on('photo', async (ctx) => {
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
        imageResponse = await axios.get(fileLink.href, {
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

    // 2. Parallel: CLIP embedding + Gemini Vision tahlil
    await updateStatus(ctx, statusMsg, '🧠 AI tahlil qilmoqda...');

    const base64Image = Buffer.from(imageResponse.data).toString('base64');
    const [queryEmbedding, geminiResult] = await Promise.allSettled([
      getImageEmbedding(tempImagePath),
      describeImage(base64Image, 'image/jpeg').catch((err) => {
        console.warn('Gemini Vision xatoligi (davom etiladi):', err.message);
        return null;
      })
    ]);

    if (queryEmbedding.status === 'rejected') {
      throw new Error('Rasm embedding hisoblashda xatolik: ' + queryEmbedding.reason?.message);
    }

    const embedding = queryEmbedding.value;
    const gemini = geminiResult.status === 'fulfilled' ? geminiResult.value : null;

    // 3. Gemini tavsifini ko'rsatish
    if (gemini && gemini.description) {
      await updateStatus(
        ctx, statusMsg,
        `🔎 *Topildi:* ${gemini.description}\n🔍 Bazadan mos model qidirilmoqda...`
      );
    } else {
      await updateStatus(ctx, statusMsg, '🔎 Bazadan mos model qidirilmoqda...');
    }

    // 4. Vektor qidiruv
    const matches = await findBestMatches(embedding, 10, 0.5);

    if (matches.length === 0) {
      // Bazada topilmadi — CGTrader'dan qidiramiz
      let fallbackText =
        '😕 Bazamda bunga o\'xshash model topilmadi.';

      if (gemini && gemini.keywords && gemini.keywords.length > 0) {
        await updateStatus(ctx, statusMsg, '🌐 Onlayn bazalardan qidirilmoqda...');
        const cgResults = await searchCGTrader(gemini.keywords.join(' '), 4);
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
      gemini?.description || ''
    );

    incrementSearchCounts(matches.map((m) => m._id)).catch(() => {});

    // 6. Birinchi sahifani ko'rsatish
    await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
    await sendResultsPage(ctx, ctx.from.id, gemini);

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
    // 1. Gemini orqali inglizchaga tarjima + kalit so'zlar olish
    let searchTerms = query;
    let geminiDesc = null;

    if (process.env.GEMINI_API_KEY) {
      try {
        const { GoogleGenAI } = require('@google/genai');
        const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
        const response = await ai.models.generateContent({
          model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
          contents: [
            {
              role: 'user',
              parts: [{
                text: `Foydalanuvchi 3D model qidirmoqda: "${query}". ` +
                  `Faqat toza JSON qaytar:\n` +
                  `{"english": "inglizcha qidiruv so'zi (masalan: modern wooden chair)", ` +
                  `"description": "foydalanuvchi nimani qidirmoqda - qisqa izoh o'zbek tilida"}`
              }]
            }
          ],
          config: { responseMimeType: 'application/json' }
        });

        const parsed = JSON.parse((response.text || '{}').replace(/```json|```/g, '').trim());
        if (parsed.english) searchTerms = parsed.english;
        if (parsed.description) geminiDesc = parsed.description;
      } catch (geminiErr) {
        console.warn('Gemini tarjima xatoligi (davom etiladi):', geminiErr.message);
      }
    }

    // 2. CLIP text embedding
    await updateStatus(ctx, statusMsg, `🧠 "${searchTerms}" qidirilmoqda...`);

    let textEmbedding;
    try {
      textEmbedding = await getTextEmbedding(searchTerms);
    } catch (embErr) {
      console.warn('Text embedding xatoligi, asl matn bilan urinilmoqda:', embErr.message);
      textEmbedding = await getTextEmbedding(query);
    }

    // 3. Vektor qidiruv (matn uchun threshold biroz pastroq)
    const matches = await findBestMatches(textEmbedding, 10, 0.4);

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
    createSession(ctx.from.id, matches, 'text', geminiDesc || query);
    incrementSearchCounts(matches.map((m) => m._id)).catch(() => {});

    // 5. Natijalarni ko'rsatish
    await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
    await sendResultsPage(ctx, ctx.from.id, { description: geminiDesc });

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
      await ctx.answerCbQuery(`📄 Sahifa ${page.page + 1}/${page.totalPages}`);
      await sendResultsPage(ctx, ctx.from.id, null, true);

    } else if (data === 'prev_page') {
      const page = prevPage(ctx.from.id);
      if (!page) {
        return ctx.answerCbQuery('⏳ Sessiya tugagan. Qaytadan qidiring.');
      }
      await ctx.answerCbQuery(`📄 Sahifa ${page.page + 1}/${page.totalPages}`);
      await sendResultsPage(ctx, ctx.from.id, null, true);

    } else if (data.startsWith('download_')) {
      // download_[encodedUsername]|[messageId]|[photoMessageId?]
      const payload = data.replace(/^download_/, '');
      const parts = payload.split('|');

      if (parts.length < 2) {
        return ctx.answerCbQuery('⚠️ Download parametrlari xato.');
      }

      let channelUsername = decodeURIComponent(parts[0]);
      const primaryMessageId = Number(parts[1]);
      const fallbackMessageId = Number(parts[2] || 0);

      // @ belgisini olib tashlash (agar bor bo'lsa)
      if (channelUsername.startsWith('@')) {
        channelUsername = channelUsername.substring(1);
      }

      ctx.answerCbQuery('📥 Yuborilmoqda...').catch(() => {});
      try {
        await sendChannelMediaToChat(ctx, channelUsername, primaryMessageId, fallbackMessageId);
        console.log(`✅ Kanal media chatga muvaffaqiyatli yuborildi`);
      } catch (fwdErr) {
        const raw = fwdErr.description || fwdErr.message || JSON.stringify(fwdErr);
        console.error(`❌ Kanal media olish/yuborish xatoligi (${channelUsername} / ${primaryMessageId}):`, raw);

        let errorMsg = '⚠️ Faylni yuborib bo\'lmadi.';
        
        if (raw.includes('chat_not_found')) {
          errorMsg += '\n\nSabab: Kanal topilmadi yoki nomi xato.';
        } else if (raw.includes('not_found') || raw.includes('message to forward not found')) {
          errorMsg += '\n\nSabab: Xabar kanaldan o\'chirilgan yoki botga kanalga kirish huquqi yo\'q.';
        } else if (raw.includes('FORBIDDEN')) {
          errorMsg += '\n\nSabab: Bot kanalga kirava olmayapti.';
        } else if (raw.includes('permission')) {
          errorMsg += '\n\nSabab: Bot\'ning admin huquqi yo\'q.';
        }
        
        errorMsg += `\n\nDebug: ${raw}`;

        await ctx.reply(errorMsg);
      }

    } else if (data === 'cgtrader_search') {
      const session = getSession(ctx.from.id);
      if (!session) {
        return ctx.answerCbQuery('⏳ Sessiya tugagan.');
      }
      await ctx.answerCbQuery('🌐 CGTrader\'dan qidirilmoqda...');

      const cgResults = await searchCGTrader(session.queryDescription || 'furniture 3d model', 5);
      if (cgResults.length > 0) {
        let text = '🌐 *CGTrader natijalar:*\n';
        cgResults.forEach((r, i) => {
          text += `\n${i + 1}. [${r.name}](${r.url})`;
        });
        await ctx.reply(text, { parse_mode: 'Markdown', disable_web_page_preview: true });
      } else {
        await ctx.reply('😕 CGTrader\'da ham topilmadi.');
      }
    }
  } catch (err) {
    console.error('Callback xatoligi:', err);
    ctx.answerCbQuery('❌ Xatolik yuz berdi').catch(() => {});
  }
});

// ─── Yordamchi funksiyalar ───────────────────────────────────────────────────

/**
 * Natijalar sahifasini chiroyli formatda ko'rsatadi (inline tugmalar bilan).
 */
async function sendResultsPage(ctx, userId, geminiInfo, isEdit = false) {
  const pageData = getCurrentPage(userId);
  if (!pageData || pageData.items.length === 0) {
    return ctx.reply('😕 Natija topilmadi.');
  }

  const session = getSession(userId);

  // Sarlavha
  let text = '';
  if (!isEdit && geminiInfo?.description) {
    text += `🤖 *AI tahlili:* ${geminiInfo.description}\n\n`;
  }
  text += `📦 *Natijalar* (sahifa ${pageData.page + 1}/${pageData.totalPages}, jami ${session.results.length} ta):\n\n`;

  // Har bir natija
  for (let i = 0; i < pageData.items.length; i++) {
    const match = pageData.items[i];
    const percent = Math.round(match.score * 100);
    const num = pageData.page * session.pageSize + i + 1;

    text += `*${num}.* 📦 \`${match.documentFileName}\`\n`;
    text += `    🎯 O'xshashlik: *${percent}%*\n`;
    text += `    📡 Manba: @${match.channelUsername}\n`;
    if (match.category) text += `    🏷 ${match.category}\n`;
    text += `\n`;
  }

  // Inline tugmalar
  const buttons = [];

  // Yuklab olish tugmalari (har bir natija uchun)
  const downloadRow = pageData.items.map((match, i) => {
    const num = pageData.page * session.pageSize + i + 1;
    // @ belgisini olib tashla callback data'da (faqat username)
    const username = match.channelUsername.startsWith('@') 
      ? match.channelUsername.substring(1) 
      : match.channelUsername;
    const encodedUsername = encodeURIComponent(username);
    const photoMessageId = match.photoMessageId || 0;
    return Markup.button.callback(`⬇️ #${num}`, `download_${encodedUsername}|${match.messageId}|${photoMessageId}`);
  });
  buttons.push(downloadRow);

  // Navigatsiya tugmalari
  const navRow = [];
  if (pageData.hasPrev) navRow.push(Markup.button.callback('⬅️ Oldingi', 'prev_page'));
  if (pageData.hasNext) navRow.push(Markup.button.callback('Keyingi ➡️', 'next_page'));
  if (navRow.length > 0) buttons.push(navRow);

  // CGTrader qidirish tugmasi
  buttons.push([Markup.button.callback('🌐 CGTrader\'dan ham qidirish', 'cgtrader_search')]);

  const keyboard = Markup.inlineKeyboard(buttons);

  if (isEdit) {
    try {
      await ctx.editMessageText(text, { parse_mode: 'Markdown', ...keyboard });
    } catch (editErr) {
      // Agar edit ishlamasa (masalan, xabar o'zgarmagan bo'lsa), yangi xabar yuboramiz
      await ctx.reply(text, { parse_mode: 'Markdown', ...keyboard });
    }
  } else {
    await ctx.reply(text, { parse_mode: 'Markdown', ...keyboard });
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

async function sendChannelMediaToChat(ctx, channelUsername, primaryMessageId, fallbackMessageId = 0) {
  const client = await getChannelClient();
  const channel = channelUsername.startsWith('@') ? channelUsername.slice(1) : channelUsername;
  const candidateIds = [primaryMessageId];
  if (fallbackMessageId > 0 && fallbackMessageId !== primaryMessageId) {
    candidateIds.push(fallbackMessageId);
  }

  const inputEntity = await client.getInputEntity(channel);
  const messages = await client.getMessages(inputEntity, {
    ids: candidateIds
  });

  const message = messages.find((msg) => msg.id === primaryMessageId)
    || messages.find((msg) => msg.id === fallbackMessageId)
    || messages[0];

  if (!message) {
    throw new Error('message to forward not found');
  }

  let fileName = `channel_${message.id}.bin`;
  let buffer;

  if (message.document) {
    const filenameAttr = (message.document.attributes || []).find(
      (attr) => attr.className === 'DocumentAttributeFilename'
    );
    fileName = filenameAttr ? filenameAttr.fileName : fileName;
    buffer = await client.downloadMedia(message);
    await ctx.telegram.sendDocument(ctx.chat.id, {
      source: Buffer.from(buffer),
      filename: fileName
    });
  } else if (message.photo) {
    buffer = await client.downloadMedia(message);
    await ctx.telegram.sendPhoto(ctx.chat.id, {
      source: Buffer.from(buffer)
    });
  } else {
    throw new Error('message to forward not found');
  }
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
      .catch(() => {});
  }
});

// ─── Botni ishga tushirish ──────────────────────────────────────────────────
async function launchBotWithRetry(maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await axios.get(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/getMe`, {
        timeout: 60000
      });

      await bot.launch({ dropPendingUpdates: true });
      console.log('');
      console.log('═══════════════════════════════════════════');
      console.log('  🤖 Grabit3D Bot ishga tushdi!');
      console.log('  📸 Rasm qidiruv ✅');
      console.log('  ✍️  Matn qidiruv ✅');
      console.log('  🌐 CGTrader fallback ✅');
      console.log('  📊 Statistika ✅');
      console.log('═══════════════════════════════════════════');
      console.log('');
      return;
    } catch (err) {
      console.warn(`⚠️ Telegraf launch urinishi ${attempt}/${maxAttempts} muvaffaqiyatsiz: ${err.message}`);
      if (attempt === maxAttempts) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

async function main() {
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

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));