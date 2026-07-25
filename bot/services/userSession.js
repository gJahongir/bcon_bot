/**
 * Foydalanuvchi sessiyalarini boshqarish moduli.
 *
 * Har bir foydalanuvchining oxirgi qidiruv natijalarini xotirada saqlaydi —
 * bu sahifalash (pagination) va inline tugmalar callback bilan ishlash uchun kerak.
 *
 * Sessiyalar 30 daqiqa faoliyatsizlikdan keyin avtomatik tozalanadi.
 */

const SESSION_TTL_MS = 30 * 60 * 1000; // 30 daqiqa

/** @type {Map<number, UserSession>} userId -> session */
const sessions = new Map();

/**
 * @typedef {Object} UserSession
 * @property {Array} results - oxirgi qidiruv natijalari (barcha topilgan modellar)
 * @property {number} currentPage - hozirgi sahifa raqami (0-indexed)
 * @property {number} pageSize - har sahifadagi natijalar soni
 * @property {string} queryType - qidiruv turi: 'image' yoki 'text'
 * @property {string} queryDescription - Gemini tomonidan aniqlangan tavsif
 * @property {number} lastActivity - oxirgi faoliyat vaqti (timestamp)
 */

/**
 * Foydalanuvchi uchun yangi qidiruv sessiyasini yaratadi yoki mavjudini yangilaydi.
 * @param {number} userId - Telegram user ID
 * @param {Array} results - qidiruv natijalari
 * @param {string} queryType - 'image' | 'text'
 * @param {string} queryDescription - qidiruv tavsifi
 * @returns {UserSession}
 */
function createSession(userId, results, queryType = 'image', queryDescription = '') {
  const session = {
    results,
    currentPage: 0,
    pageSize: 3,
    queryType,
    queryDescription,
    lastActivity: Date.now()
  };
  sessions.set(userId, session);
  return session;
}

/**
 * Foydalanuvchi sessiyasini oladi.
 * @param {number} userId
 * @returns {UserSession|null}
 */
function getSession(userId) {
  const session = sessions.get(userId);
  if (!session) return null;

  // TTL tekshirish
  if (Date.now() - session.lastActivity > SESSION_TTL_MS) {
    sessions.delete(userId);
    return null;
  }

  session.lastActivity = Date.now();
  return session;
}

/**
 * Hozirgi sahifadagi natijalarni qaytaradi.
 * @param {number} userId
 * @returns {{ items: Array, page: number, totalPages: number, hasNext: boolean, hasPrev: boolean } | null}
 */
function getCurrentPage(userId) {
  const session = getSession(userId);
  if (!session) return null;

  const { results, currentPage, pageSize } = session;
  const totalPages = Math.ceil(results.length / pageSize);
  const start = currentPage * pageSize;
  const items = results.slice(start, start + pageSize);

  return {
    items,
    page: currentPage,
    totalPages,
    hasNext: currentPage < totalPages - 1,
    hasPrev: currentPage > 0
  };
}

/**
 * Keyingi sahifaga o'tadi.
 * @param {number} userId
 * @returns {{ items: Array, page: number, totalPages: number, hasNext: boolean, hasPrev: boolean } | null}
 */
function nextPage(userId) {
  const session = getSession(userId);
  if (!session) return null;

  const totalPages = Math.ceil(session.results.length / session.pageSize);
  if (session.currentPage < totalPages - 1) {
    session.currentPage++;
  }
  return getCurrentPage(userId);
}

/**
 * Oldingi sahifaga qaytadi.
 * @param {number} userId
 * @returns {{ items: Array, page: number, totalPages: number, hasNext: boolean, hasPrev: boolean } | null}
 */
function prevPage(userId) {
  const session = getSession(userId);
  if (!session) return null;

  if (session.currentPage > 0) {
    session.currentPage--;
  }
  return getCurrentPage(userId);
}

/**
 * Foydalanuvchi sessiyasini o'chiradi.
 * @param {number} userId
 */
function clearSession(userId) {
  sessions.delete(userId);
}

/**
 * Muddati o'tgan sessiyalarni tozalaydi.
 * Har 10 daqiqada avtomatik ishga tushadi.
 */
function cleanupExpiredSessions() {
  const now = Date.now();
  let cleaned = 0;
  for (const [userId, session] of sessions) {
    if (now - session.lastActivity > SESSION_TTL_MS) {
      sessions.delete(userId);
      cleaned++;
    }
  }
  if (cleaned > 0) {
    console.log(`🧹 ${cleaned} ta muddati o'tgan sessiya tozalandi`);
  }
}

// Har 10 daqiqada tozalash
setInterval(cleanupExpiredSessions, 10 * 60 * 1000);

module.exports = {
  createSession,
  getSession,
  getCurrentPage,
  nextPage,
  prevPage,
  clearSession
};
