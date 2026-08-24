jest.mock('@huggingface/transformers', () => ({
  pipeline: jest.fn(() => Promise.reject(new Error('network failed'))),
  RawImage: {
    read: jest.fn(() => Promise.resolve({}))
  },
  AutoTokenizer: {
    from_pretrained: jest.fn(() => Promise.reject(new Error('network failed')))
  },
  CLIPTextModelWithProjection: {
    from_pretrained: jest.fn(() => Promise.reject(new Error('network failed')))
  }
}));

const { pipeline, AutoTokenizer, CLIPTextModelWithProjection } = require('@huggingface/transformers');
const { getTextEmbedding, getImageEmbedding, preloadModels } = require('./clipClient');

describe('clipClient fallback behavior', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('returns a deterministic embedding when text CLIP loading fails', async () => {
    const embedding = await getTextEmbedding('red 3d printer model');

    expect(Array.isArray(embedding)).toBe(true);
    expect(embedding.length).toBeGreaterThan(0);
    expect(embedding[0]).toBeDefined();
  });

  test('returns a deterministic embedding when image CLIP loading fails', async () => {
    const embedding = await getImageEmbedding('/tmp/sample-image.jpg');

    expect(Array.isArray(embedding)).toBe(true);
    expect(embedding.length).toBeGreaterThan(0);
  });

  test('uses the ONNX-compatible CLIP model by default', async () => {
    const original = process.env.CLIP_MODEL;
    delete process.env.CLIP_MODEL;

    try {
      await preloadModels();
      expect(pipeline).toHaveBeenCalledWith(
        'image-feature-extraction',
        'Xenova/clip-vit-base-patch32',
        expect.any(Object)
      );
    } finally {
      if (original === undefined) {
        delete process.env.CLIP_MODEL;
      } else {
        process.env.CLIP_MODEL = original;
      }
    }
  });
});
