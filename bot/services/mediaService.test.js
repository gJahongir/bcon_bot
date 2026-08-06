const fs = require('fs');
const os = require('os');
const path = require('path');
const { sendDbModelToChat, sendChannelMediaToChat } = require('./mediaService');

jest.mock('telegram/client/uploads', () => {
  return {
    CustomFile: jest.fn().mockImplementation((name, size, path, buffer) => {
      return { name, size, path, buffer };
    })
  };
});

describe('mediaService', () => {
  let mockCtx;
  let mockClient;

  beforeEach(() => {
    jest.clearAllMocks();

    mockCtx = {
      chat: { id: 123456 },
      from: { id: 789, username: 'testuser' },
      telegram: {
        sendDocument: jest.fn().mockResolvedValue({ message_id: 999 }),
        sendPhoto: jest.fn().mockResolvedValue({ message_id: 998 }),
        editMessageText: jest.fn().mockResolvedValue(true),
        deleteMessage: jest.fn().mockResolvedValue(true),
      },
      reply: jest.fn().mockResolvedValue({ message_id: 111 })
    };

    mockClient = {
      getInputEntity: jest.fn().mockResolvedValue('input_entity'),
      getMessages: jest.fn().mockResolvedValue([]),
      downloadMedia: jest.fn().mockResolvedValue(Buffer.from('dummy data')),
      sendFile: jest.fn().mockResolvedValue(true)
    };
  });

  describe('sendDbModelToChat', () => {
    it('should return false if model is missing or fileData is missing', async () => {
      const result = await sendDbModelToChat(mockCtx, mockClient, null);
      expect(result).toBe(false);

      const result2 = await sendDbModelToChat(mockCtx, mockClient, { documentFileName: 'test.zip' });
      expect(result2).toBe(false);
    });

    it('should send document via Telegraf if file size is small (<= 50MB)', async () => {
      const model = {
        documentFileName: 'test.zip',
        fileData: Buffer.from('small file content')
      };

      const result = await sendDbModelToChat(mockCtx, mockClient, model);
      expect(result).toBe(true);
      expect(mockCtx.telegram.sendDocument).toHaveBeenCalledWith(
        mockCtx.chat.id,
        expect.objectContaining({
          filename: 'test.zip'
        })
      );
      expect(mockClient.sendFile).not.toHaveBeenCalled();
    });

    it('should fallback to GramJS client and write/cleanup temp file if bot sendDocument fails', async () => {
      // Mock bot sendDocument to fail (e.g. file too large or other error)
      mockCtx.telegram.sendDocument.mockRejectedValue(new Error('FILE_TOO_LARGE'));

      const spyWriteFileSync = jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
      const spyUnlinkSync = jest.spyOn(fs, 'unlinkSync').mockImplementation(() => {});
      const spyExistsSync = jest.spyOn(fs, 'existsSync').mockReturnValue(true);

      const model = {
        documentFileName: 'large_test.zip',
        fileData: Buffer.from('large file content'.repeat(1000))
      };

      const result = await sendDbModelToChat(mockCtx, mockClient, model);
      expect(result).toBe(true);
      expect(spyWriteFileSync).toHaveBeenCalled();
      expect(mockClient.sendFile).toHaveBeenCalledWith(
        'testuser',
        expect.objectContaining({
          forceDocument: true
        })
      );
      expect(spyUnlinkSync).toHaveBeenCalled();

      spyWriteFileSync.mockRestore();
      spyUnlinkSync.mockRestore();
      spyExistsSync.mockRestore();
    });
  });

  describe('sendChannelMediaToChat', () => {
    it('should throw error if message is not found', async () => {
      mockClient.getMessages.mockResolvedValue([]);

      await expect(
        sendChannelMediaToChat(mockCtx, mockClient, 'channel', 1)
      ).rejects.toThrow('message to forward not found');
    });

    it('should send photo directly via Telegraf if message is a photo', async () => {
      const mockPhotoMessage = {
        id: 1,
        photo: {}
      };
      mockClient.getMessages.mockResolvedValue([mockPhotoMessage]);
      mockClient.downloadMedia.mockResolvedValue(Buffer.from('photo binary data'));

      await sendChannelMediaToChat(mockCtx, mockClient, 'channel', 1);

      expect(mockClient.downloadMedia).toHaveBeenCalledWith(mockPhotoMessage);
      expect(mockCtx.telegram.sendPhoto).toHaveBeenCalledWith(
        mockCtx.chat.id,
        expect.objectContaining({
          source: expect.any(Buffer)
        })
      );
    });

    it('should download and send document, using GramJS fallback on failure', async () => {
      const mockDocMessage = {
        id: 123,
        document: {
          attributes: [
            { className: 'DocumentAttributeFilename', fileName: 'model.zip' }
          ]
        }
      };
      mockClient.getMessages.mockResolvedValue([mockDocMessage]);
      mockClient.downloadMedia.mockResolvedValue(Buffer.from('model file binary data'));
      mockCtx.telegram.sendDocument.mockRejectedValue(new Error('Bot blocked or file too large'));

      const spyWriteFileSync = jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
      const spyUnlinkSync = jest.spyOn(fs, 'unlinkSync').mockImplementation(() => {});
      const spyExistsSync = jest.spyOn(fs, 'existsSync').mockReturnValue(true);

      await sendChannelMediaToChat(mockCtx, mockClient, 'channel', 123);

      expect(mockClient.downloadMedia).toHaveBeenCalledWith(mockDocMessage, expect.any(Object));
      expect(spyWriteFileSync).toHaveBeenCalled();
      expect(mockClient.sendFile).toHaveBeenCalledWith(
        'testuser',
        expect.objectContaining({
          forceDocument: true
        })
      );
      expect(spyUnlinkSync).toHaveBeenCalled();

      spyWriteFileSync.mockRestore();
      spyUnlinkSync.mockRestore();
      spyExistsSync.mockRestore();
    });
  });
});
