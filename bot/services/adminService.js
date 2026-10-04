/**
 * Admin huquqini tekshirish moduli.
 *
 * Adminlar .env faylida saqlanadi:
 *   ADMIN_IDS=123456789,987654321   (bir nechta admin — vergul bilan)
 * yoki eski variant:
 *   ADMIN_USER_ID=123456789         (bitta admin)
 */

/**
 * .env'dan admin ID'lar ro'yxatini qaytaradi.
 * @returns {number[]}
 */
function getAdminIds() {
  const raw = process.env.ADMIN_IDS || process.env.ADMIN_USER_ID || '';
  return String(raw)
    .split(',')
    .map((part) => parseInt(part.trim(), 10))
    .filter((num) => Number.isFinite(num));
}

/**
 * Foydalanuvchi admin ekanligini tekshiradi.
 * @param {number|string} userId - Telegram user ID
 * @returns {boolean}
 */
function isAdmin(userId) {
  const id = Number(userId);
  if (!Number.isFinite(id)) return false;
  return getAdminIds().includes(id);
}

module.exports = { getAdminIds, isAdmin };
