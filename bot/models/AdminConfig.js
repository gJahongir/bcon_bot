const mongoose = require('mongoose');

const adminConfigSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true, default: 'bot_admin_config' },
  allowedUsers: { type: [Number], default: [] },
  requiredChannels: { type: [String], default: [] },
  ads: { type: [mongoose.Schema.Types.Mixed], default: [] },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('AdminConfig', adminConfigSchema, 'adminconfigs');
