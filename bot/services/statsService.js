const Model3D = require('../models/Models3D');

/**
 * Bazadagi umumiy statistikani qaytaradi.
 * @returns {Promise<{totalModels: number, withEmbedding: number, channels: string[], categories: Object}>}
 */
async function getStats() {
  const [totalModels, withEmbedding, channelList, categoryAgg] = await Promise.all([
    Model3D.countDocuments(),
    Model3D.countDocuments({ embedding: { $ne: null, $exists: true, $not: { $size: 0 } } }),
    Model3D.distinct('channelUsername'),
    Model3D.aggregate([
      { $match: { category: { $ne: '' } } },
      { $group: { _id: '$category', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 15 }
    ])
  ]);

  const categories = {};
  for (const cat of categoryAgg) {
    categories[cat._id] = cat.count;
  }

  return {
    totalModels,
    withEmbedding,
    channels: channelList,
    categories
  };
}

/**
 * Eng ko'p qidirilgan (mashhur) modellarni qaytaradi.
 * @param {number} limit
 * @returns {Promise<Array>}
 */
async function getPopularModels(limit = 5) {
  return Model3D.find({ searchCount: { $gt: 0 } })
    .sort({ searchCount: -1 })
    .limit(limit)
    .select('modelCode documentFileName channelUsername searchCount category')
    .lean();
}

/**
 * Bazadan tasodifiy model qaytaradi.
 * @returns {Promise<Object|null>}
 */
async function getRandomModel() {
  const results = await Model3D.aggregate([
    { $match: { embedding: { $ne: null, $exists: true, $not: { $size: 0 } } } },
    { $sample: { size: 1 } },
    {
      $project: {
        modelCode: 1,
        channelUsername: 1,
        messageId: 1,
        documentFileName: 1,
        caption: 1,
        category: 1,
        tags: 1
      }
    }
  ]);

  return results.length > 0 ? results[0] : null;
}

/**
 * Model qidiruv natijasida chiqqanda searchCount va lastSearchedAt yangilaydi.
 * @param {Array<string>} modelIds - _id'lar ro'yxati
 */
async function incrementSearchCounts(modelIds) {
  if (!modelIds || modelIds.length === 0) return;

  try {
    await Model3D.updateMany(
      { _id: { $in: modelIds } },
      {
        $inc: { searchCount: 1 },
        $set: { lastSearchedAt: new Date() }
      }
    );
  } catch (err) {
    console.error('searchCount yangilashda xatolik:', err.message);
  }
}

module.exports = {
  getStats,
  getPopularModels,
  getRandomModel,
  incrementSearchCounts
};
