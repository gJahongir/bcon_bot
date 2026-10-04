const User = require('../models/User');

/**
 * Foydalanuvchini bazaga yozadi yoki mavjudini yangilaydi (upsert).
 * Har bir xabar/callback'da chaqiriladi.
 * @param {Object} tgUser - Telegram from obyekti
 * @param {{ isSearch?: boolean, query?: string }} options
 * @returns {Promise<Object|null>} - yangilangan foydalanuvchi hujjati
 */
async function trackUser(tgUser, { isSearch = false, query = '' } = {}) {
  if (!tgUser || !tgUser.id) return null;

  const update = {
    $set: {
      firstName: tgUser.first_name || '',
      lastName: tgUser.last_name || '',
      username: tgUser.username || '',
      languageCode: tgUser.language_code || '',
      botBlocked: false,
      lastActiveAt: new Date()
    },
    $setOnInsert: {
      telegramId: tgUser.id,
      createdAt: new Date()
    }
  };

  if (isSearch) {
    update.$inc = { searchCount: 1 };
    if (query) {
      update.$set.lastQuery = String(query).slice(0, 200);
    }
  }

  try {
    return await User.findOneAndUpdate(
      { telegramId: tgUser.id },
      update,
      { upsert: true, new: true, lean: true }
    );
  } catch (err) {
    // Bir vaqtda ikki so'rov upsert qilganda duplicate key bo'lishi mumkin — jim o'tkazamiz
    if (err.code !== 11000) {
      console.error('trackUser xatoligi:', err.message);
    }
    return null;
  }
}

/**
 * Foydalanuvchilar bo'yicha umumiy statistika.
 * @returns {Promise<{total: number, activeToday: number, activeWeek: number, newToday: number, blocked: number, botBlocked: number, totalSearches: number}>}
 */
async function getUserStats() {
  const dayAgo = new Date(Date.now() - 24 * 3600 * 1000);
  const weekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000);
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const [total, activeToday, activeWeek, newToday, blocked, botBlocked, searchAgg] = await Promise.all([
    User.countDocuments(),
    User.countDocuments({ lastActiveAt: { $gte: dayAgo } }),
    User.countDocuments({ lastActiveAt: { $gte: weekAgo } }),
    User.countDocuments({ createdAt: { $gte: startOfToday } }),
    User.countDocuments({ isBlocked: true }),
    User.countDocuments({ botBlocked: true }),
    User.aggregate([{ $group: { _id: null, total: { $sum: '$searchCount' } } }])
  ]);

  return {
    total,
    activeToday,
    activeWeek,
    newToday,
    blocked,
    botBlocked,
    totalSearches: searchAgg.length > 0 ? searchAgg[0].total : 0
  };
}

/**
 * Sahifalangan foydalanuvchilar ro'yxati (oxirgi faollik bo'yicha).
 * @param {number} page
 * @param {number} pageSize
 * @returns {Promise<{total: number, users: Array, totalPages: number}>}
 */
async function getUsers(page = 0, pageSize = 8) {
  const [total, users] = await Promise.all([
    User.countDocuments(),
    User.find()
      .sort({ lastActiveAt: -1 })
      .skip(page * pageSize)
      .limit(pageSize)
      .lean()
  ]);

  return {
    total,
    users,
    totalPages: Math.max(1, Math.ceil(total / pageSize))
  };
}

/**
 * Bitta foydalanuvchini ID bo'yicha oladi.
 * @param {number} telegramId
 * @returns {Promise<Object|null>}
 */
async function getUser(telegramId) {
  return User.findOne({ telegramId }).lean();
}

/**
 * Foydalanuvchini bloklaydi yoki blokdan chiqaradi.
 * @param {number} telegramId
 * @param {boolean} blocked
 */
async function setBlocked(telegramId, blocked) {
  return User.updateOne({ telegramId }, { $set: { isBlocked: blocked } });
}

/**
 * Foydalanuvchining interfeys tilini saqlaydi.
 * @param {number} telegramId
 * @param {string} language - til kodi (uz, ru, en, ...)
 */
async function setLanguage(telegramId, language) {
  return User.updateOne({ telegramId }, { $set: { language } });
}

/**
 * Foydalanuvchini bazadan butunlay o'chiradi.
 * @param {number} telegramId
 */
async function deleteUser(telegramId) {
  return User.deleteOne({ telegramId });
}

/**
 * Foydalanuvchi botni bloklaganini belgilaydi (broadcast 403/400 xatoligida).
 * @param {number} telegramId
 */
async function markBotBlocked(telegramId) {
  return User.updateOne({ telegramId }, { $set: { botBlocked: true } });
}

/**
 * Reklama yuborish uchun qabul qiluvchilar ro'yxati.
 * (admin bloklamagan va botni bloklamagan foydalanuvchilar)
 * @returns {Promise<Array<{telegramId: number}>>}
 */
async function getBroadcastRecipients() {
  return User.find(
    { isBlocked: false, botBlocked: false },
    { telegramId: 1 }
  ).lean();
}

/**
 * Reklama qabul qiluvchilarning soni.
 * @returns {Promise<number>}
 */
async function getBroadcastCount() {
  return User.countDocuments({ isBlocked: false, botBlocked: false });
}

module.exports = {
  trackUser,
  getUserStats,
  getUsers,
  getUser,
  setBlocked,
  setLanguage,
  deleteUser,
  markBotBlocked,
  getBroadcastRecipients,
  getBroadcastCount
};
