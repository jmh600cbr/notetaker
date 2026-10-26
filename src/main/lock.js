// Optional app lock: notes and transcripts can't be viewed until the user
// unlocks Sidebar with their Sidebar password (or Touch ID on a Mac).
// Recording keeps working while locked.
//
// While locked, a "locked" marker file tells the Claude extension (which
// reads Sidebar's data folder directly) not to answer.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MIN_PASSWORD = 6;

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 64, { N: 16384, r: 8, p: 1 });
}

class AppLock {
  constructor(baseDir) {
    this.file = path.join(baseDir, 'lock.json');
    this.marker = path.join(baseDir, 'locked');
    this.setLocked(this.enabled());
    this.failures = 0;
    this.blockedUntil = 0;
  }

  setLocked(locked) {
    this.locked = locked;
    try {
      if (locked) fs.writeFileSync(this.marker, '');
      else fs.rmSync(this.marker, { force: true });
    } catch {
      // best effort
    }
  }

  read() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return null;
    }
  }

  enabled() {
    const data = this.read();
    return Boolean(data && data.hash && data.salt);
  }

  setPassword(password) {
    if (String(password || '').length < MIN_PASSWORD) {
      throw new Error(`Use at least ${MIN_PASSWORD} characters.`);
    }
    const salt = crypto.randomBytes(16);
    const data = { salt: salt.toString('base64'), hash: hashPassword(password, salt).toString('base64') };
    fs.writeFileSync(this.file, JSON.stringify(data), { mode: 0o600 });
    this.setLocked(false);
  }

  check(password) {
    const data = this.read();
    if (!data) return true;
    const now = Date.now();
    if (now < this.blockedUntil) {
      throw new Error(`Too many attempts. Try again in ${Math.ceil((this.blockedUntil - now) / 1000)} seconds.`);
    }
    const expected = Buffer.from(data.hash, 'base64');
    const actual = hashPassword(password, Buffer.from(data.salt, 'base64'));
    const ok = actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
    if (ok) {
      this.failures = 0;
    } else if (++this.failures >= 5) {
      this.blockedUntil = now + 30000 * (this.failures - 4);
    }
    return ok;
  }

  unlock(password) {
    if (!this.check(password)) return false;
    this.setLocked(false);
    return true;
  }

  // Touch ID already proved the user is present.
  unlockTrusted() {
    this.setLocked(false);
  }

  disable(password) {
    if (!this.check(password)) throw new Error('That password is incorrect.');
    fs.rmSync(this.file, { force: true });
    this.setLocked(false);
  }

  lock() {
    if (this.enabled()) this.setLocked(true);
    return this.locked;
  }
}

module.exports = { AppLock, MIN_PASSWORD };
