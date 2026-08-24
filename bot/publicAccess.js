function getMessageText(ctx = {}) {
  return String(ctx.message?.text || '').trim();
}

function getCallbackData(ctx = {}) {
  return String(ctx.callbackQuery?.data || '').trim();
}

function isPublicCommand(text) {
  return /^\/(start|help)(\s|$)/.test(text);
}

function isStartCallback(data) {
  return data.startsWith('start_');
}

function shouldBypassAccessCheck(ctx = {}) {
  const text = getMessageText(ctx);
  const callbackData = getCallbackData(ctx);

  return isPublicCommand(text) || isStartCallback(callbackData);
}

module.exports = {
  shouldBypassAccessCheck,
  isPublicCommand,
  isStartCallback
};
