const mongoose = require('mongoose');

const model3DSchema = new mongoose.Schema({
  modelCode: { type: String, required: true },
  channelUsername: { type: String, required: true },
  messageId: { type: Number, required: true },
  photoMessageId: { type: Number },
  imagePath: { type: String, required: true },
  documentFileName: { type: String, required: true },
  caption: { type: String, default: '' },
  embedding: { type: [Number], default: null },
  category: { type: String, default: '' },
  tags: { type: [String], default: [] },
  searchCount: { type: Number, default: 0 },
  lastSearchedAt: { type: Date, default: null },
  fileData: { type: Buffer, default: null },
  fileSize: { type: Number, default: 0 },
  fileType: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now }
});

model3DSchema.index({ channelUsername: 1, modelCode: 1 }, { unique: true });
model3DSchema.index({ category: 1 });
model3DSchema.index({ tags: 1 });

module.exports = mongoose.model('Model3D', model3DSchema, 'model3ds');