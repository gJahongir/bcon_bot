/**
 * Admin panel wizard holatlarini boshqarish moduli.
 *
 * Admin biror jarayonni boshlaganda (reklama xabarini kutilmoqda,
 * model qidiruv so'rovini kutilmoqda va h.k.) uning holati shu yerda
 * xotirada saqlanadi. 15 daqiqa faoliyatsizlikdan keyin holat tugaydi.
 */

const STATE_TTL_MS = 15 * 60 * 1000; // 15 daqiqa

/** @type {Map<number, Object>} userId -> state */
const states = new Map();

/**
 * Admin uchun yangi holat o'rnatadi (eski holatni almashtiradi).
 * @param {number} userId
 * @param {Object} state
 */
function setState(userId, state) {
  states.set(userId, { ...state, updatedAt: Date.now() });
}

/**
 * Admin holatini qaytaradi (TTL tekshiruvi bilan).
 * @param {number} userId
 * @returns {Object|null}
 */
function getState(userId) {
  const state = states.get(userId);
  if (!state) return null;

  if (Date.now() - state.updatedAt > STATE_TTL_MS) {
    states.delete(userId);
    return null;
  }

  state.updatedAt = Date.now();
  return state;
}

/**
 * Admin holatini o'chiradi.
 * @param {number} userId
 */
function clearState(userId) {
  states.delete(userId);
}

/**
 * Muddati o'tgan holatlarni tozalaydi.
 */
function cleanupExpiredStates() {
  const now = Date.now();
  for (const [userId, state] of states) {
    if (now - state.updatedAt > STATE_TTL_MS) {
      states.delete(userId);
    }
  }
}

// Har 10 daqiqada tozalash
setInterval(cleanupExpiredStates, 10 * 60 * 1000);

module.exports = { setState, getState, clearState };
