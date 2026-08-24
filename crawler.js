require('dotenv').config();
require('dns').setDefaultResultOrder('ipv4first');

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const input = require('input');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');

const Model3D = require('./bot/models/Models3D');

const apiId = Number(process.env.TG_API_ID);
const apiHash = process.env.TG_API_HASH;
const sessionString = process.env.TG_SESSION || '';

const CHANNELS = (process.env.CHANNELS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const IMAGES_DIR = path.join(__dirname, 'downloaded_images');

async function main() {
  if (!apiId || !apiHash) {
    console.error('❌ TG_API_ID yoki TG_API_HASH .env faylida yo\'q. my.telegram.org dan oling.');
    process.exit(1);
  }
  if (CHANNELS.length === 0) {
    console.error('❌ CHANNELS .env faylida bo\'sh. Kamida bitta kanal username yozing.');
    process.exit(1);
  }

  fs.mkdirSync(IMAGES_DIR, { recursive: true });
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('✅ MongoDB ulandi');

  const client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
    connectionRetries: 5
  });

  await client.start({
    phoneNumber: async () => await input.text('📱 Telefon raqamingiz (+998...): '),
    password: async () => await input.text('🔒 2FA parol (agar yo\'q bo\'lsa, Enter bosing): '),
    phoneCode: async () => await input.text('💬 Telegram\'dan kelgan tasdiqlash kodi: '),
    onError: (err) => console.error('Login xatoligi:', err)
  });

  console.log('\n✅ Login muvaffaqiyatli!');
  console.log('⚠️  Quyidagi SESSION STRING\'ni nusxalab, .env faylidagi TG_SESSION= ga qo\'ying.');
  console.log('   Shunda keyingi safar qayta login qilish shart bo\'lmaydi:\n');
  console.log(client.session.save());
  console.log('');

  for (const channel of CHANNELS) {
    console.log(`\n📡 Kanal skanerlanmoqda: @${channel}`);
    try {
      await crawlChannel(client, channel);
    } catch (err) {
      console.error(`❌ @${channel} kanalida xatolik:`, err.message);
    }
  }

  await client.disconnect();
  await mongoose.disconnect();
  console.log('\n✅ Barcha kanallar tugadi.');
  process.exit(0);
}

async function crawlChannel(client, channelUsername) {
  // groupedId (albom) ishlamaydigan kanallar bor — bunda rasm va arxiv
  // ikkita ALOHIDA, lekin ID bo'yicha ketma-ket (yaqin) xabarlar sifatida keladi.
  // Shuning uchun har bir xabarni ID bo'yicha saqlab, keyin arxiv xabaridan
  // yaqin atrofdagi rasmni qidiramiz.
  const entries = new Map(); // messageId -> { photoMessage?, documentMessage?, documentFileName?, caption? }
  let scanned = 0;

  for await (const message of client.iterMessages(channelUsername, { limit: 0 })) {
    scanned++;
    if (scanned % 500 === 0) console.log(`  ...${scanned} ta xabar ko'rib chiqildi`);

    const record = { id: message.id, caption: message.message || '' };
    let relevant = false;

    if (message.photo) {
      record.photoMessage = message;
      relevant = true;
    }

    if (message.document) {
      const filenameAttr = (message.document.attributes || []).find(
        (a) => a.className === 'DocumentAttributeFilename'
      );
      const fileName = filenameAttr ? filenameAttr.fileName : null;
      if (fileName && /\.(rar|zip)$/i.test(fileName)) {
        record.documentMessage = message;
        record.documentFileName = fileName;
        relevant = true;
      }
    }

    if (relevant) entries.set(message.id, record);
  }

  console.log(`  📊 Jami ${scanned} ta xabar, ${entries.size} ta rasm/arxiv xabari topildi. Juftliklar qidirilmoqda...`);

  // Arxivdan eng yaqin ID'dagi ishlatilmagan rasmni qidiramiz.
  // Tekshirish tartibi: -1, +1, -2, +2, -3, +3 (eng yaqinidan boshlab)
  const SEARCH_OFFSETS = [-1, 1, -2, 2, -3, 3];
  const usedPhotoIds = new Set();
  const documentEntries = [...entries.values()].filter((e) => e.documentMessage);

  let saved = 0;
  let skipped = 0;

  for (const docEntry of documentEntries) {
    let matchedPhoto = null;

    for (const offset of SEARCH_OFFSETS) {
      const candidate = entries.get(docEntry.id + offset);
      if (candidate && candidate.photoMessage && !usedPhotoIds.has(candidate.id)) {
        matchedPhoto = candidate;
        break;
      }
    }

    if (!matchedPhoto) {
      skipped++;
      continue;
    }

    const modelCode = docEntry.documentFileName.replace(/\.(rar|zip)$/i, '');

    const exists = await Model3D.findOne({ modelCode, channelUsername });
    if (exists) {
      skipped++;
      continue;
    }

    const imagePath = path.join(IMAGES_DIR, `${channelUsername}_${modelCode}.jpg`);

    try {
      // Rasmni yuklab ol
      await client.downloadMedia(matchedPhoto.photoMessage, { outputFile: imagePath });
      usedPhotoIds.add(matchedPhoto.id);

      // Arxiv faylini buffer sifatida yuklab ol (retry va fallback bilan)
      let fileBuffer;
      const MAX_DOWNLOAD_ATTEMPTS = 2;
      let attempt = 0;
      while (attempt < MAX_DOWNLOAD_ATTEMPTS) {
        attempt += 1;
        try {
          fileBuffer = await client.downloadMedia(docEntry.documentMessage);
          break;
        } catch (err) {
          console.warn(`  ⚠️ download attempt ${attempt} failed for ${docEntry.documentFileName}:`, err.message);
          if (attempt >= MAX_DOWNLOAD_ATTEMPTS) {
            // Fallback: yazib olib keyin o'qib olish (outputFile)
            const tmp = require('os').tmpdir();
            const tmpPath = path.join(tmp, `dl_${Date.now()}_${docEntry.documentFileName}`);
            try {
              console.log('  ℹ️ attempting fallback download to file:', tmpPath);
              await client.downloadMedia(docEntry.documentMessage, { outputFile: tmpPath });
              fileBuffer = fs.readFileSync(tmpPath);
              try { fs.unlinkSync(tmpPath); } catch (e) { /* ignore cleanup errors */ }
              break;
            } catch (fallbackErr) {
              try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (e) {}
              throw fallbackErr;
            }
          }
          // small delay before retry
          await new Promise((r) => setTimeout(r, 500));
        }
      }
      const fileType = docEntry.documentFileName.match(/\.(rar|zip)$/i)[1].toLowerCase();

      await Model3D.create({
        modelCode,
        channelUsername,
        messageId: docEntry.id,
        photoMessageId: matchedPhoto.id,
        imagePath,
        documentFileName: docEntry.documentFileName,
        caption: docEntry.caption || matchedPhoto.caption || '',
        fileData: fileBuffer,
        fileSize: fileBuffer.length,
        fileType: fileType
      });

      saved++;
      if (saved % 50 === 0) console.log(`  💾 ${saved} ta model saqlandi (${(fileBuffer.length / 1024 / 1024).toFixed(2)} MB)...`);
    } catch (err) {
      console.error(`  ⚠️  "${modelCode}" saqlanmadi:`, err.message);
    }
  }

  console.log(`  ✅ @${channelUsername}: ${saved} ta yangi model saqlandi, ${skipped} ta o'tkazib yuborildi.`);
}

main().catch((err) => {
  console.error('Kutilmagan xatolik:', err);
  process.exit(1);
});