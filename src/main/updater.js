// Keeps Sidebar up to date from the project's GitHub releases.
//
// Windows: electron-updater downloads the new installer in the background
// and installs it when Sidebar restarts.
//
// Mac: electron-updater requires an Apple Developer ID signature, which these
// builds don't have yet. Instead we download the new .dmg ourselves in the
// background, stage the new app next to the installed one, and swap them when
// the user clicks "Restart to update" (or the next time Sidebar quits).
// Files Sidebar downloads itself aren't quarantined, so macOS doesn't show
// the "can't verify" prompt again.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { app, shell, net } = require('electron');
const { isNewer } = require('./version');

const execFileAsync = promisify(execFile);
const run = (cmd, args) => execFileAsync(cmd, args, { timeout: 5 * 60 * 1000 });

const OWNER = 'jmh600cbr';
const REPO = 'notetaker';
const RELEASES_PAGE = `https://github.com/${OWNER}/${REPO}/releases/latest`;
const FIRST_CHECK_MS = 15 * 1000;
const CHECK_EVERY_MS = 60 * 60 * 1000;
// Opening the window also checks, at most this often.
const CHECK_ON_OPEN_MS = 15 * 60 * 1000;

// The .app bundle containing the running executable (…/Sidebar.app).
function currentBundlePath() {
  return path.resolve(process.execPath, '..', '..', '..');
}

// Apple-chip Macs running the Intel build under Rosetta should move to the
// native build.
function macArch() {
  return app.runningUnderARM64Translation ? 'arm64' : process.arch;
}

async function readPlist(appPath, key) {
  const { stdout } = await run('plutil', ['-extract', key, 'raw', '-o', '-', path.join(appPath, 'Contents', 'Info.plist')]);
  return stdout.trim();
}

class Updater {
  constructor({ onState, beforeInstall, installFailed, canRestart }) {
    this.onState = onState;
    this.beforeInstall = beforeInstall;
    this.installFailed = installFailed || (() => {});
    this.canRestart = canRestart;
    this.state = { status: 'idle', current: app.getVersion() };
    this.busy = false;
  }

  set(patch) {
    this.state = { ...this.state, ...patch };
    this.onState(this.state);
  }

  start() {
    if (!app.isPackaged) {
      this.set({ status: 'dev' });
      return;
    }
    if (process.platform === 'win32') this.setupWindows();
    if (process.platform === 'darwin') this.cleanupMacLeftovers();
    setTimeout(() => this.check(false), FIRST_CHECK_MS);
    setInterval(() => this.check(false), CHECK_EVERY_MS);
  }

  // Called when the user opens Sidebar's window. Sidebar often runs in the
  // tray for days, so don't make them wait for the hourly check.
  checkSoon() {
    if (!app.isPackaged || Date.now() - (this.lastCheckAt || 0) < CHECK_ON_OPEN_MS) return;
    this.check(false);
  }

  async check(userInitiated) {
    if (this.busy || ['ready', 'dev', 'downloading', 'installing', 'checking'].includes(this.state.status)) return this.state;
    this.lastCheckAt = Date.now();
    const before = this.state;
    try {
      if (process.platform === 'win32') {
        await this.win.checkForUpdates();
      } else if (process.platform === 'darwin') {
        await this.checkMac(userInitiated);
      }
    } catch (err) {
      // Background checks fail quietly (e.g. offline) and leave things as they
      // were; only report when the user asked.
      if (userInitiated) this.set({ status: 'error', error: err.message });
      else this.set({ status: before.status === 'checking' ? 'idle' : before.status, error: before.error || null });
    }
    return this.state;
  }

  // ---- Windows ----

  setupWindows() {
    const { autoUpdater } = require('electron-updater');
    this.win = autoUpdater;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('checking-for-update', () => this.set({ status: 'checking', error: null }));
    autoUpdater.on('update-not-available', () => this.set({ status: 'current' }));
    autoUpdater.on('update-available', (info) => this.set({ status: 'downloading', version: info.version, progress: 0 }));
    autoUpdater.on('download-progress', (p) => this.set({ status: 'downloading', progress: Math.round(p.percent) }));
    autoUpdater.on('update-downloaded', (info) => this.set({ status: 'ready', version: info.version }));
    autoUpdater.on('error', (err) => {
      if (['downloading', 'checking'].includes(this.state.status)) this.set({ status: 'error', error: err.message });
    });
  }

  // Windows is shutting down or logging off: installing now could be cut off
  // half-way and leave Sidebar missing, so install next time instead.
  onSessionEnd() {
    if (this.win) this.win.autoInstallOnAppQuit = false;
  }

  // ---- Mac ----

  async checkMac(userInitiated) {
    // A periodic re-check shouldn't make an "Update available" banner flicker.
    if (this.state.status !== 'available' || userInitiated) this.set({ status: 'checking', error: null });
    const res = await net.fetch(`https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Sidebar-Updater' },
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`Couldn't reach GitHub (${res.status}).`);
    const release = await res.json();
    const version = String(release.tag_name || '').replace(/^v/, '');
    const asset = isNewer(version, app.getVersion())
      ? (release.assets || []).find((a) => a.name.endsWith(`-${macArch()}.dmg`))
      : null;
    if (!asset) {
      this.set({ status: 'current' });
      return;
    }
    this.macAsset = asset;
    if (!(await this.canSelfInstall(currentBundlePath()))) {
      // e.g. installed by an administrator: offer a manual download instead.
      this.set({ status: 'available', version, manual: true, error: null });
      return;
    }
    this.set({ status: 'available', version, manual: false, error: null });
    await this.prepareMac();
  }

  // Downloads and stages the update in the background, then offers a restart.
  async prepareMac() {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.stageMac();
      this.set({ status: 'ready', error: null });
    } catch (err) {
      this.set({ status: 'error', error: `Update failed: ${err.message}` });
    } finally {
      this.busy = false;
    }
  }

  async downloadMac(asset, dir) {
    const file = path.join(dir, asset.name);
    const res = await net.fetch(asset.browser_download_url);
    if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}).`);
    const total = Number(res.headers.get('content-length')) || asset.size || 0;
    const hash = crypto.createHash('sha256');
    let received = 0;
    const self = this;
    // pipeline() rejects on any error (including a full disk) and closes the file.
    await pipeline(
      Readable.fromWeb(res.body),
      async function* (source) {
        for await (const chunk of source) {
          hash.update(chunk);
          received += chunk.length;
          const progress = total ? Math.round((received / total) * 100) : 0;
          if (progress !== self.state.progress) self.set({ status: 'downloading', progress });
          yield chunk;
        }
      },
      fs.createWriteStream(file),
    );
    // GitHub publishes a SHA-256 for each release file; refuse anything that
    // doesn't match, or that comes without one.
    if (!asset.digest || asset.digest !== `sha256:${hash.digest('hex')}`) {
      throw new Error('The downloaded update was corrupted. Please try again.');
    }
    return file;
  }

  // Can we replace the installed app ourselves? Needs a normal install that
  // this user owns, in a folder they can write to.
  async canSelfInstall(bundle) {
    if (!bundle.endsWith('.app') || bundle.includes('/AppTranslocation/') || bundle.startsWith('/Volumes/')) return false;
    try {
      await fs.promises.access(path.dirname(bundle), fs.constants.W_OK);
      const st = await fs.promises.stat(bundle);
      return st.uid === process.getuid();
    } catch {
      return false;
    }
  }

  // Downloads, verifies and stages the new app as "Sidebar.app.update". The
  // installed app isn't touched until swapStaged().
  async stageMac() {
    const bundle = currentBundlePath();

    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sidebar-update-'));
    const staged = `${bundle}.update`;
    const mount = path.join(dir, 'mount');
    let mounted = false;
    try {
      this.set({ status: 'downloading', progress: 0 });
      const file = await this.downloadMac(this.macAsset, dir);
      this.set({ status: 'installing' });
      await fs.promises.mkdir(mount);
      await run('hdiutil', ['attach', file, '-nobrowse', '-readonly', '-mountpoint', mount]);
      mounted = true;
      const source = (await fs.promises.readdir(mount)).find((n) => n.endsWith('.app'));
      if (!source) throw new Error('The update disk image did not contain the app.');
      await fs.promises.rm(staged, { recursive: true, force: true });
      await run('ditto', [path.join(mount, source), staged]);
      await run('codesign', ['--verify', '--deep', '--strict', staged]);

      // Don't install something that can't run here, or isn't what we expected.
      const stagedVersion = await readPlist(staged, 'CFBundleShortVersionString');
      if (stagedVersion !== this.state.version) {
        throw new Error(`The update contains version ${stagedVersion}, expected ${this.state.version}.`);
      }
      const minOs = await readPlist(staged, 'LSMinimumSystemVersion').catch(() => '');
      if (minOs && isNewer(minOs, process.getSystemVersion())) {
        throw new Error(`Sidebar ${stagedVersion} needs macOS ${minOs} or later.`);
      }
      this.stagedPath = staged;
    } catch (err) {
      await fs.promises.rm(staged, { recursive: true, force: true }).catch(() => {});
      throw err;
    } finally {
      if (mounted) await run('hdiutil', ['detach', mount, '-force', '-quiet']).catch(() => {});
      await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  // Puts the staged app in place. Synchronous so it can run while quitting.
  // The previous version is kept as "Sidebar.app.old-…" until the new one has
  // started (see cleanupMacLeftovers), so a bad update can be undone by hand.
  swapStaged() {
    if (!this.stagedPath || !fs.existsSync(this.stagedPath)) return false;
    const bundle = currentBundlePath();
    const old = `${bundle}.old-${Date.now()}`;
    fs.renameSync(bundle, old);
    try {
      fs.renameSync(this.stagedPath, bundle);
    } catch (err) {
      fs.renameSync(old, bundle);
      throw err;
    }
    this.stagedPath = null;
    return true;
  }

  // Runs at startup: the new version is up, so remove what an update left behind.
  cleanupMacLeftovers() {
    const bundle = currentBundlePath();
    if (!bundle.endsWith('.app')) return;
    const dir = path.dirname(bundle);
    const base = path.basename(bundle);
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (name.startsWith(`${base}.old-`) || name === `${base}.update`) {
        fs.promises.rm(path.join(dir, name), { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  // Called while quitting: if an update is staged, put it in place now so
  // the next launch runs the new version.
  applyOnQuit() {
    if (process.platform !== 'darwin' || !this.stagedPath) return;
    try {
      this.swapStaged();
    } catch (err) {
      console.error('Could not apply the update on quit:', err);
    }
  }

  relaunch() {
    this.beforeInstall();
    app.relaunch();
    app.exit(0);
  }

  // ---- install ----

  async install() {
    if (this.busy) return;
    if (process.platform === 'win32' && this.state.status === 'error') {
      this.set({ status: 'idle' });
      await this.check(true);
      return;
    }
    if (process.platform === 'win32' && this.state.status === 'ready') {
      this.beforeInstall();
      this.win.quitAndInstall(false, true);
      // If we're still running a few seconds later, installing didn't start.
      setTimeout(() => {
        this.installFailed();
        this.set({ status: 'error', error: 'The update could not be installed. Please try again later.' });
      }, 15000).unref();
      return;
    }
    if (process.platform === 'darwin' && this.state.status === 'ready' && this.stagedPath) {
      if (!this.canRestart()) return;
      try {
        this.swapStaged();
        this.relaunch();
      } catch (err) {
        this.set({ status: 'error', error: `Update failed: ${err.message}` });
      }
      return;
    }
    if (process.platform === 'darwin' && this.state.status === 'available' && this.state.manual) {
      shell.openExternal(RELEASES_PAGE);
      return;
    }
    if (process.platform === 'darwin' && this.state.status === 'error' && this.macAsset) {
      await this.prepareMac();
    }
  }
}

module.exports = { Updater };
