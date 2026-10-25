// Keeps Sidebar up to date from the project's GitHub releases.
//
// Windows: electron-updater downloads the new installer in the background
// and installs it when Sidebar restarts.
//
// Mac: electron-updater requires an Apple Developer ID signature, which these
// builds don't have yet. Instead we download the new .dmg ourselves, copy the
// app over the installed one and relaunch. Files Sidebar downloads itself
// aren't quarantined, so macOS doesn't show the "can't verify" prompt again.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { app, shell } = require('electron');
const { isNewer } = require('./version');

const run = promisify(execFile);

const OWNER = 'jmh600cbr';
const REPO = 'notetaker';
const RELEASES_PAGE = `https://github.com/${OWNER}/${REPO}/releases/latest`;
const FIRST_CHECK_MS = 15 * 1000;
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;

// The .app bundle containing the running executable (…/Sidebar.app).
function currentBundlePath() {
  return path.resolve(process.execPath, '..', '..', '..');
}

class Updater {
  constructor({ onState, beforeInstall, canRestart }) {
    this.onState = onState;
    this.beforeInstall = beforeInstall;
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
    setTimeout(() => this.check(false), FIRST_CHECK_MS);
    setInterval(() => this.check(false), CHECK_EVERY_MS);
  }

  async check(userInitiated) {
    if (this.busy || ['ready', 'dev', 'downloading', 'installing'].includes(this.state.status)) return this.state;
    try {
      if (process.platform === 'win32') {
        await this.win.checkForUpdates();
      } else if (process.platform === 'darwin') {
        await this.checkMac();
      }
    } catch (err) {
      // Background checks fail quietly (e.g. offline); only report when asked.
      this.set(userInitiated ? { status: 'error', error: err.message } : { status: 'idle' });
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
      if (this.state.status === 'downloading') this.set({ status: 'error', error: err.message });
    });
  }

  // ---- Mac ----

  async checkMac() {
    this.set({ status: 'checking', error: null });
    const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Sidebar-Updater' },
    });
    if (!res.ok) throw new Error(`Couldn't reach GitHub (${res.status}).`);
    const release = await res.json();
    if (!isNewer(release.tag_name, app.getVersion())) {
      this.set({ status: 'current' });
      return;
    }
    const asset = (release.assets || []).find((a) => a.name.endsWith(`-${process.arch}.dmg`));
    if (!asset) {
      this.set({ status: 'current' });
      return;
    }
    this.macAsset = asset;
    this.set({ status: 'available', version: release.tag_name.replace(/^v/, '') });
  }

  async downloadMac(asset) {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sidebar-update-'));
    const file = path.join(dir, asset.name);
    const res = await fetch(asset.browser_download_url);
    if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}).`);
    const total = Number(res.headers.get('content-length')) || asset.size || 0;
    const hash = crypto.createHash('sha256');
    const out = fs.createWriteStream(file);
    let received = 0;
    for await (const chunk of res.body) {
      hash.update(chunk);
      received += chunk.length;
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      const progress = total ? Math.round((received / total) * 100) : 0;
      if (progress !== this.state.progress) this.set({ status: 'downloading', progress });
    }
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
    // GitHub publishes a SHA-256 for each release file; refuse anything that doesn't match.
    if (asset.digest && asset.digest !== `sha256:${hash.digest('hex')}`) {
      throw new Error('The downloaded update was corrupted. Please try again.');
    }
    return { dir, file };
  }

  async installMac() {
    const bundle = currentBundlePath();
    const writable = await fs.promises
      .access(path.dirname(bundle), fs.constants.W_OK)
      .then(() => true)
      .catch(() => false);
    // Running from the disk image, a translocated download, or a folder we can't
    // write to: hand over to the browser for a manual install instead.
    if (!bundle.endsWith('.app') || bundle.includes('/AppTranslocation/') || bundle.startsWith('/Volumes/') || !writable) {
      shell.openExternal(RELEASES_PAGE);
      this.set({ status: 'available' });
      return;
    }

    this.set({ status: 'downloading', progress: 0 });
    const { dir, file } = await this.downloadMac(this.macAsset);
    this.set({ status: 'installing' });
    const mount = path.join(dir, 'mount');
    await fs.promises.mkdir(mount);
    await run('hdiutil', ['attach', file, '-nobrowse', '-readonly', '-mountpoint', mount]);
    const staged = `${bundle}.update`;
    const old = `${bundle}.old`;
    try {
      const source = (await fs.promises.readdir(mount)).find((n) => n.endsWith('.app'));
      if (!source) throw new Error('The update disk image did not contain the app.');
      await fs.promises.rm(staged, { recursive: true, force: true });
      await run('ditto', [path.join(mount, source), staged]);
      await run('codesign', ['--verify', '--deep', '--strict', staged]);
    } finally {
      await run('hdiutil', ['detach', mount, '-quiet']).catch(() => {});
    }
    // Swap the bundles; the running app keeps working from its open files.
    await fs.promises.rm(old, { recursive: true, force: true });
    await fs.promises.rename(bundle, old);
    try {
      await fs.promises.rename(staged, bundle);
    } catch (err) {
      await fs.promises.rename(old, bundle);
      throw err;
    }
    await fs.promises.rm(old, { recursive: true, force: true });
    await fs.promises.rm(dir, { recursive: true, force: true });

    // The new version is in place. If a recording started meanwhile, it runs
    // next time Sidebar opens (or when the user clicks "Restart to update").
    this.installedMac = true;
    if (this.canRestart()) this.relaunch();
    else this.set({ status: 'ready' });
  }

  relaunch() {
    this.beforeInstall();
    app.relaunch();
    app.exit(0);
  }

  // ---- install ----

  async install() {
    if (this.busy) return;
    if (process.platform === 'win32' && this.state.status === 'ready') {
      this.beforeInstall();
      this.win.quitAndInstall(false, true);
      return;
    }
    if (process.platform === 'darwin' && this.state.status === 'ready' && this.installedMac) {
      this.relaunch();
      return;
    }
    if (process.platform === 'darwin' && this.state.status === 'available') {
      this.busy = true;
      try {
        await this.installMac();
      } catch (err) {
        this.set({ status: 'error', error: `Update failed: ${err.message}` });
      } finally {
        this.busy = false;
      }
    }
  }
}

module.exports = { Updater };
