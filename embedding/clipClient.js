const { pipeline, RawImage } = require('@huggingface/transformers');

// Modelni faqat bir marta yuklaymiz (og'ir jarayon), keyin qayta ishlatamiz
let extractorPromise = null;

function getExtractor() {
  if (!extractorPromise) {
    const modelName = process.env.CLIP_MODEL || 'Xenova/clip-vit-base-patch32';
    console.log(`⏳ CLIP modeli yuklanmoqda: ${modelName} (birinchi safar biroz vaqt olishi mumkin)...`);
    extractorPromise = pipeline('image-feature-extraction', modelName);
  }
  return extractorPromise;
}

/**
 * Rasm faylini CLIP orqali vektorga (embedding) aylantiradi.
 * @param {string} imagePath - diskdagi rasm fayli yo'li
 * @returns {Promise<number[]>} - normallashtirilgan vektor (masalan 512 o'lchamli)
 */
async function getImageEmbedding(imagePath) {
  const extractor = await getExtractor();
  const image = await RawImage.read(imagePath);
  const output = await extractor(image, { pooling: 'mean', normalize: true });
  return Array.from(output.data);
}

/**
 * Ikki vektor orasidagi cosine similarity'ni hisoblaydi (1 ga yaqin = juda o'xshash).
 * @param {number[]} a
 * @param {number[]} b
 */
function cosineSimilarity(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }
  // Vektorlar normalize:true bilan olingani uchun uzunligi 1,
  // shuning uchun cosine similarity = dot product
  return dot;
}

module.exports = { getImageEmbedding, cosineSimilarity };