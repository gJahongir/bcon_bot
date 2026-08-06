const Anthropic = require('@anthropic-ai/sdk');

// Claude API key validatsiyasi
if (!process.env.CLAUDE_API_KEY) {
  console.warn('⚠️ CLAUDE_API_KEY .env faylida topilmadi. Claude Vision ishlamaydi.');
}

const anthropic = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY || '' });

/**
 * Rasmni Claude Vision orqali tahlil qilib, 3D model qidirish uchun
 * kategoriya va inglizcha kalit so'zlarni qaytaradi.
 * @param {string} base64Image - base64 formatdagi rasm
 * @param {string} mimeType - image/jpeg | image/png
 * @returns {Promise<{category: string, keywords: string[], description: string}>}
 */
async function describeImage(base64Image, mimeType = 'image/jpeg') {
  if (!process.env.CLAUDE_API_KEY) {
    throw new Error('CLAUDE_API_KEY mavjud emas. .env faylida CLAUDE_API_KEY qo\'yingiz.');
  }

  const prompt = `Bu rasmda tasvirlangan obyektni 3D model qidirish maqsadida tahlil qil.
Faqat toza JSON qaytar, boshqa hech qanday izoh yoki matn yozma:

{
  "category": "obyekt turi inglizchada, masalan: chair, sofa, car, building, character",
  "keywords": ["3D model saytlarida qidirish uchun mos 3-5 ta ingliz tilidagi so'z/ibora"],
  "description": "obyektning qisqa tavsifi o'zbek tilida (shakli, materiali, uslubi)"
}`;

  try {
    const response = await anthropic.messages.create({
      model: process.env.CLAUDE_MODEL || 'claude-3-5-sonnet-20241022',
      max_tokens: 300,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: mimeType,
                data: base64Image
              }
            },
            {
              type: 'text',
              text: prompt
            }
          ]
        }
      ]
    });

    const rawText = response.content[0].text || '{}';
    const cleaned = rawText.replace(/```json|```/g, '').trim();

    try {
      return JSON.parse(cleaned);
    } catch (err) {
      throw new Error('Claude javobini JSON qilib o\'qib bo\'lmadi: ' + rawText);
    }
  } catch (err) {
    // Agar Claude bilan muammo bo'lsa, null qaytar (davom etish uchun)
    console.error('Claude Vision xatoligi (davom etiladi):', err.message);
    throw err;
  }
}

module.exports = { describeImage };
