const Model3D = require('../models/Models3D');
const { cosineSimilarity } = require('./clipClient');

/**
 * Xotiradagi katalog — barcha embedding'li modellar shu yerda saqlanadi.
 * Har bir element: { _id, modelCode, channelUsername, messageId, photoMessageId, documentFileName, caption, category, tags, embedding }
 */
let catalog = [];
let catalogLoaded = false;
let lastLoadTime = null;

function getVectorNorm(values) {
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i] * values[i];
  }
  return Math.sqrt(sum);
}

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u0400-\u04ff\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * MongoDB'dan barcha embedding'li hujjatlarni xotiraga yuklaydi.
 * @param {boolean} forceReload - true bo'lsa, avvalgi katalogni tozalab, qaytadan yuklaydi
 * @returns {Promise<number>} - yuklangan modellar soni
 */
async function loadCatalog(forceReload = false) {
  if (catalogLoaded && !forceReload) {
    console.log(`📦 Katalog allaqachon yuklangan (${catalog.length} ta model)`);
    return catalog.length;
  }

  console.log('📥 Katalog yuklanmoqda (MongoDB → xotira)...');
  const startTime = Date.now();

  // Faqat embedding mavjud bo'lgan hujjatlarni olamiz
  const docs = await Model3D.find(
    { embedding: { $ne: null, $exists: true, $not: { $size: 0 } } },
    {
      modelCode: 1,
      channelUsername: 1,
      messageId: 1,
      photoMessageId: 1,
      documentFileName: 1,
      caption: 1,
      category: 1,
      tags: 1,
      imagePath: 1,
      embedding: 1
    }
  ).lean();

  // Float32Array'ga o'tkazish va normlarni oldindan hisoblash.
  // Bu har bir so'rovda norm va sqrt hisoblashni yo'qotadi.
  catalog = docs.map((doc) => {
    const embedding = new Float32Array(doc.embedding);
    return {
      _id: doc._id,
      modelCode: doc.modelCode,
      channelUsername: doc.channelUsername,
      messageId: doc.messageId,
      photoMessageId: doc.photoMessageId || null,
      documentFileName: doc.documentFileName,
      caption: doc.caption || '',
      category: doc.category || '',
      tags: doc.tags || [],
      imagePath: doc.imagePath || '',
      embedding,
      norm: getVectorNorm(embedding)
    };
  });

  catalogLoaded = true;
  lastLoadTime = new Date();

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`✅ Katalog yuklandi: ${catalog.length} ta model (${elapsed}s)`);

  return catalog.length;
}

/**
 * Yangi qo'shilgan modellarni katalogga qo'shadi (to'liq qayta yuklamasdan).
 * Mavjud bo'lmagan _id'larni topib qo'shadi.
 * @returns {Promise<number>} - yangi qo'shilgan modellar soni
 */
async function refreshCatalog() {
  if (!catalogLoaded) {
    return loadCatalog(true);
  }

  const existingIds = new Set(catalog.map((item) => item._id.toString()));

  const newDocs = await Model3D.find(
    { embedding: { $ne: null, $exists: true, $not: { $size: 0 } } },
    {
      modelCode: 1,
      channelUsername: 1,
      messageId: 1,
      photoMessageId: 1,
      documentFileName: 1,
      caption: 1,
      category: 1,
      tags: 1,
      imagePath: 1,
      embedding: 1
    }
  ).lean();

  let added = 0;
  for (const doc of newDocs) {
    if (!existingIds.has(doc._id.toString())) {
      const embedding = new Float32Array(doc.embedding);
      catalog.push({
        _id: doc._id,
        modelCode: doc.modelCode,
        channelUsername: doc.channelUsername,
        messageId: doc.messageId,
        photoMessageId: doc.photoMessageId || null,
        documentFileName: doc.documentFileName,
        caption: doc.caption || '',
        category: doc.category || '',
        tags: doc.tags || [],
        imagePath: doc.imagePath || '',
        embedding,
        norm: getVectorNorm(embedding)
      });
      added++;
    }
  }

  if (added > 0) {
    console.log(`🔄 Katalog yangilandi: +${added} ta yangi model (jami: ${catalog.length})`);
  }

  return added;
}

/**
 * Berilgan query embedding'ga eng yaqin modellarni topadi (cosine similarity bo'yicha).
 * @param {number[]|Float32Array} queryEmbedding - qidiruv vektori
 * @param {number} topK - nechta natija qaytarish (default: 5)
 * @param {number} minScore - minimal o'xshashlik bali (default: 0.5)
 * @returns {Promise<Array<{_id, modelCode, channelUsername, messageId, documentFileName, caption, category, tags, score}>>}
 */
async function findBestMatches(queryEmbedding, topK = 5, minScore = 0.5) {
  if (!catalogLoaded || catalog.length === 0) {
    await loadCatalog(true);
  }

  const queryVec = queryEmbedding instanceof Float32Array
    ? queryEmbedding
    : new Float32Array(queryEmbedding);

  const queryNorm = getVectorNorm(queryVec);
  if (queryNorm === 0) {
    return [];
  }

  const best = [];
  let worstScore = -Infinity;

  for (const item of catalog) {
    if (item.norm === 0) {
      continue;
    }

    let dot = 0;
    const len = Math.min(queryVec.length, item.embedding.length);
    for (let i = 0; i < len; i++) {
      dot += queryVec[i] * item.embedding[i];
    }

    const score = dot / (queryNorm * item.norm);
    if (score < minScore || score <= worstScore) {
      continue;
    }

    const candidate = {
      _id: item._id,
      modelCode: item.modelCode,
      channelUsername: item.channelUsername,
      messageId: item.messageId,
      photoMessageId: item.photoMessageId,
      documentFileName: item.documentFileName,
      caption: item.caption,
      category: item.category,
      tags: item.tags,
      imagePath: item.imagePath,
      score
    };

    if (best.length < topK) {
      best.push(candidate);
      if (best.length === topK) {
        best.sort((a, b) => b.score - a.score);
        worstScore = best[best.length - 1].score;
      }
      continue;
    }

    let insertIndex = best.length;
    for (let i = 0; i < best.length; i++) {
      if (score > best[i].score) {
        insertIndex = i;
        break;
      }
    }

    if (insertIndex < best.length) {
      best.splice(insertIndex, 0, candidate);
      best.pop();
      worstScore = best[best.length - 1].score;
    }
  }

  return best;
}

async function findTextMatches(query, topK = 10) {
  const queryTerms = normalizeText(query);
  if (queryTerms.length === 0) {
    return [];
  }

  if (!catalogLoaded || catalog.length === 0) {
    await loadCatalog(true);
  }

  const candidates = [];

  for (const item of catalog) {
    const haystack = [
      item.caption || '',
      item.documentFileName || '',
      item.category || '',
      item.modelCode || '',
      ...(item.tags || [])
    ].join(' ').toLowerCase();

    let score = 0;
    for (const term of queryTerms) {
      if (haystack.includes(term)) {
        score += 1;
      }
    }

    if (score > 0) {
      candidates.push({
        _id: item._id,
        modelCode: item.modelCode,
        channelUsername: item.channelUsername,
        messageId: item.messageId,
        photoMessageId: item.photoMessageId,
        documentFileName: item.documentFileName,
        caption: item.caption,
        category: item.category,
        tags: item.tags,
        imagePath: item.imagePath,
        score
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, topK);
}

/**
 * Float32Array uchun optimizatsiyalangan cosine similarity.
 * Ikkala vektor normalize qilingan deb hisoblanadi, shuning uchun
 * cosine similarity = dot product.
 */
function cosineSimilarityF32(a, b) {
  // Dot product hisoblash
  let dot = 0;
  let normA = 0;
  let normB = 0;
  
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  
  // Cosine similarity = dot / (|A| * |B|)
  const magnitudeA = Math.sqrt(normA);
  const magnitudeB = Math.sqrt(normB);
  
  if (magnitudeA === 0 || magnitudeB === 0) {
    return 0;
  }
  
  return dot / (magnitudeA * magnitudeB);
}

/**
 * Katalog haqida ma'lumot qaytaradi.
 */
function getCatalogInfo() {
  return {
    loaded: catalogLoaded,
    count: catalog.length,
    lastLoadTime
  };
}

module.exports = {
  loadCatalog,
  refreshCatalog,
  findBestMatches,
  findTextMatches,
  getCatalogInfo
};
