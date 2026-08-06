const AdminConfig = require('../models/AdminConfig');

const ADMIN_CONFIG_KEY = 'bot_admin_config';

async function initializeAdminConfig() {
  const config = await AdminConfig.findOne({ key: ADMIN_CONFIG_KEY }).lean();
  if (config) {
    return config;
  }

  const allowedUsers = (process.env.ADMIN_USER_ID || '')
    .split(',')
    .map((id) => Number(id.trim()))
    .filter((id) => !Number.isNaN(id));

  const created = await AdminConfig.create({
    key: ADMIN_CONFIG_KEY,
    allowedUsers,
    requiredChannels: [],
    ads: []
  });

  return created.toObject();
}

async function getAdminConfig() {
  const config = await AdminConfig.findOne({ key: ADMIN_CONFIG_KEY }).lean();
  return config || { allowedUsers: [], requiredChannels: [], ads: [] };
}

async function saveAdminConfig(updates) {
  const doc = await AdminConfig.findOneAndUpdate(
    { key: ADMIN_CONFIG_KEY },
    { $set: updates },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
  return doc.toObject();
}

async function isAdminUser(userId) {
  const config = await getAdminConfig();
  return (config.allowedUsers || []).includes(Number(userId));
}

async function getAllowedUsers() {
  const config = await getAdminConfig();
  return config.allowedUsers || [];
}

async function setAllowedUsers(ids) {
  const normalized = ids
    .map((id) => Number(id))
    .filter((id) => !Number.isNaN(id));
  return saveAdminConfig({ allowedUsers: normalized });
}

async function getRequiredChannels() {
  const config = await getAdminConfig();
  return config.requiredChannels || [];
}

function normalizeChannelName(channel) {
  const normalized = String(channel || '').trim();
  if (!normalized) {
    return '';
  }

  const withoutProtocol = normalized.replace(/^https?:\/\/t\.me\//i, '').replace(/^https?:\/\/telegram\.me\//i, '');
  const withoutTrailingSlash = withoutProtocol.replace(/\/+$/, '');
  const withoutPath = withoutTrailingSlash.split('/')[0];
  const cleaned = withoutPath.startsWith('@') ? withoutPath : `@${withoutPath}`;

  if (cleaned.startsWith('@/') || cleaned.includes('/')) {
    return '';
  }

  const pureName = cleaned.replace(/[^a-zA-Z0-9_]+/g, '');
  if (!pureName || pureName.toLowerCase() === 'admin_add_channel') {
    return '';
  }

  return `@${pureName}`;
}

function buildSubscriptionKeyboard(channels) {
  const normalizedChannels = (channels || [])
    .map((channel) => normalizeChannelName(channel))
    .filter(Boolean);

  return [
    ...normalizedChannels.map((channel) => [{
      text: channel,
      url: `https://t.me/${channel.replace(/^@/, '')}`
    }]),
    [{ text: '✅ Tekshirish', callback_data: 'check_required_channels' }]
  ];
}

async function setRequiredChannels(channels) {
  const normalized = (channels || [])
    .map((ch) => normalizeChannelName(ch))
    .filter(Boolean);
  return saveAdminConfig({ requiredChannels: normalized });
}

async function checkSubscriptions(bot, userId) {
  try {
    const channels = await getRequiredChannels();
    if (!channels.length) {
      return { isSubscribed: true, unjoinedChannels: [] };
    }

    const unjoinedChannels = [];
    const inaccessibleChannels = [];

    for (const channel of channels) {
      if (!channel) {
        continue;
      }

      try {
        const member = await bot.getChatMember(channel, userId);
        const allowedStatuses = ['member', 'administrator', 'creator'];
        if (!allowedStatuses.includes(member.status)) {
          unjoinedChannels.push(channel);
        }
      } catch (error) {
        const message = error.message || '';
        if (/chat not found|member list is inaccessible|channel not found|not found/i.test(message)) {
          inaccessibleChannels.push(channel);
          continue;
        }

        console.warn(`⚠️ Kanal tekshirilmadi: ${channel} — ${message}`);
        unjoinedChannels.push(channel);
      }
    }

    return {
      isSubscribed: unjoinedChannels.length === 0,
      unjoinedChannels,
      inaccessibleChannels
    };
  } catch (error) {
    console.error('checkSubscriptions xatolik:', error.message);
    return { isSubscribed: true, unjoinedChannels: [] };
  }
}

function normalizeAdEntry(entry) {
  if (typeof entry === 'string') {
    const trimmed = entry.trim();
    if (!trimmed) {
      return null;
    }

    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        return normalizeAdEntry(parsed);
      } catch (err) {
        return { type: 'text', text: trimmed };
      }
    }

    return { type: 'text', text: trimmed };
  }

  if (entry && typeof entry === 'object') {
    const text = String(entry.text || entry.caption || '').trim();
    const photoFileId = entry.photoFileId || entry.fileId || entry.photo || '';
    const photoUrl = entry.photoUrl || entry.url || '';

    if (photoFileId || photoUrl) {
      return {
        type: 'photo',
        text,
        ...(photoFileId ? { photoFileId } : {}),
        ...(photoUrl ? { photoUrl } : {})
      };
    }

    if (text) {
      return { type: 'text', text };
    }
  }

  return null;
}

async function getAds() {
  const config = await getAdminConfig();
  const ads = config.ads || [];
  return ads.map((item) => normalizeAdEntry(item)).filter(Boolean);
}

async function setAds(ads) {
  const normalized = (ads || [])
    .map((item) => normalizeAdEntry(item))
    .filter(Boolean);
  return saveAdminConfig({ ads: normalized });
}

module.exports = {
  initializeAdminConfig,
  getAdminConfig,
  saveAdminConfig,
  isAdminUser,
  getAllowedUsers,
  setAllowedUsers,
  getRequiredChannels,
  setRequiredChannels,
  checkSubscriptions,
  normalizeChannelName,
  buildSubscriptionKeyboard,
  normalizeAdEntry,
  getAds,
  setAds
};
