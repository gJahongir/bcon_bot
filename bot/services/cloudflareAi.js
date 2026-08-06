const axios = require('axios');

/**
 * Cloudflare AI ga umumiy so'rov yuborish
 */
async function runCloudflareAI(model, payload) {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  
  if (!accountId || !token) {
    throw new Error('CLOUDFLARE_ACCOUNT_ID yoki CLOUDFLARE_API_TOKEN .env faylida topilmadi.');
  }

  // URL so'zlanishi (agar user URL kiritgan bo'lsa)
  const baseUrl = process.env.CLOUDFLARE_AI_URL 
    ? process.env.CLOUDFLARE_AI_URL.replace(/\/$/, '') 
    : `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run`;

  const url = `${baseUrl}/${model}`;

  try {
    const response = await axios.post(url, payload, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });

    return response.data.result;
  } catch (err) {
    console.error(`Cloudflare AI xatoligi (${model}):`, err.response?.data || err.message);
    throw new Error(`Cloudflare AI xatoligi: ${err.message}`);
  }
}

/**
 * Rasmni Cloudflare Vision (llava) orqali tahlil qilib, 3D model qidirish uchun
 * kategoriya va inglizcha kalit so'zlarni qaytaradi.
 */
async function describeImage(base64Image, mimeType = 'image/jpeg') {
  const model = process.env.CLOUDFLARE_VISION_MODEL || '@cf/llava-hf/llava-1.5-7b-hf';
  
  // base64 prefixini olib tashlaymiz
  const base64Data = base64Image.replace(/^data:image\/\w+;base64,/, '');

  // Cloudflare REST API uchun rasmni baytlar massiviga aylantiramiz
  const binaryString = Buffer.from(base64Data, 'base64');
  const imageArray = Array.from(new Uint8Array(binaryString));

  const prompt = `Analyze this object for the purpose of searching for a 3D model.
Return ONLY clean JSON, no other text or markdown:

{
  "category": "object type in english, e.g.: chair, sofa, car, building, character",
  "keywords": ["3-5 english keywords/phrases suitable for searching on 3D model sites"],
  "description": "short description of the object in Uzbek language (shape, material, style)",
  "englishDescription": "short description of the object in English language (e.g. modern white office chair with wheels)"
}`;

  try {
    const result = await runCloudflareAI(model, {
      messages: [
        {
          role: 'user',
          content: prompt
        }
      ],
      image: imageArray
    });

    const responseData = result?.response;
    if (responseData && typeof responseData === 'object') {
      return {
        category: responseData.category || 'unknown',
        keywords: responseData.keywords || [],
        description: responseData.description || '',
        englishDescription: responseData.englishDescription || ''
      };
    }

    const rawText = typeof responseData === 'string' ? responseData : '{}';
    const cleaned = rawText.replace(/```json|```/g, '').trim();
    
    try {
      const parsed = JSON.parse(cleaned);
      return {
        category: parsed.category || 'unknown',
        keywords: parsed.keywords || [],
        description: parsed.description || '',
        englishDescription: parsed.englishDescription || parsed.description || ''
      };
    } catch (parseErr) {
      console.warn("Cloudflare Vision JSON qaytarmadi, xom matn:", rawText);
      return {
        category: "unknown",
        keywords: [rawText.substring(0, 50)],
        description: rawText,
        englishDescription: rawText
      };
    }
  } catch (err) {
    console.error('Cloudflare Vision xatoligi (davom etiladi):', err.message);
    throw err;
  }
}

/**
 * Foydalanuvchi yozgan matnni tahlil qilib, kalit so'zlarni va izohni olib beradi
 */
async function analyzeTextQuery(query) {
  const model = process.env.CLOUDFLARE_TEXT_MODEL || '@cf/meta/llama-3.1-8b-instruct';
  
  const prompt = `Foydalanuvchi 3D model qidirmoqda: "${query}".
Faqat toza JSON qaytar, boshqa izoh yozma:\n
{"english": "inglizcha qidiruv so'zi (masalan: modern wooden chair)", "description": "foydalanuvchi nimani qidirmoqda - qisqa izoh o'zbek tilida"}`;

  try {
    const result = await runCloudflareAI(model, {
      messages: [
        {
          role: 'user',
          content: prompt
        }
      ]
    });

    const responseData = result?.response;
    if (responseData && typeof responseData === 'object') {
      return {
        english: responseData.english || query,
        description: responseData.description || query
      };
    }

    const rawText = typeof responseData === 'string' ? responseData : '{}';
    const cleaned = rawText.replace(/```json|```/g, '').trim();

    try {
      return JSON.parse(cleaned);
    } catch (parseErr) {
      console.warn("Cloudflare matn modeli JSON qaytarmadi:", rawText);
      return {
        english: query,
        description: query
      };
    }
  } catch (err) {
    console.error('Cloudflare matn tarjima xatoligi:', err.message);
    throw err;
  }
}

module.exports = { describeImage, analyzeTextQuery };
