const { GoogleGenAI } = require('@google/genai');

// Gemini API key validatsiyasi
if (!process.env.GEMINI_API_KEY) {
  console.warn('⚠️ GEMINI_API_KEY .env faylida topilmadi. Gemini Vision ishlamaydi.');
}

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });

/**
 * Rasmni Gemini Vision orqali tahlil qilib, 3D model qidirish uchun
 * kategoriya va inglizcha kalit so'zlarni qaytaradi.
 * @param {string} base64Image - base64 formatdagi rasm
 * @param {string} mimeType - image/jpeg | image/png
 * @returns {Promise<{category: string, keywords: string[], description: string}>}
 */
async function describeImage(base64Image, mimeType = 'image/jpeg') {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY mavjud emas. .env faylida GEMINI_API_KEY qo\'yingiz.');
  }

  const prompt = `Bu rasmda tasvirlangan obyektni 3D model qidirish maqsadida tahlil qil.
Faqat toza JSON qaytar, boshqa hech qanday izoh yoki matn yozma:

{
  "category": "obyekt turi inglizchada, masalan: chair, sofa, car, building, character",
  "keywords": ["3D model saytlarida qidirish uchun mos 3-5 ta ingliz tilidagi so'z/ibora"],
  "description": "obyektning qisqa tavsifi o'zbek tilida (shakli, materiali, uslubi)"
}`;

  try {
    const response = await ai.models.generateContent({
      model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
      contents: [
        {
          role: 'user',
          parts: [
            { inlineData: { mimeType, data: base64Image } },
            { text: prompt }
          ]
        }
      ],
      config: {
        responseMimeType: 'application/json'
      }
    });

    const rawText = response.text || '{}';
    const cleaned = rawText.replace(/```json|```/g, '').trim();

    try {
      return JSON.parse(cleaned);
    } catch (err) {
      throw new Error('Gemini javobini JSON qilib o\'qib bo\'lmadi: ' + rawText);
    }
  } catch (err) {
    // Agar Gemini bilan muammo bo'lsa, null qaytar (davom etish uchun)
    console.error('Gemini tarjima xatoligi (davom etiladi):', err.message);
    throw err;
  }
}



  module.exports = { describeImage };