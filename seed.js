/**
 * Vaqtinchalik test ma'lumotlar — bazaga 500 ta soxta 3D model qo'shadi.
 * Ishga tushirish: node seed.js
 * Tozalash:       node seed.js --clean
 */
require('dotenv').config();
require('dns').setDefaultResultOrder('ipv4first');

const mongoose = require('mongoose');
const Model3D = require('./bot/models/Models3D');

// ─── Realiktik 3D model kategoriyalari va nomlari ────────────────────────────

const CATEGORIES = {
  furniture: {
    items: [
      'Modern Armchair', 'Classic Wooden Chair', 'Office Chair Ergonomic', 'Bar Stool Metal',
      'L-Shape Sofa', 'Corner Sofa Leather', 'Velvet Loveseat', 'Modular Sofa Set',
      'Coffee Table Glass', 'Dining Table Oak', 'Side Table Marble', 'Console Table',
      'King Size Bed Frame', 'Bunk Bed Children', 'Platform Bed Modern', 'Wardrobe Sliding',
      'Bookshelf Wall Mount', 'TV Stand Minimalist', 'Shoe Cabinet', 'Kitchen Island',
      'Dresser 6 Drawer', 'Nightstand Modern', 'Desk Computer Gaming', 'Standing Desk',
      'Rocking Chair', 'Bean Bag Chair', 'Dining Chair Set', 'Bench Outdoor Wooden',
      'Cabinet Display Glass', 'Shelf Floating Wall'
    ],
    tags: ['furniture', 'interior', 'home', 'decor', 'modern', 'classic', 'wooden', 'metal']
  },
  vehicle: {
    items: [
      'Sports Car Ferrari', 'SUV Range Rover', 'Sedan BMW M5', 'Pickup Truck Ford',
      'Motorcycle Harley Davidson', 'Bicycle Mountain Bike', 'Electric Scooter', 'Bus City Transport',
      'Ambulance Emergency', 'Police Car', 'Fire Truck', 'Taxi Yellow Cab',
      'Helicopter Military', 'Airplane Boeing 737', 'Private Jet', 'Hot Air Balloon',
      'Speedboat Racing', 'Yacht Luxury', 'Sailboat Classic', 'Submarine',
      'Tank Military', 'APC Armored', 'Jeep Wrangler', 'Tesla Model S',
      'Lamborghini Aventador', 'Porsche 911', 'Mercedes G Wagon', 'Audi R8',
      'Dump Truck Construction', 'Crane Tower'
    ],
    tags: ['vehicle', 'car', 'transport', 'automotive', 'racing', 'military', 'luxury']
  },
  architecture: {
    items: [
      'Modern Villa Exterior', 'Skyscraper Office Tower', 'Medieval Castle', 'Japanese Temple',
      'Mosque Ottoman Style', 'Church Gothic', 'Bridge Suspension', 'Stadium Football',
      'Airport Terminal', 'Train Station', 'Shopping Mall', 'Hospital Building',
      'School Building', 'Library Classic', 'Museum Contemporary', 'Factory Industrial',
      'Warehouse Storage', 'Greenhouse Garden', 'Lighthouse Coastal', 'Windmill Dutch',
      'Apartment Complex', 'Townhouse Row', 'Cottage Country', 'Mansion Victorian',
      'Barn Farm', 'Garage Modern', 'Swimming Pool', 'Gazebo Garden',
      'Fence Wooden Picket', 'Gate Iron Ornamental'
    ],
    tags: ['architecture', 'building', 'exterior', 'structure', 'construction', 'urban']
  },
  character: {
    items: [
      'Warrior Knight Armor', 'Wizard Fantasy', 'Ninja Stealth', 'Pirate Captain',
      'Zombie Horror', 'Robot Humanoid', 'Alien Creature', 'Dragon Flying',
      'Elf Archer', 'Dwarf Blacksmith', 'Princess Royal', 'Viking Berserker',
      'Astronaut Space', 'Soldier Modern', 'Samurai Japanese', 'Cowboy Western',
      'Superhero Cape', 'Villain Dark', 'Angel Wings', 'Demon Horns',
      'Mermaid Ocean', 'Centaur Mythical', 'Goblin Cave', 'Orc Warrior',
      'Fairy Small', 'Ghost Transparent', 'Skeleton Bone', 'Witch Broom',
      'Clown Circus', 'Chef Kitchen'
    ],
    tags: ['character', 'humanoid', 'fantasy', 'game', 'animation', 'rigged']
  },
  nature: {
    items: [
      'Oak Tree Large', 'Pine Tree Snow', 'Palm Tree Tropical', 'Cherry Blossom',
      'Cactus Desert', 'Rose Bush Garden', 'Sunflower Field', 'Mushroom Forest',
      'Rock Boulder Large', 'Mountain Terrain', 'Waterfall Cascade', 'River Stream',
      'Ocean Wave', 'Sand Dune Desert', 'Grass Patch', 'Flower Pot Indoor',
      'Bonsai Tree', 'Bamboo Forest', 'Coral Reef', 'Seashell Collection',
      'Log Fallen Tree', 'Stump Old Tree', 'Ivy Wall Climbing', 'Moss Rock',
      'Fern Tropical', 'Lily Pad Water', 'Tulip Garden', 'Lavender Field',
      'Hedge Garden Trimmed', 'Vine Grape'
    ],
    tags: ['nature', 'plant', 'tree', 'landscape', 'outdoor', 'garden', 'organic']
  },
  electronics: {
    items: [
      'Laptop MacBook Pro', 'Desktop PC Gaming', 'Monitor Ultrawide', 'Keyboard Mechanical',
      'Mouse Wireless', 'Headphones Over Ear', 'Smartphone iPhone', 'Tablet iPad',
      'Camera DSLR Canon', 'Drone Quadcopter', 'Speaker Bluetooth', 'Microphone Studio',
      'Television 4K OLED', 'Projector Home Cinema', 'Router WiFi', 'USB Flash Drive',
      'Smartwatch Apple', 'VR Headset', 'Game Controller', 'Printer Laser',
      'Server Rack', 'Hard Drive External', 'Webcam HD', 'Ring Light Studio',
      'Power Bank Portable', 'Charger Wireless', 'Cable Management', 'Antenna Satellite',
      'Solar Panel', 'Battery Pack'
    ],
    tags: ['electronics', 'tech', 'gadget', 'device', 'digital', 'modern']
  },
  kitchen: {
    items: [
      'Refrigerator Modern', 'Oven Built In', 'Microwave Counter', 'Dishwasher',
      'Blender Professional', 'Coffee Machine Espresso', 'Toaster 4 Slice', 'Kettle Electric',
      'Pot Cooking Set', 'Pan Frying Iron', 'Knife Set Chef', 'Cutting Board Wooden',
      'Wine Glass Crystal', 'Plate Dinner Set', 'Bowl Ceramic', 'Mug Coffee',
      'Fork Spoon Set', 'Mixer Stand Kitchen', 'Juicer Citrus', 'Rice Cooker',
      'Sink Kitchen Double', 'Faucet Modern', 'Trash Can Sensor', 'Spice Rack',
      'Fruit Basket Wire', 'Bread Box', 'Salt Pepper Shaker', 'Napkin Holder',
      'Tea Set Porcelain', 'Ice Cream Maker'
    ],
    tags: ['kitchen', 'appliance', 'cookware', 'utensil', 'dining', 'food']
  },
  decoration: {
    items: [
      'Vase Ceramic Modern', 'Painting Abstract Wall', 'Sculpture Bronze', 'Mirror Round Gold',
      'Clock Wall Vintage', 'Candle Holder Set', 'Photo Frame Collection', 'Rug Persian',
      'Curtain Velvet', 'Pillow Decorative', 'Blanket Throw Knit', 'Lamp Floor Arc',
      'Lamp Table Reading', 'Chandelier Crystal', 'Wall Sconce', 'String Lights',
      'Plant Pot Hanging', 'Terrarium Glass', 'Globe World Map', 'Hourglass Sand',
      'Trophy Gold', 'Chess Set Marble', 'Incense Holder', 'Wind Chime',
      'Dreamcatcher Boho', 'Tapestry Wall Hanging', 'Figurine Porcelain', 'Snow Globe',
      'Music Box Vintage', 'Candelabra Gothic'
    ],
    tags: ['decoration', 'decor', 'ornament', 'interior', 'art', 'accessory']
  }
};

const CHANNELS = [
  'models3d_uz', 'free3dmodels', '3dmodels_archive', 'cgtrader_free',
  'blender_models', 'turbosquid_free', 'sketchfab_models', '3d_warehouse'
];

// ─── Soxta CLIP embedding generatsiyasi ──────────────────────────────────────

/**
 * 512 o'lchamli normallashtirilgan tasodifiy vektor yaratadi.
 * Bir xil kategoriya ichidagi modellar uchun o'xshash vektorlar hosil qiladi —
 * bu vektor qidiruvni testlash uchun muhim.
 *
 * @param {string} category - kategoriya nomi (bir xil kategoriya = o'xshash vektorlar)
 * @param {number} variation - variatsiya darajasi (0-1)
 */
function generateFakeEmbedding(category, variation = 0.3) {
  const dim = 512;
  const vec = new Float32Array(dim);

  // Kategoriya uchun deterministik "base" vektor — category nomining hash'i asosida
  let seed = 0;
  for (let i = 0; i < category.length; i++) {
    seed = ((seed << 5) - seed + category.charCodeAt(i)) | 0;
  }

  // Base vektor + tasodifiy variatsiya
  for (let i = 0; i < dim; i++) {
    // Deterministic pseudo-random (kategoriya bo'yicha guruhlash uchun)
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const base = (seed / 0x7fffffff) * 2 - 1;

    // Tasodifiy variatsiya qo'shish
    const noise = (Math.random() * 2 - 1) * variation;
    vec[i] = base + noise;
  }

  // L2 normalizatsiya (CLIP embedding'lari kabi)
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  for (let i = 0; i < dim; i++) vec[i] /= norm;

  return Array.from(vec);
}

// ─── Ma'lumot generatsiyasi ──────────────────────────────────────────────────

function generateModels(count) {
  const models = [];
  const categoryNames = Object.keys(CATEGORIES);

  for (let i = 0; i < count; i++) {
    const catName = categoryNames[i % categoryNames.length];
    const catData = CATEGORIES[catName];
    const itemName = catData.items[Math.floor(Math.random() * catData.items.length)];
    const channel = CHANNELS[Math.floor(Math.random() * CHANNELS.length)];

    // Unikal model kodi
    const modelCode = `seed_${Date.now()}_${i}_${Math.random().toString(36).substring(2, 8)}`;
    const ext = Math.random() > 0.5 ? '.zip' : '.rar';
    const fileName = `${itemName.replace(/\s+/g, '_').toLowerCase()}${ext}`;

    // 2-4 ta tasodifiy teglar
    const shuffledTags = [...catData.tags].sort(() => Math.random() - 0.5);
    const tags = shuffledTags.slice(0, 2 + Math.floor(Math.random() * 3));

    // O'zbek tilida caption
    const captions = [
      `${itemName} - yuqori sifatli 3D model`,
      `${itemName} | 3DS MAX, Blender, FBX formatlarida`,
      `${catName} kategoriyasidagi ${itemName} modeli`,
      `Professional ${itemName} 3D model — tayyor loyiha uchun`,
      `${itemName} — tekstura va materiallar bilan`,
    ];
    const caption = captions[Math.floor(Math.random() * captions.length)];

    // Embedding — bir xil kategoriya ichidagi modellar o'xshash bo'ladi
    const embedding = generateFakeEmbedding(catName, 0.25);

    models.push({
      modelCode,
      channelUsername: channel,
      messageId: 1000 + i,
      photoMessageId: 999 + i,
      imagePath: `/seed_images/${channel}_${modelCode}.jpg`,
      documentFileName: fileName,
      caption,
      embedding,
      category: catName,
      tags,
      searchCount: Math.floor(Math.random() * 50),
      lastSearchedAt: Math.random() > 0.5 ? new Date(Date.now() - Math.random() * 30 * 24 * 60 * 60 * 1000) : null,
      createdAt: new Date(Date.now() - Math.random() * 90 * 24 * 60 * 60 * 1000)
    });
  }

  return models;
}

// ─── Asosiy funksiya ─────────────────────────────────────────────────────────

async function main() {
  const isClean = process.argv.includes('--clean');

  await mongoose.connect(process.env.MONGODB_URI);
  console.log('✅ MongoDB ulandi');

  if (isClean) {
    // seed_ bilan boshlanadigan barcha ma'lumotlarni o'chirish
    const result = await Model3D.deleteMany({ modelCode: { $regex: /^seed_/ } });
    console.log(`🧹 ${result.deletedCount} ta test ma'lumot o'chirildi.`);
    await mongoose.disconnect();
    process.exit(0);
  }

  // Mavjud seed ma'lumotlar sonini tekshirish
  const existingSeeds = await Model3D.countDocuments({ modelCode: { $regex: /^seed_/ } });
  if (existingSeeds > 0) {
    console.log(`⚠️  Bazada allaqachon ${existingSeeds} ta test ma'lumot bor.`);
    console.log(`   O'chirish uchun: node seed.js --clean`);
    console.log(`   Davom etilmoqda — yana 500 ta qo'shiladi...\n`);
  }

  const COUNT = 500;
  console.log(`📊 ${COUNT} ta test 3D model generatsiya qilinmoqda...`);
  const models = generateModels(COUNT);

  console.log(`💾 MongoDB'ga yozilmoqda...`);
  let saved = 0;
  let failed = 0;

  // Batch insert (50 talab)
  const BATCH_SIZE = 50;
  for (let i = 0; i < models.length; i += BATCH_SIZE) {
    const batch = models.slice(i, i + BATCH_SIZE);
    try {
      await Model3D.insertMany(batch, { ordered: false });
      saved += batch.length;
      console.log(`  💾 ${saved}/${COUNT} saqlandi...`);
    } catch (err) {
      // duplicate key xatoligini e'tiborsiz qoldirish
      if (err.code === 11000) {
        const successCount = err.insertedDocs?.length || 0;
        saved += successCount;
        failed += batch.length - successCount;
      } else {
        failed += batch.length;
        console.error(`  ⚠️  Batch xatoligi:`, err.message);
      }
    }
  }

  console.log(`\n✅ Tugadi!`);
  console.log(`   💾 Saqlandi: ${saved} ta`);
  if (failed > 0) console.log(`   ⚠️  Xatolik: ${failed} ta`);
  console.log(`\n📊 Kategoriyalar:`);

  const catCounts = {};
  for (const m of models) {
    catCounts[m.category] = (catCounts[m.category] || 0) + 1;
  }
  for (const [cat, count] of Object.entries(catCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`   • ${cat}: ${count} ta`);
  }

  console.log(`\n🧹 Test ma'lumotlarni o'chirish: node seed.js --clean`);

  await mongoose.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error('Xatolik:', err);
  process.exit(1);
});
