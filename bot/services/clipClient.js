const { pipeline, RawImage, AutoTokenizer, CLIPTextModelWithProjection } = require('@huggingface/transformers');

// Use the ONNX-available CLIP variant. The openai/clip-vit-base-patch32 repo does not expose
// the expected ONNX files when loaded through the Transformers JS pipeline, which causes
// the "Could not locate file: .../onnx/vision_model.onnx" error.
const DEFAULT_CLIP_MODEL = process.env.CLIP_MODEL || 'Xenova/clip-vit-base-patch32';

// Modelni faqat bir marta yuklaymiz (og'ir jarayon), keyin qayta ishlatamiz
let imageExtractorPromise = null;
let textTokenizerPromise = null;
let clipTextModelPromise = null;

/**
 * Rasm uchun CLIP feature extraction pipeline'ni qaytaradi.
 * Birinchi chaqiruvda model yuklanadi, keyingilarida keshdan oladi.
 */
function getImageExtractor() {
  if (!imageExtractorPromise) {
    const modelName = DEFAULT_CLIP_MODEL;
    console.log(`⏳ CLIP rasm modeli yuklanmoqda: ${modelName}...`);
    imageExtractorPromise = pipeline('image-feature-extraction', modelName, {
      fetch_options: {
        timeout: 300000
      }
    })
      .then((extractor) => {
        console.log(`✅ CLIP rasm modeli tayyor: ${modelName}`);
        return extractor;
      })
      .catch((err) => {
        console.error('❌ CLIP rasm modeli yuklanmadi:', err.message);
        imageExtractorPromise = null;
        throw err;
      });
  }
  return imageExtractorPromise;
}

/**
 * CLIP tokenizer'ni qaytaradi.
 */
function getTextTokenizer() {
  if (!textTokenizerPromise) {
    const modelName = DEFAULT_CLIP_MODEL;
    console.log(`⏳ CLIP tokenizer yuklanmoqda: ${modelName}...`);
    textTokenizerPromise = AutoTokenizer.from_pretrained(modelName)
      .then((tokenizer) => {
        console.log(`✅ CLIP tokenizer tayyor: ${modelName}`);
        return tokenizer;
      })
      .catch((err) => {
        console.error('❌ CLIP tokenizer yuklanmadi:', err.message);
        textTokenizerPromise = null;
        throw err;
      });
  }
  return textTokenizerPromise;
}

/**
 * CLIP text model'ni qaytaradi.
 */
function getCLIPTextModel() {
  if (!clipTextModelPromise) {
    const modelName = DEFAULT_CLIP_MODEL;
    console.log(`⏳ CLIP text model yuklanmoqda: ${modelName}...`);
    clipTextModelPromise = CLIPTextModelWithProjection.from_pretrained(modelName)
      .then((model) => {
        console.log(`✅ CLIP text model tayyor: ${modelName}`);
        return model;
      })
      .catch((err) => {
        console.error('❌ CLIP text model yuklanmadi:', err.message);
        clipTextModelPromise = null;
        throw err;
      });
  }
  return clipTextModelPromise;
}

/**
 * Fallback embedding yaratadi (deterministik, model yuklanmasa ham ishlaydi).
 */
function createFallbackEmbedding(seed, length = 512) {
  const data = new Float32Array(length);
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }

  for (let i = 0; i < length; i++) {
    hash ^= (hash << 13) >>> 0;
    hash = Math.imul(hash, 0x5bd1e995) >>> 0;
    data[i] = ((hash % 2000) - 1000) / 1000;
  }

  let norm = 0;
  for (let i = 0; i < length; i++) {
    norm += data[i] * data[i];
  }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < length; i++) {
    data[i] /= norm;
  }
  return Array.from(data);
}

/**
 * Rasm faylini CLIP orqali vektorga (embedding) aylantiradi.
 */
async function getImageEmbedding(imagePath) {
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const extractor = await getImageExtractor();
      const image = await RawImage.read(imagePath);
      const output = await extractor(image, { pooling: 'mean', normalize: true });
      let embeddingData = Array.from(output.data);

      // Normallashtirish (etibariga normalization allaqachon qilingan)
      const norm = Math.sqrt(embeddingData.reduce((sum, v) => sum + v * v, 0));
      if (norm > 0.01) { // Agar norm oldindan normalized emas bo'lsa
        for (let i = 0; i < embeddingData.length; i++) {
          embeddingData[i] /= norm;
        }
      }

      return embeddingData;
    } catch (err) {
      lastError = err;
      if (attempt === 1) {
        console.warn(`⚠️ Rasm embedding xatoligi (qayta urinilmoqda): ${err.message}`);
        imageExtractorPromise = null;
      }
    }
  }
  console.warn('⚠️ CLIP image embedding mavjud emas, fallback ishlatiladi.');
  return createFallbackEmbedding(imagePath);
}

/**
 * Matn so'rovini CLIP orqali vektorga aylantiradi.
 * Tokenizer + TextModel bilan hisoblaydi.
 */
async function getTextEmbedding(text) {
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const [tokenizer, textModel] = await Promise.all([
        getTextTokenizer(),
        getCLIPTextModel()
      ]);

      // Matnni tokenize qilish
      const inputs = tokenizer(text, { padding: true, truncation: true });
      
      // Text embedding'ni hisoblash
      const output = await textModel(inputs);
      const textEmbeddings = output.text_embeds; // shape: [1, 512]
      let embeddingData = Array.from(textEmbeddings.data);

      // Normallashtirish
      const norm = Math.sqrt(embeddingData.reduce((sum, v) => sum + v * v, 0));
      if (norm > 0.01) {
        for (let i = 0; i < embeddingData.length; i++) {
          embeddingData[i] /= norm;
        }
      }

      return embeddingData;
    } catch (err) {
      lastError = err;
      if (attempt === 1) {
        console.warn(`⚠️ Matn embedding xatoligi (qayta urinilmoqda): ${err.message}`);
        clipTextModelPromise = null;
        textTokenizerPromise = null;
      }
    }
  }
  console.warn('⚠️ CLIP text embedding mavjud emas, fallback ishlatiladi.');
  return createFallbackEmbedding(text);
}

/**
 * Ikki vektor orasidagi cosine similarity'ni hisoblaydi.
 */
function cosineSimilarity(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }
  return dot;
}

/**
 * Bot ishga tushganda modellar oldindan yuklanadi.
 */
async function preloadModels() {
  console.log('🔄 CLIP modellarini oldindan yuklash boshlandi...');
  try {
    await Promise.all([
      getTextTokenizer(),
      getCLIPTextModel(),
      getImageExtractor()
    ]);
    console.log('✅ Barcha CLIP modellari tayyor!');
  } catch (err) {
    console.warn('⚠️ CLIP modellarini oldindan yuklashda xatolik:', err.message);
  }
}

module.exports = { getImageEmbedding, getTextEmbedding, cosineSimilarity, preloadModels };