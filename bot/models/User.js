const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  telegramId: { type: Number, required: true, unique: true, index: true },
  firstName: { type: String, default: '' },
  lastName: { type: String, default: '' },
  username: { type: String, default: '' },
  languageCode: { type: String, default: '' },
  isBlocked: { type: Boolean, default: false }, // admin tomonidan bloklangan
  botBlocked: { type: Boolean, default: false }, // foydalanuvchi botni bloklagan
  searchCount: { type: Number, default: 0 },
  lastQuery: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now },
  lastActiveAt: { type: Date, default: Date.now }
});

userSchema.index({ isBlocked: 1, botBlocked: 1 });
userSchema.index({ lastActiveAt: -1 });

module.exports = mongoose.model('User', userSchema, 'users');
