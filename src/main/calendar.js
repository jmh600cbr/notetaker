// Outlook calendar (Microsoft 365) via Microsoft Graph.
//
// Used to name recordings after the meeting that's on now, pass attendee
// names to transcription and speaker identification, and remind the user to
// record when a meeting starts. Needs an app registration in the firm's
// Microsoft Entra ID (see README): a public client with the redirect URI
// http://localhost and the delegated permission Calendars.Read.
const fs = require('fs');
const path = require('path');

const SCOPES = ['Calendars.Read', 'User.Read'];
const GRAPH = 'https://graph.microsoft.com/v1.0';

// The event that a recording starting at `now` most likely belongs to: one
// in progress, or one starting within the next 10 minutes. Online meetings
// win over other entries (e.g. "Focus time"); then the closest start.
function pickEvent(events, now = new Date()) {
  const t = now.getTime();
  const candidates = (events || [])
    .filter((e) => !e.isCancelled && !e.isAllDay)
    .map((e) => ({ e, start: Date.parse(`${e.start.dateTime}Z`), end: Date.parse(`${e.end.dateTime}Z`) }))
    .filter(({ start, end }) => start - 10 * 60000 <= t && t < end);
  candidates.sort((a, b) => {
    const online = Number(Boolean(b.e.isOnlineMeeting)) - Number(Boolean(a.e.isOnlineMeeting));
    if (online) return online;
    return Math.abs(a.start - t) - Math.abs(b.start - t);
  });
  return candidates.length ? candidates[0].e : null;
}

// Names of everyone on the invite (useful as transcription hints).
function attendeeNames(event) {
  if (!event) return [];
  const people = [event.organizer, ...(event.attendees || [])]
    .map((a) => a && a.emailAddress && a.emailAddress.name)
    .filter((n) => n && !n.includes('@'));
  return [...new Set(people)].slice(0, 30);
}

class Calendar {
  constructor({ baseDir, safeStorage, shell, getSettings, fetchImpl = fetch }) {
    this.fetch = fetchImpl;
    this.cacheFile = path.join(baseDir, 'calendar-token.bin');
    this.safeStorage = safeStorage;
    this.shell = shell;
    this.getSettings = getSettings;
    this.client = null;
    this.clientKey = '';
  }

  configured() {
    return Boolean(this.getSettings().calendarClientId);
  }

  // MSAL client, recreated if the app registration changes.
  pca() {
    const { calendarClientId, calendarTenant } = this.getSettings();
    if (!calendarClientId) throw new Error('Add your Microsoft app (client) ID in Settings first.');
    const key = `${calendarClientId}|${calendarTenant}`;
    if (this.client && this.clientKey === key) return this.client;
    const msal = require('@azure/msal-node');
    const self = this;
    this.client = new msal.PublicClientApplication({
      auth: {
        clientId: calendarClientId,
        authority: `https://login.microsoftonline.com/${calendarTenant || 'organizations'}`,
      },
      cache: {
        // Tokens are stored encrypted with the OS keychain.
        cachePlugin: {
          async beforeCacheAccess(ctx) {
            try {
              const raw = fs.readFileSync(self.cacheFile);
              ctx.tokenCache.deserialize(self.canEncrypt() ? self.safeStorage.decryptString(raw) : raw.toString('utf8'));
            } catch {
              // no cache yet
            }
          },
          async afterCacheAccess(ctx) {
            if (!ctx.cacheHasChanged) return;
            const data = ctx.tokenCache.serialize();
            fs.writeFileSync(self.cacheFile, self.canEncrypt() ? self.safeStorage.encryptString(data) : data, { mode: 0o600 });
          },
        },
      },
    });
    this.clientKey = key;
    return this.client;
  }

  canEncrypt() {
    return Boolean(this.safeStorage && this.safeStorage.isEncryptionAvailable());
  }

  async account() {
    if (!this.configured()) return null;
    const accounts = await this.pca().getTokenCache().getAllAccounts();
    return accounts[0] || null;
  }

  async status() {
    if (!this.configured()) return { configured: false, connected: false };
    try {
      const account = await this.account();
      return { configured: true, connected: Boolean(account), account: account ? account.username : null };
    } catch (err) {
      return { configured: true, connected: false, error: err.message };
    }
  }

  async connect() {
    const result = await this.pca().acquireTokenInteractive({
      scopes: SCOPES,
      openBrowser: async (url) => {
        await this.shell.openExternal(url);
      },
      successTemplate: '<h2>Sidebar is connected to your Outlook calendar.</h2><p>You can close this tab.</p>',
      errorTemplate: '<h2>Sidebar couldn\'t connect to Outlook.</h2><p>{error}</p>',
    });
    return { connected: true, account: result.account ? result.account.username : null };
  }

  async disconnect() {
    try {
      const cache = this.pca().getTokenCache();
      for (const a of await cache.getAllAccounts()) await cache.removeAccount(a);
    } catch {
      // not configured
    }
    fs.rmSync(this.cacheFile, { force: true });
    this.client = null;
  }

  async token() {
    const account = await this.account();
    if (!account) return null;
    const result = await this.pca().acquireTokenSilent({ account, scopes: SCOPES });
    return result.accessToken;
  }

  async events(from, to) {
    const token = await this.token();
    if (!token) return [];
    const params = new URLSearchParams({
      startDateTime: from.toISOString(),
      endDateTime: to.toISOString(),
      $select: 'id,subject,start,end,isAllDay,isCancelled,isOnlineMeeting,organizer,attendees,location',
      $orderby: 'start/dateTime',
      $top: '20',
    });
    const res = await this.fetch(`${GRAPH}/me/calendarView?${params}`, {
      headers: { Authorization: `Bearer ${token}`, Prefer: 'outlook.timezone="UTC"' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`Outlook calendar error (${res.status})`);
    return (await res.json()).value || [];
  }

  // The meeting on now, or null. Never throws: the calendar is a nice-to-have.
  async currentEvent() {
    try {
      const now = new Date();
      const events = await this.events(new Date(now.getTime() - 12 * 3600000), new Date(now.getTime() + 15 * 60000));
      return pickEvent(events, now);
    } catch {
      return null;
    }
  }

  async upcoming(hours = 12) {
    try {
      const now = new Date();
      const events = await this.events(now, new Date(now.getTime() + hours * 3600000));
      return events.filter((e) => !e.isCancelled && !e.isAllDay);
    } catch {
      return [];
    }
  }
}

module.exports = { Calendar, pickEvent, attendeeNames };
