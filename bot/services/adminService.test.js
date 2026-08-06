jest.mock('../models/AdminConfig', () => {
  const state = {
    key: 'bot_admin_config',
    allowedUsers: [],
    requiredChannels: [],
    ads: []
  };

  return {
    findOne: jest.fn(() => ({
      lean: () => ({ ...state })
    })),
    findOneAndUpdate: jest.fn(async (_filter, update) => {
      if (update && update.$set) {
        Object.assign(state, update.$set);
      }
      return {
        toObject: () => ({ ...state })
      };
    }),
    create: jest.fn(async (doc) => ({
      toObject: () => ({ ...doc })
    }))
  };
});

const { normalizeAdEntry, normalizeChannelName, buildSubscriptionKeyboard, checkSubscriptions, setRequiredChannels } = require('./adminService');

describe('normalizeAdEntry', () => {
  it('converts a plain text ad into a structured object', () => {
    expect(normalizeAdEntry('Salom')).toEqual({ type: 'text', text: 'Salom' });
  });

  it('preserves photo metadata for rich ads', () => {
    expect(normalizeAdEntry({ text: 'Yangi reklam', photoFileId: 'photo-123' })).toEqual({
      type: 'photo',
      text: 'Yangi reklam',
      photoFileId: 'photo-123'
    });
  });

  it('drops empty values', () => {
    expect(normalizeAdEntry('   ')).toBeNull();
  });
});

describe('normalizeChannelName', () => {
  it('adds @ prefix for plain channel names', () => {
    expect(normalizeChannelName('mychannel')).toBe('@mychannel');
  });

  it('keeps existing @ prefix', () => {
    expect(normalizeChannelName('@mychannel')).toBe('@mychannel');
  });

  it('normalizes Telegram links to channel usernames', () => {
    expect(normalizeChannelName('https://t.me/mychannel/')).toBe('@mychannel');
  });
});

describe('buildSubscriptionKeyboard', () => {
  it('builds channel buttons and a check button', () => {
    const keyboard = buildSubscriptionKeyboard(['@mychannel', 'testchannel']);

    expect(keyboard).toEqual([
      [{ text: '@mychannel', url: 'https://t.me/mychannel' }],
      [{ text: '@testchannel', url: 'https://t.me/testchannel' }],
      [{ text: '✅ Tekshirish', callback_data: 'check_required_channels' }]
    ]);
  });
});

describe('checkSubscriptions', () => {
  it('returns subscribed state when no required channels exist', async () => {
    const bot = { getChatMember: jest.fn() };
    const result = await checkSubscriptions(bot, 123);

    expect(result).toEqual({ isSubscribed: true, unjoinedChannels: [] });
    expect(bot.getChatMember).not.toHaveBeenCalled();
  });

  it('marks missing channels as unjoined', async () => {
    const bot = {
      getChatMember: jest.fn()
        .mockResolvedValueOnce({ status: 'left' })
        .mockResolvedValueOnce({ status: 'member' })
    };

    await setRequiredChannels(['@one', '@two']);

    const result = await checkSubscriptions(bot, 123);

    expect(result.isSubscribed).toBe(false);
    expect(result.unjoinedChannels).toEqual(['@one']);
  });

  it('skips channels when Telegram blocks membership checks', async () => {
    const bot = {
      getChatMember: jest.fn().mockRejectedValue(new Error('400: Bad Request: member list is inaccessible'))
    };

    await setRequiredChannels(['@privatechannel']);

    const result = await checkSubscriptions(bot, 123);

    expect(result.isSubscribed).toBe(true);
    expect(result.unjoinedChannels).toEqual([]);
  });
});
