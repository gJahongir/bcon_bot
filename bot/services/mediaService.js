const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { CustomFile } = require('telegram/client/uploads');

const MAX_BOT_FILE_SIZE = 50 * 1024 * 1024; // 50MB

/**
 * DB dagi model arxiv faylini foydalanuvchiga yuboradi (agar 50MB dan katta bo'lsa, GramJS orqali yuboradi).
 */
async function sendDbModelToChat(ctx, client, model) {
  if (!model || !model.fileData) {
    return false;
  }

  const fileSize = model.fileData.length;

  try {
    if (fileSize > MAX_BOT_FILE_SIZE) {
      throw new Error('FILE_TOO_LARGE');
    }
    console.log(`💾 DB dan oqim orqali yuborilmoqda: ${model.documentFileName}`);
    const stream = Readable.from(model.fileData);
    await ctx.telegram.sendDocument(ctx.chat.id, {
      source: stream,
      filename: model.documentFileName
    });
    console.log(`✅ Arxiv DB dan muvaffaqiyatli yuborildi`);
    return true;
  } catch (dbSendErr) {
    console.log(`⚠️ DB dan bot orqali yuborishda xato (${dbSendErr.message}). User client orqali urinilmoqda...`);
    let statusMsg;
    let tempFilePath = null;
    try {
      statusMsg = await ctx.reply('📤 Katta fayl tayyorlanmoqda va yuborilmoqda, kuting...');
      
      tempFilePath = path.join(os.tmpdir(), `db_${Date.now()}_${model.documentFileName}`);
      fs.writeFileSync(tempFilePath, model.fileData);

      const toUpload = new CustomFile(model.documentFileName, fileSize, tempFilePath);
      
      let peer = ctx.chat.id;
      if (ctx.from && ctx.from.username) {
        peer = ctx.from.username;
      }
      
      await client.sendFile(peer, {
        file: toUpload,
        forceDocument: true
      });
      console.log(`✅ Arxiv DB dan user client orqali muvaffaqiyatli yuborildi`);
      
      await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
      return true;
    } catch (err) {
      if (statusMsg) {
        await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
      }
      throw err;
    } finally {
      if (tempFilePath && fs.existsSync(tempFilePath)) {
        try {
          fs.unlinkSync(tempFilePath);
        } catch (cleanupErr) {
          console.error('Temp file cleanup error:', cleanupErr);
        }
      }
    }
  }
}

/**
 * Kanaldan mediani yuklab olib, chatga yuboradi.
 */
async function sendChannelMediaToChat(ctx, client, channelUsername, primaryMessageId, fallbackMessageId = 0) {
  const channel = channelUsername.startsWith('@') ? channelUsername.slice(1) : channelUsername;
  const candidateIds = [primaryMessageId];
  if (fallbackMessageId > 0 && fallbackMessageId !== primaryMessageId) {
    candidateIds.push(fallbackMessageId);
  }

  const inputEntity = await client.getInputEntity(channel);
  const messages = await client.getMessages(inputEntity, {
    ids: candidateIds
  });

  const message = messages.find((msg) => msg.id === primaryMessageId)
    || messages.find((msg) => msg.id === fallbackMessageId)
    || messages[0];

  if (!message) {
    throw new Error('message to forward not found');
  }

  let fileName = `channel_${message.id}.bin`;
  let buffer;

  if (message.document) {
    const filenameAttr = (message.document.attributes || []).find(
      (attr) => attr.className === 'DocumentAttributeFilename'
    );
    fileName = filenameAttr ? filenameAttr.fileName : fileName;

    const statusMsg = await ctx.reply('⏳ Arxiv kanaldan yuklab olinmoqda, iltimos kuting...');
    try {
      let lastEditTime = 0;
      buffer = await client.downloadMedia(message, {
        progressCallback: (downloaded, total) => {
          const now = Date.now();
          if (now - lastEditTime > 3000) {
            lastEditTime = now;
            const percent = Math.round((Number(downloaded) / Number(total)) * 100);
            const downloadedMB = (Number(downloaded) / 1024 / 1024).toFixed(1);
            const totalMB = (Number(total) / 1024 / 1024).toFixed(1);
            ctx.telegram.editMessageText(
              ctx.chat.id,
              statusMsg.message_id,
              null,
              `⏳ Arxiv yuklanmoqda: ${percent}% (${downloadedMB} / ${totalMB} MB)...`
            ).catch(() => {});
          }
        }
      });

      await ctx.telegram.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        null,
        `📤 Arxiv foydalanuvchiga yuborilmoqda...`
      ).catch(() => {});

      try {
        if (buffer.length > MAX_BOT_FILE_SIZE) {
          throw new Error('FILE_TOO_LARGE');
        }
        await ctx.telegram.sendDocument(ctx.chat.id, {
          source: Buffer.from(buffer),
          filename: fileName
        });
      } catch (sendErr) {
        console.log(`⚠️ Bot orqali yuborishda xato (${sendErr.message}). User client (GramJS) orqali yuborilmoqda...`);
        let tempFilePath = null;
        try {
          tempFilePath = path.join(os.tmpdir(), `fwd_${Date.now()}_${fileName}`);
          fs.writeFileSync(tempFilePath, buffer);

          const toUpload = new CustomFile(fileName, buffer.length, tempFilePath);
          
          let peer = ctx.chat.id;
          if (ctx.from && ctx.from.username) {
            peer = ctx.from.username;
          }
          
          await client.sendFile(peer, {
            file: toUpload,
            forceDocument: true
          });
          console.log(`✅ Arxiv user client orqali muvaffaqiyatli yuborildi`);
        } finally {
          if (tempFilePath && fs.existsSync(tempFilePath)) {
            try {
              fs.unlinkSync(tempFilePath);
            } catch (cleanupErr) {
              console.error('Temp file cleanup error:', cleanupErr);
            }
          }
        }
      }

      await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
    } catch (err) {
      await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
      throw err;
    }
  } else if (message.photo) {
    buffer = await client.downloadMedia(message);
    await ctx.telegram.sendPhoto(ctx.chat.id, {
      source: Buffer.from(buffer)
    });
  } else {
    throw new Error('message to forward not found');
  }
}

module.exports = {
  sendDbModelToChat,
  sendChannelMediaToChat
};
