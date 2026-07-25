require('dotenv').config();
require('dns').setDefaultResultOrder('ipv4first');
const mongoose = require('../node_modules/mongoose');
const Model3D = require('../models/Model3D');
const { getImageEmbedding } = require('./clipClient');

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('✅ MongoDB ulandi');

  // Faqat embedding hali hisoblanmagan hujjatlarni olamiz
  const pending = await Model3D.find({ embedding: null });
  console.log(`📊 ${pending.length} ta model uchun embedding hisoblanadi...`);

  let done = 0;
  let failed = 0;

  for (const doc of pending) {
    try {
      const embedding = await getImageEmbedding(doc.imagePath);
      doc.embedding = embedding;
      await doc.save();

      done++;
      if (done % 20 === 0) {
        console.log(`  💾 ${done}/${pending.length} tayyor...`);
      }
    } catch (err) {
      failed++;
      console.error(`  ⚠️  "${doc.modelCode}" uchun xatolik:`, err.message);
    }
  }

  console.log(`\n✅ Tugadi. ${done} ta muvaffaqiyatli, ${failed} ta xatolik bilan.`);

  await mongoose.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error('Kutilmagan xatolik:', err);
  process.exit(1);
});