/**
 * Admin panel — /admin buyrug'i va unga tegishli barcha logika.
 *
 * Bo'limlar:
 *  📊 Statistika        — foydalanuvchilar, qidiruvlar, modellar, mashhur modellar
 *  👥 Foydalanuvchilar  — ro'yxat, bloklash/ochish, bazadan o'chirish
 *  📦 Modellar          — qidiruv, kategoriya/teg tahrirlash, o'chirish
 *  🔄 Katalog           — xotiradagi katalogni yangilash / to'liq qayta yuklash
 *  📢 Reklama           — barcha foydalanuvchilarga text yoki rasm yuborish
 *
 * Admin huquqi .env dagi ADMIN_IDS (vergul bilan) yoki ADMIN_USER_ID orqali aniqlanadi.
 *
 * MUHIM: bu modul index.js'da BARCHA boshqa handler'lardan OLDIN ro'yxatdan o'tishi
 * kerak — shunda admin wizard xabarlari (reklama matni, rasm) qidiruv handler'iga
 * o'tmaydi va bloklangan foydalanuvchilar botdan foydalana olmaydi.
 */

const { Markup } = require('telegraf');
const Model3D = require('../models/Models3D');
const { isAdmin } = require('../services/adminService');
const adminState = require('../services/adminState');
const userService = require('../services/userService');
const { getStats, getPopularModels } = require('../services/statsService');

const USERS_PAGE_SIZE = 8;
const MODELS_PAGE_SIZE = 5;
const MODEL_SEARCH_LIMIT = 50;
const BROADCAST_DELAY_MS = 50; // ~20 xabar/soniya — Telegram limiti uchun xavfsiz

// ─── Yordamchi funksiyalar ──────────────────────────────────────────────────

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeRegex(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatDate(date) {
  if (!date) return '—';
  try {
    return new Date(date).toLocaleString('uz-UZ');
  } catch (_) {
    return new Date(date).toISOString();
  }
}

function mainMenuText() {
  return '🛠 <b>Admin panel</b>\n\nQuyidagi bo\'limlardan birini tanlang:';
}

function mainMenuKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📊 Statistika', 'adm_stats')],
    [Markup.button.callback('👥 Foydalanuvchilar', 'adm_users:0')],
    [Markup.button.callback('📦 Modellar', 'adm_models')],
    [Markup.button.callback('🔄 Katalog', 'adm_catalog')],
    [Markup.button.callback('📢 Reklama yuborish', 'adm_bc')]
  ]);
}

function backToMenuKeyboard() {
  return Markup.inlineKeyboard([[Markup.button.callback('◀️ Menyu', 'adm_menu')]]);
}

function cancelKeyboard(backData) {
  return Markup.inlineKeyboard([[Markup.button.callback('❌ Bekor qilish', backData)]]);
}

function broadcastConfirmKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('✅ Yuborish', 'adm_bc_send')],
    [Markup.button.callback('❌ Bekor qilish', 'adm_bc_cancel')]
  ]);
}

/**
 * Panel xabarini tahrirlaydi; tahrirlab bo'lmasa (eski xabar) yangi yuboradi.
 */
async function editPanel(ctx, text, keyboard = null) {
  const extra = { parse_mode: 'HTML', disable_web_page_preview: true };
  if (keyboard) Object.assign(extra, keyboard);
  try {
    await ctx.editMessageText(text, extra);
  } catch (err) {
    if (/message is not modified/i.test(err?.message || '')) return;
    await ctx.reply(text, extra).catch(() => {});
  }
}

// ─── Asosiy ro'yxatdan o'tkazish ────────────────────────────────────────────

module.exports = function registerAdminCommand(bot, deps) {
  const { refreshCatalog, getCatalogInfo, loadCatalog, removeFromCatalog, updateCatalogItem } = deps;

  // ── 1. Foydalanuvchini kuzatish + blok tekshiruvi (barcha update'lar uchun) ──
  bot.use(async (ctx, next) => {
    const tgUser = ctx.from;
    if (!tgUser) return next();

    try {
      // Admin wizard jarayonida bo'lsa — bu xabar qidiruv hisoblanmaydi
      const hasPendingWizard = isAdmin(tgUser.id) && !!adminState.getState(tgUser.id);

      let isSearch = false;
      let query = '';
      if (!hasPendingWizard && ctx.message) {
        if (ctx.message.photo) {
          isSearch = true;
          query = '[rasm]';
        } else if (ctx.message.text && !ctx.message.text.startsWith('/')) {
          isSearch = true;
          query = ctx.message.text;
        }
      }

      const user = await userService.trackUser(tgUser, { isSearch, query });

      if (user && user.isBlocked && !isAdmin(tgUser.id)) {
        if (ctx.callbackQuery) {
          await ctx.answerCbQuery('🚫 Siz bloklangansiz.').catch(() => {});
        } else {
          await ctx.reply('🚫 Siz botdan foydalanishdan bloklangansiz.').catch(() => {});
        }
        return; // next() chaqirilmaydi — zanjir to'xtaydi
      }
    } catch (err) {
      console.error('Foydalanuvchini kuzatishda xatolik:', err.message);
    }

    return next();
  });

  // ── 2. /admin buyrug'i ────────────────────────────────────────────────────
  bot.command('admin', async (ctx) => {
    if (!isAdmin(ctx.from.id)) {
      return ctx.reply('⛔️ Bu bo\'lim faqat administrator uchun.');
    }
    adminState.clearState(ctx.from.id);
    await ctx.reply(mainMenuText(), { parse_mode: 'HTML', ...mainMenuKeyboard() });
  });

  // ── 3. Admin wizard uchun text interceptor (qidiruvdan OLDIN ishlaydi) ────
  bot.on('text', async (ctx, next) => {
    if (!isAdmin(ctx.from.id)) return next();
    if (ctx.message.text.startsWith('/')) return next();

    const state = adminState.getState(ctx.from.id);
    if (!state) return next();

    try {
      await handleAdminText(ctx, state);
    } catch (err) {
      console.error('Admin text xatoligi:', err);
      await ctx.reply('❌ Xatolik yuz berdi. Qaytadan urinib ko\'ring.').catch(() => {});
    }
  });

  // ── 4. Admin wizard uchun photo interceptor (rasm qidiruvidan OLDIN) ──────
  bot.on('photo', async (ctx, next) => {
    if (!isAdmin(ctx.from.id)) return next();

    const state = adminState.getState(ctx.from.id);
    if (!state || state.type !== 'broadcast_photo') return next();

    try {
      await handleBroadcastPhoto(ctx);
    } catch (err) {
      console.error('Admin photo xatoligi:', err);
      await ctx.reply('❌ Xatolik yuz berdi. Qaytadan urinib ko\'ring.').catch(() => {});
    }
  });

  // ── 5. Admin callback'lar routeri ─────────────────────────────────────────
  bot.on('callback_query', async (ctx, next) => {
    const data = ctx.callbackQuery.data || '';
    if (!data.startsWith('adm_')) return next(); // boshqa callback'lar index.js'ga o'tadi

    if (!isAdmin(ctx.from.id)) {
      return ctx.answerCbQuery('⛔️ Ruxsat yo\'q.').catch(() => {});
    }

    try {
      await routeCallback(ctx, data);
    } catch (err) {
      console.error('Admin callback xatoligi:', err);
      await ctx.answerCbQuery('❌ Xatolik yuz berdi.').catch(() => {});
    }
  });

  // ─── Callback router ──────────────────────────────────────────────────────

  async function routeCallback(ctx, data) {
    const [action, p1] = data.split(':');

    switch (action) {
      case 'adm_menu':
        adminState.clearState(ctx.from.id);
        await ctx.answerCbQuery().catch(() => {});
        await editPanel(ctx, mainMenuText(), mainMenuKeyboard());
        break;

      case 'adm_stats':
        await ctx.answerCbQuery().catch(() => {});
        await renderStatsPage(ctx);
        break;

      case 'adm_users':
        await ctx.answerCbQuery().catch(() => {});
        await renderUsersPage(ctx, parseInt(p1, 10) || 0);
        break;

      case 'adm_user':
        await ctx.answerCbQuery().catch(() => {});
        await renderUserDetail(ctx, Number(p1));
        break;

      case 'adm_ublock':
        await setUserBlocked(ctx, Number(p1), true);
        break;

      case 'adm_uunblock':
        await setUserBlocked(ctx, Number(p1), false);
        break;

      case 'adm_udel':
        await ctx.answerCbQuery().catch(() => {});
        await renderUserDeleteConfirm(ctx, Number(p1));
        break;

      case 'adm_udelok':
        await deleteUserById(ctx, Number(p1));
        break;

      case 'adm_models':
        adminState.setState(ctx.from.id, { type: 'model_search' });
        await ctx.answerCbQuery().catch(() => {});
        await editPanel(
          ctx,
          '📦 <b>Model qidirish</b>\n\nModel nomi, kodi, kategoriyasi yoki tegini yozing:',
          cancelKeyboard('adm_menu')
        );
        break;

      case 'adm_mres':
        await ctx.answerCbQuery().catch(() => {});
        await renderModelResultsPage(ctx, p1 === 'back' ? null : (parseInt(p1, 10) || 0), 'edit');
        break;

      case 'adm_model':
        await ctx.answerCbQuery().catch(() => {});
        await renderModelDetail(ctx, p1, 'edit');
        break;

      case 'adm_mdel':
        await ctx.answerCbQuery().catch(() => {});
        await renderModelDeleteConfirm(ctx, p1);
        break;

      case 'adm_mdelok':
        await deleteModelById(ctx, p1);
        break;

      case 'adm_mcat':
        adminState.setState(ctx.from.id, { type: 'model_edit_cat', modelId: p1 });
        await ctx.answerCbQuery().catch(() => {});
        await editPanel(
          ctx,
          '🏷 Yangi kategoriyani yozing.\n<i>Tozalash uchun faqat <b>-</b> belgisini yuboring.</i>',
          cancelKeyboard(`adm_model:${p1}`)
        );
        break;

      case 'adm_mtags':
        adminState.setState(ctx.from.id, { type: 'model_edit_tags', modelId: p1 });
        await ctx.answerCbQuery().catch(() => {});
        await editPanel(
          ctx,
          '🔖 Teglarni vergul bilan yozing (masalan: <code>stul, mebel, yog\'och</code>).\n<i>Tozalash uchun <b>-</b> yuboring.</i>',
          cancelKeyboard(`adm_model:${p1}`)
        );
        break;

      case 'adm_catalog':
        await ctx.answerCbQuery().catch(() => {});
        await renderCatalogPage(ctx);
        break;

      case 'adm_crefresh': {
        await ctx.answerCbQuery('🔄 Yangilanmoqda...').catch(() => {});
        const added = await refreshCatalog();
        await renderCatalogPage(ctx, `✅ ${added} ta yangi model qo'shildi.`);
        break;
      }

      case 'adm_creload': {
        await ctx.answerCbQuery('♻️ To\'liq yuklanmoqda...').catch(() => {});
        const count = await loadCatalog(true);
        await renderCatalogPage(ctx, `✅ ${count} ta model qayta yuklandi.`);
        break;
      }

      case 'adm_bc':
        adminState.clearState(ctx.from.id);
        await ctx.answerCbQuery().catch(() => {});
        await renderBroadcastMenu(ctx);
        break;

      case 'adm_bc_text':
        adminState.setState(ctx.from.id, { type: 'broadcast_text' });
        await ctx.answerCbQuery().catch(() => {});
        await editPanel(
          ctx,
          '✍️ Yubormoqchi bo\'lgan <b>matn xabaringizni</b> yozing:',
          cancelKeyboard('adm_bc')
        );
        break;

      case 'adm_bc_photo':
        adminState.setState(ctx.from.id, { type: 'broadcast_photo' });
        await ctx.answerCbQuery().catch(() => {});
        await editPanel(
          ctx,
          '🖼 Yubormoqchi bo\'lgan <b>rasmingizni</b> yuboring (izoh bilan yoki izohsiz):',
          cancelKeyboard('adm_bc')
        );
        break;

      case 'adm_bc_send':
        await runBroadcast(ctx);
        break;

      case 'adm_bc_cancel':
        adminState.clearState(ctx.from.id);
        await ctx.answerCbQuery('❌ Bekor qilindi').catch(() => {});
        await editPanel(ctx, mainMenuText(), mainMenuKeyboard());
        break;

      default:
        await ctx.answerCbQuery().catch(() => {});
    }
  }

  // ─── Wizard text handler ──────────────────────────────────────────────────

  async function handleAdminText(ctx, state) {
    const rawText = ctx.message.text;

    // Reklama matni kutilmoqda
    if (state.type === 'broadcast_text') {
      const draft = { kind: 'text', text: rawText, entities: ctx.message.entities || [] };
      adminState.setState(ctx.from.id, { type: 'broadcast_confirm', draft });
      await ctx.reply('📢 Xabarning ko\'rinishi:');
      await ctx.reply(draft.text, { entities: draft.entities.length ? draft.entities : undefined });
      await ctx.reply('☝️ Shu xabar barcha foydalanuvchilarga yuboriladi. Tasdiqlaysizmi?', broadcastConfirmKeyboard());
      return;
    }

    // Reklama rasmi kutilganda text kelsa
    if (state.type === 'broadcast_photo') {
      await ctx.reply('🖼 Iltimos, rasm yuboring (matn emas).', cancelKeyboard('adm_bc'));
      return;
    }

    // Model qidiruv so'rovi kutilmoqda
    if (state.type === 'model_search') {
      const query = rawText.trim();
      if (query.length < 2) {
        await ctx.reply('⚠️ Kamida 2 ta harf yozing.');
        return;
      }
      const docs = await searchModels(query);
      if (docs.length === 0) {
        adminState.clearState(ctx.from.id);
        await ctx.reply(`😕 "${escapeHtml(query)}" bo'yicha model topilmadi.`, {
          parse_mode: 'HTML',
          ...backToMenuKeyboard()
        });
        return;
      }
      adminState.setState(ctx.from.id, {
        type: 'model_results',
        query,
        ids: docs.map((d) => d._id.toString()),
        page: 0
      });
      await renderModelResultsPage(ctx, 0, 'reply');
      return;
    }

    // Kategoriya tahrirlash kutilmoqda
    if (state.type === 'model_edit_cat') {
      const category = rawText.trim() === '-' ? '' : rawText.trim().slice(0, 100);
      await Model3D.updateOne({ _id: state.modelId }, { $set: { category } });
      updateCatalogItem(state.modelId, { category });
      adminState.clearState(ctx.from.id);
      await ctx.reply('✅ Kategoriya yangilandi.');
      await renderModelDetail(ctx, state.modelId, 'reply');
      return;
    }

    // Teglar tahrirlash kutilmoqda
    if (state.type === 'model_edit_tags') {
      const tags = rawText.trim() === '-'
        ? []
        : rawText.split(',').map((t) => t.trim()).filter(Boolean).slice(0, 20);
      await Model3D.updateOne({ _id: state.modelId }, { $set: { tags } });
      updateCatalogItem(state.modelId, { tags });
      adminState.clearState(ctx.from.id);
      await ctx.reply('✅ Teglar yangilandi.');
      await renderModelDetail(ctx, state.modelId, 'reply');
      return;
    }
  }

  // ─── Broadcast photo handler ──────────────────────────────────────────────

  async function handleBroadcastPhoto(ctx) {
    const photos = ctx.message.photo;
    const fileId = photos[photos.length - 1].file_id;
    const draft = {
      kind: 'photo',
      fileId,
      caption: ctx.message.caption || '',
      captionEntities: ctx.message.caption_entities || []
    };
    adminState.setState(ctx.from.id, { type: 'broadcast_confirm', draft });
    await ctx.reply('📢 Xabarning ko\'rinishi:');
    await ctx.replyWithPhoto(fileId, {
      caption: draft.caption || undefined,
      caption_entities: draft.captionEntities.length ? draft.captionEntities : undefined
    });
    await ctx.reply('☝️ Shu xabar barcha foydalanuvchilarga yuboriladi. Tasdiqlaysizmi?', broadcastConfirmKeyboard());
  }

  // ─── 📊 Statistika sahifasi ───────────────────────────────────────────────

  async function renderStatsPage(ctx) {
    const [modelStats, userStats, popular] = await Promise.all([
      getStats(),
      userService.getUserStats(),
      getPopularModels(5)
    ]);
    const info = getCatalogInfo();

    let text = '📊 <b>Admin statistika</b>\n\n';

    text += '👥 <b>Foydalanuvchilar:</b>\n';
    text += `  • Jami: <b>${userStats.total}</b> ta (+${userStats.newToday} bugun)\n`;
    text += `  • Faol (24 soat / 7 kun): <b>${userStats.activeToday}</b> / <b>${userStats.activeWeek}</b>\n`;
    text += `  • 🚫 Bloklangan: ${userStats.blocked} ta\n`;
    text += `  • ⛔️ Botni bloklagan: ${userStats.botBlocked} ta\n`;
    text += `  • 🔍 Jami qidiruvlar: <b>${userStats.totalSearches}</b>\n`;

    text += '\n📦 <b>Modellar:</b>\n';
    text += `  • Jami: <b>${modelStats.totalModels}</b> ta\n`;
    text += `  • 🧬 Embedding tayyor: <b>${modelStats.withEmbedding}</b> ta\n`;
    text += `  • 📡 Kanallar: <b>${modelStats.channels.length}</b> ta\n`;
    text += `  • 🧠 Xotiradagi katalog: <b>${info.count}</b> ta\n`;

    if (popular.length > 0) {
      text += '\n🏆 <b>Mashhur modellar:</b>\n';
      popular.forEach((m, i) => {
        text += `  ${i + 1}. ${escapeHtml(m.documentFileName)} — <b>${m.searchCount}</b> marta\n`;
      });
    }

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('🔄 Yangilash', 'adm_stats')],
      [Markup.button.callback('◀️ Menyu', 'adm_menu')]
    ]);
    await editPanel(ctx, text, keyboard);
  }

  // ─── 👥 Foydalanuvchilar sahifalari ───────────────────────────────────────

  async function renderUsersPage(ctx, page) {
    const { total, users, totalPages } = await userService.getUsers(page, USERS_PAGE_SIZE);
    const currentPage = Math.max(0, Math.min(page, totalPages - 1));

    let text = `👥 <b>Foydalanuvchilar</b> — ${total} ta\n`;
    text += `📄 Sahifa ${currentPage + 1}/${totalPages}\n\n`;

    const rows = [];
    users.forEach((u, i) => {
      const num = currentPage * USERS_PAGE_SIZE + i + 1;
      const name = [u.firstName, u.lastName].filter(Boolean).join(' ').trim() || 'Nomsiz';
      const uname = u.username ? ` @${u.username}` : '';
      const mark = u.isBlocked ? '🚫' : u.botBlocked ? '⛔️' : '👤';
      text += `${num}. ${mark} ${escapeHtml(name)}${escapeHtml(uname)}\n`;
      rows.push([Markup.button.callback(`${num}. ${name.slice(0, 25)}`, `adm_user:${u.telegramId}`)]);
    });

    if (users.length === 0) {
      text += 'Hozircha foydalanuvchi yo\'q.\n';
    } else {
      text += '\n<i>🚫 — admin bloklagan, ⛔️ — botni bloklagan</i>';
    }

    const nav = [];
    if (currentPage > 0) nav.push(Markup.button.callback('⬅️ Oldingi', `adm_users:${currentPage - 1}`));
    if (currentPage < totalPages - 1) nav.push(Markup.button.callback('Keyingi ➡️', `adm_users:${currentPage + 1}`));
    if (nav.length > 0) rows.push(nav);
    rows.push([Markup.button.callback('◀️ Menyu', 'adm_menu')]);

    await editPanel(ctx, text, Markup.inlineKeyboard(rows));
  }

  async function renderUserDetail(ctx, telegramId) {
    const u = await userService.getUser(telegramId);
    if (!u) {
      await editPanel(ctx, '😕 Foydalanuvchi topilmadi.', backToMenuKeyboard());
      return;
    }

    const name = [u.firstName, u.lastName].filter(Boolean).join(' ').trim() || 'Nomsiz';
    const status = u.isBlocked ? '🚫 Bloklangan' : u.botBlocked ? '⛔️ Botni bloklagan' : '✅ Faol';

    let text = `👤 <b>${escapeHtml(name)}</b>\n\n`;
    text += `🆔 ID: <code>${u.telegramId}</code>\n`;
    text += `📱 Username: ${u.username ? '@' + escapeHtml(u.username) : '—'}\n`;
    text += `🔍 Qidiruvlar soni: <b>${u.searchCount || 0}</b>\n`;
    if (u.lastQuery) text += `🕵️ Oxirgi so'rov: ${escapeHtml(u.lastQuery)}\n`;
    text += `📅 Qo'shilgan: ${formatDate(u.createdAt)}\n`;
    text += `🕐 Oxirgi faollik: ${formatDate(u.lastActiveAt)}\n`;
    text += `📊 Holat: <b>${status}</b>\n`;

    const blockBtn = u.isBlocked
      ? Markup.button.callback('✅ Blokdan chiqarish', `adm_uunblock:${u.telegramId}`)
      : Markup.button.callback('🚫 Bloklash', `adm_ublock:${u.telegramId}`);

    const keyboard = Markup.inlineKeyboard([
      [blockBtn],
      [Markup.button.callback('🗑 Bazadan o\'chirish', `adm_udel:${u.telegramId}`)],
      [Markup.button.callback('◀️ Ro\'yxatga', 'adm_users:0')],
      [Markup.button.callback('◀️ Menyu', 'adm_menu')]
    ]);
    await editPanel(ctx, text, keyboard);
  }

  async function setUserBlocked(ctx, telegramId, blocked) {
    await userService.setBlocked(telegramId, blocked);
    await ctx.answerCbQuery(blocked ? '🚫 Foydalanuvchi bloklandi' : '✅ Blokdan chiqarildi').catch(() => {});
    await renderUserDetail(ctx, telegramId);
  }

  async function renderUserDeleteConfirm(ctx, telegramId) {
    const u = await userService.getUser(telegramId);
    const name = u ? [u.firstName, u.lastName].filter(Boolean).join(' ').trim() || 'Nomsiz' : String(telegramId);
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('✅ Ha, o\'chirish', `adm_udelok:${telegramId}`)],
      [Markup.button.callback('❌ Yo\'q', `adm_user:${telegramId}`)]
    ]);
    await editPanel(
      ctx,
      `⚠️ <b>${escapeHtml(name)}</b> (<code>${telegramId}</code>) ni bazadan butunlay o'chirmoqchimisiz?`,
      keyboard
    );
  }

  async function deleteUserById(ctx, telegramId) {
    await userService.deleteUser(telegramId);
    await ctx.answerCbQuery('🗑 O\'chirildi').catch(() => {});
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('◀️ Ro\'yxatga', 'adm_users:0')],
      [Markup.button.callback('◀️ Menyu', 'adm_menu')]
    ]);
    await editPanel(ctx, `🗑 Foydalanuvchi (<code>${telegramId}</code>) bazadan o'chirildi.`, keyboard);
  }

  // ─── 📦 Modellar sahifalari ───────────────────────────────────────────────

  async function searchModels(query) {
    const rx = new RegExp(escapeRegex(query), 'i');
    return Model3D.find({
      $or: [
        { documentFileName: rx },
        { caption: rx },
        { modelCode: rx },
        { category: rx },
        { tags: rx }
      ]
    })
      .sort({ searchCount: -1, createdAt: -1 })
      .limit(MODEL_SEARCH_LIMIT)
      .lean();
  }

  async function renderModelResultsPage(ctx, page, mode = 'edit') {
    const state = adminState.getState(ctx.from.id);
    if (!state || state.type !== 'model_results' || !state.ids || state.ids.length === 0) {
      const text = '⏳ Qidiruv sessiyasi tugagan. "📦 Modellar" bo\'limidan qaytadan qidiring.';
      if (mode === 'edit') {
        await editPanel(ctx, text, backToMenuKeyboard());
      } else {
        await ctx.reply(text, backToMenuKeyboard());
      }
      return;
    }

    const totalPages = Math.ceil(state.ids.length / MODELS_PAGE_SIZE);
    const currentPage = page === null
      ? Math.max(0, Math.min(state.page || 0, totalPages - 1))
      : Math.max(0, Math.min(page, totalPages - 1));
    adminState.setState(ctx.from.id, { ...state, page: currentPage });

    const pageIds = state.ids.slice(currentPage * MODELS_PAGE_SIZE, (currentPage + 1) * MODELS_PAGE_SIZE);
    const docs = await Model3D.find({ _id: { $in: pageIds } })
      .select('modelCode documentFileName channelUsername category searchCount')
      .lean();

    // $in tartibni saqlamaydi — qidiruv tartibiga qaytaramiz
    const order = new Map(pageIds.map((id, idx) => [id, idx]));
    docs.sort((a, b) => order.get(a._id.toString()) - order.get(b._id.toString()));

    let text = `📦 <b>"${escapeHtml(state.query)}"</b> — ${state.ids.length} ta natija\n`;
    text += `📄 Sahifa ${currentPage + 1}/${totalPages}\n\n`;

    const rows = [];
    docs.forEach((m, i) => {
      const num = currentPage * MODELS_PAGE_SIZE + i + 1;
      text += `${num}. <b>${escapeHtml(m.documentFileName)}</b>\n    🆔 ${escapeHtml(m.modelCode)} | 🔍 ${m.searchCount || 0} marta\n`;
      rows.push([Markup.button.callback(`${num}. ${m.documentFileName.slice(0, 28)}`, `adm_model:${m._id.toString()}`)]);
    });

    if (docs.length === 0) {
      text += 'Bu sahifada model qolmadi.\n';
    }

    const nav = [];
    if (currentPage > 0) nav.push(Markup.button.callback('⬅️ Oldingi', `adm_mres:${currentPage - 1}`));
    if (currentPage < totalPages - 1) nav.push(Markup.button.callback('Keyingi ➡️', `adm_mres:${currentPage + 1}`));
    if (nav.length > 0) rows.push(nav);
    rows.push([Markup.button.callback('🔍 Yangi qidiruv', 'adm_models')]);
    rows.push([Markup.button.callback('◀️ Menyu', 'adm_menu')]);

    if (mode === 'edit') {
      await editPanel(ctx, text, Markup.inlineKeyboard(rows));
    } else {
      await ctx.reply(text, { parse_mode: 'HTML', disable_web_page_preview: true, ...Markup.inlineKeyboard(rows) });
    }
  }

  async function renderModelDetail(ctx, modelId, mode = 'edit') {
    const m = await Model3D.findById(modelId).select('-fileData').lean();
    if (!m) {
      const text = '😕 Model topilmadi (o\'chirilgan bo\'lishi mumkin).';
      if (mode === 'edit') {
        await editPanel(ctx, text, backToMenuKeyboard());
      } else {
        await ctx.reply(text, backToMenuKeyboard());
      }
      return;
    }

    const username = String(m.channelUsername || '').replace(/^@/, '');
    const sourceUrl = `https://t.me/${username}/${m.messageId}`;

    let text = `📦 <b>${escapeHtml(m.documentFileName)}</b>\n\n`;
    text += `🆔 Kod: <code>${escapeHtml(m.modelCode)}</code>\n`;
    text += `📡 Kanal: @${escapeHtml(username)}\n`;
    text += `🔗 <a href="${sourceUrl}">Manba xabar</a>\n`;
    text += `🏷 Kategoriya: ${m.category ? escapeHtml(m.category) : '—'}\n`;
    text += `🔖 Teglar: ${m.tags && m.tags.length > 0 ? escapeHtml(m.tags.join(', ')) : '—'}\n`;
    text += `🔍 Qidiruvlar: <b>${m.searchCount || 0}</b> marta\n`;
    if (m.fileSize) text += `💾 Hajmi: ${(m.fileSize / 1024 / 1024).toFixed(1)} MB\n`;
    text += `🧬 Embedding: ${m.embedding && m.embedding.length > 0 ? '✅' : '❌'}\n`;
    text += `📅 Qo'shilgan: ${formatDate(m.createdAt)}\n`;

    const id = m._id.toString();
    const rows = [
      [Markup.button.callback('🗑 O\'chirish', `adm_mdel:${id}`)],
      [
        Markup.button.callback('🏷 Kategoriya', `adm_mcat:${id}`),
        Markup.button.callback('🔖 Teglar', `adm_mtags:${id}`)
      ],
      [Markup.button.url('⬇️ Kanalda ko\'rish', sourceUrl)],
      [Markup.button.callback('◀️ Natijalarga', 'adm_mres:back')]
    ];

    if (mode === 'edit') {
      await editPanel(ctx, text, Markup.inlineKeyboard(rows));
    } else {
      await ctx.reply(text, { parse_mode: 'HTML', disable_web_page_preview: true, ...Markup.inlineKeyboard(rows) });
    }
  }

  async function renderModelDeleteConfirm(ctx, modelId) {
    const m = await Model3D.findById(modelId).select('documentFileName').lean();
    if (!m) {
      await ctx.answerCbQuery('😕 Model topilmadi.').catch(() => {});
      return;
    }
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('✅ Ha, o\'chirish', `adm_mdelok:${modelId}`)],
      [Markup.button.callback('❌ Yo\'q', `adm_model:${modelId}`)]
    ]);
    await editPanel(
      ctx,
      `⚠️ <b>${escapeHtml(m.documentFileName)}</b> ni o'chirmoqchimisiz?\n\nModel bazadan va xotiradagi katalogdan o'chiriladi.`,
      keyboard
    );
  }

  async function deleteModelById(ctx, modelId) {
    const m = await Model3D.findByIdAndDelete(modelId).select('documentFileName').lean();
    if (!m) {
      await ctx.answerCbQuery('😕 Model topilmadi.').catch(() => {});
      return;
    }

    removeFromCatalog(modelId);

    // Qidiruv natijalari ro'yxatidan ham olib tashlaymiz
    const state = adminState.getState(ctx.from.id);
    if (state && state.type === 'model_results') {
      adminState.setState(ctx.from.id, {
        ...state,
        ids: state.ids.filter((id) => id !== String(modelId))
      });
    }

    await ctx.answerCbQuery('🗑 O\'chirildi').catch(() => {});
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('◀️ Natijalarga', 'adm_mres:back')],
      [Markup.button.callback('◀️ Menyu', 'adm_menu')]
    ]);
    await editPanel(ctx, `🗑 <b>${escapeHtml(m.documentFileName)}</b> o'chirildi.`, keyboard);
  }

  // ─── 🔄 Katalog sahifasi ──────────────────────────────────────────────────

  async function renderCatalogPage(ctx, notice = '') {
    const info = getCatalogInfo();
    const stats = await getStats();

    let text = '🔄 <b>Katalog boshqaruvi</b>\n\n';
    if (notice) text += `${notice}\n\n`;
    text += `🧠 Xotiradagi modellar: <b>${info.count}</b> ta\n`;
    text += `🧬 Bazada embedding'li: <b>${stats.withEmbedding}</b> ta\n`;
    text += `📦 Bazada jami: <b>${stats.totalModels}</b> ta\n`;
    text += `⏰ Oxirgi yuklash: ${info.lastLoadTime ? formatDate(info.lastLoadTime) : '—'}\n`;

    if (stats.channels.length > 0) {
      text += `\n📡 <b>Kanallar (${stats.channels.length}):</b>\n`;
      text += stats.channels.map((ch) => `  • @${escapeHtml(ch)}`).join('\n');
    }

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('🔄 Yangi modellarni qo\'shish', 'adm_crefresh')],
      [Markup.button.callback('♻️ To\'liq qayta yuklash', 'adm_creload')],
      [Markup.button.callback('◀️ Menyu', 'adm_menu')]
    ]);
    await editPanel(ctx, text, keyboard);
  }

  // ─── 📢 Reklama (broadcast) ───────────────────────────────────────────────

  async function renderBroadcastMenu(ctx) {
    const total = await userService.getBroadcastCount();
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('✍️ Text yuborish', 'adm_bc_text')],
      [Markup.button.callback('🖼 Rasm yuborish', 'adm_bc_photo')],
      [Markup.button.callback('◀️ Menyu', 'adm_menu')]
    ]);
    await editPanel(
      ctx,
      `📢 <b>Reklama yuborish</b>\n\n👥 Qabul qiluvchilar: <b>${total}</b> ta foydalanuvchi\n\nXabar turini tanlang:`,
      keyboard
    );
  }

  async function runBroadcast(ctx) {
    const state = adminState.getState(ctx.from.id);
    if (!state || state.type !== 'broadcast_confirm' || !state.draft) {
      await ctx.answerCbQuery('⏳ Sessiya tugagan. Qaytadan urinib ko\'ring.').catch(() => {});
      return;
    }

    const draft = state.draft;
    adminState.clearState(ctx.from.id);
    await ctx.answerCbQuery('🚀 Yuborish boshlandi').catch(() => {});

    const recipients = await userService.getBroadcastRecipients();
    if (recipients.length === 0) {
      await editPanel(ctx, '😕 Xabar yuboriladigan foydalanuvchi topilmadi.', backToMenuKeyboard());
      return;
    }

    let sent = 0;
    let failed = 0;
    let blocked = 0;
    const total = recipients.length;
    const startedAt = Date.now();

    const renderProgress = (done = false) => {
      let text = done ? '✅ <b>Reklama yuborildi!</b>\n\n' : '📢 <b>Yuborilmoqda...</b>\n\n';
      text += `📨 Yuborildi: <b>${sent}</b>\n`;
      text += `❌ Yetib bormadi: <b>${failed}</b>\n`;
      text += `🚫 Botni bloklaganlar: <b>${blocked}</b>\n`;
      text += `📊 Jarayon: <b>${sent + failed}/${total}</b>`;
      if (done) {
        text += `\n⏱ Sarflangan vaqt: ${((Date.now() - startedAt) / 1000).toFixed(0)}s`;
      }
      return text;
    };

    await editPanel(ctx, renderProgress());

    let lastEdit = Date.now();
    for (const recipient of recipients) {
      const uid = recipient.telegramId;
      try {
        if (draft.kind === 'photo') {
          await ctx.telegram.sendPhoto(uid, draft.fileId, {
            caption: draft.caption || undefined,
            caption_entities: draft.captionEntities && draft.captionEntities.length ? draft.captionEntities : undefined
          });
        } else {
          await ctx.telegram.sendMessage(uid, draft.text, {
            entities: draft.entities && draft.entities.length ? draft.entities : undefined
          });
        }
        sent++;
      } catch (err) {
        failed++;
        const code = err?.response?.error_code;
        if (code === 403 || code === 400) {
          blocked++;
          userService.markBotBlocked(uid).catch(() => {});
        }
      }

      // Progressni har 4 soniyada yangilab turamiz
      if (Date.now() - lastEdit > 4000) {
        lastEdit = Date.now();
        await editPanel(ctx, renderProgress());
      }

      await sleep(BROADCAST_DELAY_MS);
    }

    await editPanel(ctx, renderProgress(true), backToMenuKeyboard());
  }
};
