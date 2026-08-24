const fs = require('fs');
const path = require('path');

const LOCK_FILE = path.join(process.cwd(), '.bot.lock');

function acquireSingleInstanceLock() {
  try {
    fs.writeFileSync(LOCK_FILE, String(process.pid), { flag: 'wx' });
    return true;
  } catch (error) {
    return false;
  }
}

function releaseSingleInstanceLock() {
  try {
    fs.unlinkSync(LOCK_FILE);
  } catch (error) {
    // nothing to clean up
  }
}

module.exports = {
  acquireSingleInstanceLock,
  releaseSingleInstanceLock
};
