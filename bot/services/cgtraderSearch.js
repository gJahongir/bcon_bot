const axios = require('axios');
const cheerio = require('cheerio');

/**
 * CGTrader'da ochiq API yo'q, shuning uchun qidiruv sahifasini HTML
 * ko'rinishida olib, kerakli ma'lumotlarni cheerio bilan ajratib olamiz.
 *
 * DIQQAT: Bu "mo'rt" usul — CGTrader sayt dizaynini o'zgartirsa,
 * quyidagi CSS selektorlarni brauzer DevTools orqali qayta tekshirish kerak
 * bo'ladi (sahifani oching -> elementni tekshirish -> class nomlarini ko'ring).
 *
 * @param {string} query
 * @param {number} limit
 */
async function searchCGTrader(query, limit = 4) {
  try {
    const searchQuery = encodeURIComponent(query.trim() || '3d model');
    const url = `https://www.google.com/search?q=${searchQuery}+site%3Acgtrader.com`;
    const { data: html } = await axios.get(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
      },
      timeout: 10000
    });

    const $ = cheerio.load(html);
    const results = [];

    $('a').each((_, el) => {
      if (results.length >= limit) return;

      const linkEl = $(el);
      const href = linkEl.attr('href');
      if (!href || !href.includes('cgtrader.com')) return;

      const text = linkEl.text().trim();
      const name = text || linkEl.attr('title') || 'CGTrader result';
      if (!name || name === 'More' || name === 'Search') return;

      results.push({
        name: name.trim(),
        url: href.startsWith('http') ? href : `https://www.cgtrader.com${href}`,
        thumbnail: null,
        source: 'CGTrader'
      });
    });

    return results;
  } catch (err) {
    console.error('CGTrader qidiruvida xatolik:', err.message);
    return [];
  }
}

module.exports = { searchCGTrader };