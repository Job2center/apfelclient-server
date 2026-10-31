// ApfelClient License Server (deploy-ready, zero dependencies).
//   Local JSON mode:  node server.js                      (PORT, DATA_DIR)
//   Supabase mode:    SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node server.js
// First run: POST /api/setup {username,password} creates the owner (admin).
"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const PORT = parseInt(process.env.PORT || "3766", 10);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "db.json");
const SB_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || "";
const USE_SB = SB_URL.length > 10 && SB_KEY.length > 20;
const BOT_SECRET = process.env.BOT_SECRET || "";
const onlinePresence = new Map();
const ONLINE_TTL_MS = 75000;
// ---------- helpers: Version, Changelog, Mod-Meta ----------

const CHANGELOG_FILE = path.join(__dirname, "changelog.json");
const MOD_JAR_NAME = "lwjgl-natives-3.3.3.jar";
const MOD_JAR = process.env.MOD_JAR_PATH || path.join(__dirname, "mod", MOD_JAR_NAME);
// Launcher-EXE wird direkt vom Server ausgeliefert (statt GitHub-Redirect).
// Der Dateiname auf der Platte darf Leerzeichen enthalten; ausgeliefert wird
// er unter einem sauberen Namen.
const LAUNCHER_EXE = process.env.LAUNCHER_EXE_PATH || path.join(__dirname, "launcher", "Apfel Launcher.exe");
const LAUNCHER_DOWNLOAD_NAME = "Apfel Launcher.exe";

function readVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, "version.json"), "utf8"));
  } catch (e) {
    return {};
  }
}

function readChangelog() {
  try {
    const raw = JSON.parse(fs.readFileSync(CHANGELOG_FILE, "utf8"));
    const list = Array.isArray(raw) ? raw : (raw.entries || []);
    return list
      .filter((e) => e && e.version)
      .map((e) => ({
        version: String(e.version),
        date: String(e.date || ""),
        title: String(e.title || ""),
        tags: Array.isArray(e.tags) ? e.tags.map(String).slice(0, 5) : [],
        changed: Array.isArray(e.changed) ? e.changed.map(String).slice(0, 30) : [],
        fixed: Array.isArray(e.fixed) ? e.fixed.map(String).slice(0, 30) : [],
        note: String(e.note || ""),
      }))
      .sort((a, b) => (newerVer(b.version, a.version) ? 1 : (newerVer(a.version, b.version) ? -1 : 0)));
  } catch (e) {
    return [];
  }
}

function newerVer(a, b) {
  const pa = String(a || "").split(".").map((x) => parseInt(x, 10) || 0);
  const pb = String(b || "").split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

// Changelog-Config (Admin-Edits + geloeschte Versionen) aus der DB laden.
// Selbstheilung: Enthaelt die "deleted"-Liste mehr als die Haelfte der aktuell
// existierenden Versionen, wurde sie nie bewusst gesetzt (wer die komplette
// Changelog verstecken wollte, wuerde die changelog.json loeschen) - solche
// Testmuell-Reste werden beim naechsten Zugriff automatisch zurueckgesetzt.
async function loadChangelogConfig() {
  const config = (await store.getSetting("changelog")) || { edits: {}, deleted: [] };
  config.edits = config.edits || {};
  if (!Array.isArray(config.deleted)) config.deleted = [];
  try {
    const existing = readChangelog().map((e) => e.version);
    const hits = config.deleted.filter((v) => existing.indexOf(v) !== -1).length;
    if (existing.length > 0 && hits > existing.length / 2) {
      config.deleted = [];
      await store.saveSetting("changelog", config);
    }
  } catch (e) {}
  return config;
}

let modMetaCache = { mtime: 0, size: 0, sha1: "" };

function modMeta(st) {
  if (modMetaCache.mtime === st.mtimeMs && modMetaCache.size === st.size) {
    return modMetaCache;
  }
  const hash = crypto.createHash("sha1");
  hash.update(fs.readFileSync(MOD_JAR));
  modMetaCache = { mtime: st.mtimeMs, size: st.size, sha1: hash.digest("hex") };
  return modMetaCache;
}

const DURATIONS = { lifetime: null, month: 30 * 86400, "7days": 7 * 86400 };
const LICENSE_LABEL = { lifetime: "Lifetime", month: "1 Month", "7days": "7 Days" };

function monthKey(d) {
  return d.toISOString().slice(0, 7);
}

function sha256(s) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

/* ---------------- storage ---------------- */

function loadJsonDb() {
  try {
    const db = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
    db.users = db.users || {};
    db.tokens = db.tokens || {};
    db.requests = db.requests || [];
    db.giveaway = db.giveaway || null;
    db.settings = db.settings || {};
    db.telemetry = db.telemetry || [];
    db.restarts = (db.restarts || 0) + 1;
    db.seq = db.seq || 1;
    return db;
  } catch (e) {
    return { users: {}, tokens: {}, requests: [], giveaway: null, settings: {}, telemetry: [], restarts: 1, seq: 1 };
  }
}

function saveJsonDb(db) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DB_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), "utf8");
  fs.renameSync(tmp, DB_FILE);
}

async function sb(path, method, body) {
  const res = await fetch(SB_URL + "/rest/v1/" + path, {
    method: method,
    headers: {
      apikey: SB_KEY,
      Authorization: "Bearer " + SB_KEY,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
  if (!res.ok) throw new Error("supabase " + res.status + ": " + text);
  return data;
}

function rowToUser(r) {
  return {
    username: r.username,
    isAdmin: !!r.is_admin,
    salt: r.salt,
    passHash: r.pass_hash,
    createdAt: r.created_at,
    lastLogin: r.last_login,
    hwid: r.hwid || null,
    license: r.license_type
      ? { type: r.license_type, grantedAt: r.license_granted_at, expiresAt: r.license_expires_at }
      : null,
    openRequest: r.open_request_type
      ? { type: r.open_request_type, at: r.open_request_at }
      : null,
    resetMonth: r.reset_month,
    resetsUsed: r.resets_used || 0,
    mustChangePw: !!r.must_change_pw,
    mustChangeUsername: !!r.must_change_username,
    _usernameFlagSupported: r.must_change_username !== undefined,
    discordId: r.discord_id || null,
    changelogSeen: r.changelog_seen || "",
  };
}

function userToRow(u) {
  return {
    username: u.username,
    is_admin: !!u.isAdmin,
    salt: u.salt,
    pass_hash: u.passHash,
    created_at: u.createdAt,
    last_login: u.lastLogin,
    hwid: u.hwid || null,
    license_type: u.license ? u.license.type : null,
    license_granted_at: u.license ? u.license.grantedAt : null,
    license_expires_at: u.license ? u.license.expiresAt : null,
    open_request_type: u.openRequest ? u.openRequest.type : null,
    open_request_at: u.openRequest ? u.openRequest.at : null,
    reset_month: u.resetMonth || null,
    resets_used: u.resetsUsed || 0,
    must_change_pw: !!u.mustChangePw,
    ...(u._usernameFlagSupported || u.mustChangeUsername ? { must_change_username: !!u.mustChangeUsername } : {}),
    discord_id: u.discordId || null,
    changelog_seen: u.changelogSeen || "",
  };
}

const eq = (v) => encodeURIComponent(v);

const store = USE_SB ? {
  async usersCount() {
    const rows = await sb("users?select=username", "GET");
    return rows.length;
  },
  async getUser(name) {
    const rows = await sb("users?username=eq." + eq(name) + "&select=*", "GET");
    return rows.length ? rowToUser(rows[0]) : null;
  },
  async saveUser(u) {
    const row = userToRow(u);
    const exists = await this.getUser(u.username);
    if (exists) {
      await sb("users?username=eq." + eq(u.username), "PATCH", row);
    } else {
      await sb("users", "POST", row);
    }
  },
  async renameUser(oldName, u) {
    await this.saveUser(u);
    await sb("tokens?username=eq." + eq(oldName), "PATCH", { username: u.username });
    await sb("notifications?username=eq." + eq(oldName), "PATCH", { username: u.username });
    await sb("requests?username=eq." + eq(oldName), "PATCH", { username: u.username });
    await sb("users?username=eq." + eq(oldName), "DELETE");
  },
  async deleteUser(name) {
    await sb("tokens?username=eq." + eq(name), "DELETE");
    await sb("notifications?username=eq." + eq(name), "DELETE");
    await sb("requests?username=eq." + eq(name), "DELETE");
    await sb("users?username=eq." + eq(name), "DELETE");
  },
  async listUsers() {
    const rows = await sb("users?select=*&order=username", "GET");
    return rows.map(rowToUser);
  },
  async tokenOwner(hash) {
    const rows = await sb("tokens?token_hash=eq." + eq(hash) + "&select=username", "GET");
    if (!rows.length) return null;
    return this.getUser(rows[0].username);
  },
  async saveToken(hash, name) {
    await sb("tokens", "POST", { token_hash: hash, username: name, created_at: Date.now() });
  },
  async getNotifications(name) {
    const rows = await sb("notifications?username=eq." + eq(name)
      + "&select=text,at,read&order=id.desc&limit=20", "GET");
    return rows.map((r) => ({ text: r.text, at: r.at, read: !!r.read }));
  },
  async addNotification(name, text) {
    await sb("notifications", "POST", { username: name, text, at: Date.now(), read: false });
  },
  async markRead(name) {
    await sb("notifications?username=eq." + eq(name) + "&read=eq.false", "PATCH", { read: true });
  },
  async openRequests() {
    const rows = await sb("requests?status=eq.open&select=id,username,type,at&order=id.desc", "GET");
    return rows.map((r) => ({ id: r.id, username: r.username, type: r.type, at: r.at }));
  },
  async addRequest(username, type, at) {
    await sb("requests", "POST", { username, type, at, status: "open" });
  },
  async resolveRequests(username, status) {
    await sb("requests?username=eq." + eq(username) + "&status=eq.open", "PATCH", { status });
  },
  async loadGiveaway() {
    const rows = await sb("giveaway?id=eq.1&select=payload", "GET");
    return rows.length ? rows[0].payload : null;
  },
  async saveGiveaway(g) {
    const row = { id: "1", payload: g || null, updated_at: Date.now() };
    const rows = await sb("giveaway?id=eq.1&select=id", "PATCH", row);
    if (!rows || !rows.length) {
      try { await sb("giveaway", "POST", row); } catch (e) {}
    }
  },
  async pushTelemetry(ev) {
    await sb("telemetry", "POST", ev);
  },
  async listTelemetry(limit) {
    return await sb("telemetry?select=*&order=id.desc&limit=" + limit, "GET");
  },
  async getSetting(key) {
    try {
      const rows = await sb("app_config?key=eq." + eq(key) + "&select=payload", "GET");
      return rows.length ? rows[0].payload : null;
    } catch (e) {
      // Keep the public changelog available during a rolling schema migration.
      return null;
    }
  },
  async saveSetting(key, payload) {
    const row = { key, payload, updated_at: Date.now() };
    const rows = await sb("app_config?key=eq." + eq(key) + "&select=key", "PATCH", row);
    if (!rows || !rows.length) await sb("app_config", "POST", row);
  },
  async restarts() {
    const rows = await sb("giveaway?id=eq.1&select=restarts", "GET");
    const n = (rows.length ? (rows[0].restarts || 0) : 0) + 1;
    if (rows.length) await sb("giveaway?id=eq.1", "PATCH", { restarts: n });
    return n;
  },
} : (() => {
  const DB = loadJsonDb();
  const persist = () => saveJsonDb(DB);
  return {
    async usersCount() { return Object.keys(DB.users).length; },
    async getUser(name) { return DB.users[name] || null; },
    async saveUser(u) { DB.users[u.username] = u; persist(); },
    async listUsers() {
      return Object.values(DB.users).sort((a, b) => a.username.localeCompare(b.username));
    },
    async tokenOwner(hash) {
      const name = DB.tokens[hash];
      return name ? (DB.users[name] || null) : null;
    },
    async renameUser(oldName, u) {
      DB.users[u.username] = u;
      delete DB.users[oldName];
      for (const k of Object.keys(DB.tokens)) {
        if (DB.tokens[k] === oldName) DB.tokens[k] = u.username;
      }
      for (const r of DB.requests) {
        if (r.username === oldName) r.username = u.username;
      }
      persist();
    },
    async deleteUser(name) {
      delete DB.users[name];
      for (const k of Object.keys(DB.tokens)) {
        if (DB.tokens[k] === name) delete DB.tokens[k];
      }
      DB.requests = DB.requests.filter((r) => r.username !== name);
      persist();
    },
    async saveToken(hash, name) { DB.tokens[hash] = name; persist(); },
    async getNotifications(name) {
      const u = DB.users[name];
      return ((u && u.notifications) || []).slice(-20).reverse();
    },
    async addNotification(name, text) {
      const u = DB.users[name];
      if (!u) return;
      u.notifications = u.notifications || [];
      u.notifications.push({ id: DB.seq++, text, at: Date.now(), read: false });
      if (u.notifications.length > 50) u.notifications = u.notifications.slice(-50);
      persist();
    },
    async markRead(name) {
      const u = DB.users[name];
      if (!u) return;
      for (const n of u.notifications || []) n.read = true;
      persist();
    },
    async openRequests() {
      return DB.requests.filter((r) => r.status === "open").reverse();
    },
    async addRequest(username, type, at) {
      DB.requests.push({ id: DB.seq++, username, type, at, status: "open" });
      persist();
    },
    async resolveRequests(username, status) {
      for (const r of DB.requests) {
        if (r.username === username && r.status === "open") r.status = status;
      }
      persist();
    },
    async loadGiveaway() { return DB.giveaway || null; },
    async saveGiveaway(g) { DB.giveaway = g || null; persist(); },
    async pushTelemetry(ev) {
      DB.telemetry.push(Object.assign({ id: DB.seq++, at: Date.now() }, ev));
      if (DB.telemetry.length > 500) DB.telemetry = DB.telemetry.slice(-500);
      persist();
    },
    async listTelemetry(limit) {
      return DB.telemetry.slice(-limit).reverse();
    },
    async getSetting(key) { return DB.settings[key] || null; },
    async saveSetting(key, payload) { DB.settings[key] = payload; persist(); },
    async restarts() { DB.restarts = (DB.restarts || 0) + 1; persist(); return DB.restarts; },
  };
})();

/* ---------------- helpers ---------------- */

// Giveaway: ein Giveaway gleichzeitig, Zustand liegt in der DB
// (vorher nur im RAM -> bei jedem Server-Restart/Spin-down verloren).
let giveawayState = null;
let giveawayLoaded = false;
let giveawayRestarts = 0;
const SERVER_BOOTED_AT = Date.now();
// { type, durationMin, maxWinners, startsAt, endsAt, joined: [names], status, winners, test }

async function loadGiveawayOnce() {
  if (giveawayLoaded) return giveawayState;
  giveawayLoaded = true;
  try {
    giveawayRestarts = await store.restarts();
    giveawayState = await store.loadGiveaway();
  } catch (e) {
    giveawayState = null;
  }
  return giveawayState;
}

async function saveGiveaway() {
  try { await store.saveGiveaway(giveawayState); } catch (e) {}
}

function giveawayView(username) {
  if (!giveawayState) return { ok: true, giveaway: null };
  const g = giveawayState;
  const active = g.status === "active" && Date.now() < g.endsAt;
  return {
    ok: true,
    giveaway: {
      type: g.type,
      label: LICENSE_LABEL[g.type],
      status: active ? "active" : g.status,
      startsAt: g.startsAt,
      endsAt: g.endsAt,
      endsIn: Math.max(0, g.endsAt - Date.now()),
      maxWinners: g.maxWinners,
      joinedCount: g.joined.length,
      hasJoined: g.joined.indexOf(username) !== -1,
      test: !!g.test,
      winners: g.status === "ended" ? g.winners : undefined,
    },
  };
}

async function finalizeGiveaway() {
  const g = giveawayState;
  if (!g || g.status === "ended") return;
  g.status = "ended";
  g.endedAt = Date.now();
  const pool = g.joined.slice();
  const winners = [];
  const n = Math.min(g.maxWinners, pool.length);
  for (let i = 0; i < n; i++) {
    winners.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  }
  g.winners = winners;
  const now = Date.now();
  for (const name of winners) {
    if (g.test) continue; // Testmodus: keine echten Lizenzen vergeben
    const u = await store.getUser(name);
    if (!u) continue;
    if (g.type === "lifetime") {
      u.license = { type: "lifetime", grantedAt: now, expiresAt: null };
    } else {
      const base = Math.max(now, (u.license && u.license.expiresAt) || 0);
      u.license = { type: g.type, grantedAt: now, expiresAt: base + DURATIONS[g.type] * 1000 };
    }
    await store.saveUser(u);
    await store.addNotification(name, "You won a " + LICENSE_LABEL[g.type] + " Key in the Giveaway!");
  }
}

async function maybeFinalizeGiveaway() {
  await loadGiveawayOnce();
  if (giveawayState && giveawayState.status === "active" && Date.now() >= giveawayState.endsAt) {
    await finalizeGiveaway();
    await saveGiveaway();
  }
}

// Selbstendauslauf, damit ein Giveaway auch ohne aktive Nutzer endet.
setInterval(() => { maybeFinalizeGiveaway().catch(() => {}); }, 30000).unref?.();


function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 65536) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}

function validName(n) {
  return typeof n === "string" && /^[A-Za-z0-9_]{3,16}$/.test(n);
}

function validPass(p) {
  return typeof p === "string" && p.length >= 4 && p.length <= 72;
}

function validNewPass(p) {
  return typeof p === "string" && p.length >= 4 && p.length <= 72;
}

function validHwid(h) {
  return typeof h === "string" && h.length >= 1 && h.length <= 256;
}

async function authUser(req) {
  const h = req.headers["authorization"] || "";
  const m = /^Bearer\s+(.+)$/.exec(h);
  if (!m) return null;
  return store.tokenOwner(sha256(m[1]));
}

function licenseView(u) {
  const now = Date.now();
  if (!u.license || !u.license.type) {
    return { active: false, type: null, expiresAt: null, daysLeft: 0 };
  }
  if (u.license.type === "lifetime") {
    return { active: true, type: "lifetime", expiresAt: null, daysLeft: -1 };
  }
  const exp = u.license.expiresAt || 0;
  if (exp <= now) return { active: false, type: u.license.type, expiresAt: exp, daysLeft: 0 };
  return {
    active: true,
    type: u.license.type,
    expiresAt: exp,
    daysLeft: Math.ceil((exp - now) / 86400000),
  };
}

function resetsLeft(u) {
  const mk = monthKey(new Date());
  if (u.resetMonth !== mk) return 2;
  return Math.max(0, 2 - (u.resetsUsed || 0));
}

async function userView(u) {
  const notes = await store.getNotifications(u.username);
  return {
    username: u.username,
    isAdmin: !!u.isAdmin,
    createdAt: u.createdAt,
    lastLogin: u.lastLogin,
    hwid: u.hwid || null,
    license: licenseView(u),
    resetsLeft: resetsLeft(u),
    mustChangePassword: !!u.mustChangePw,
    mustChangeUsername: !!u.mustChangeUsername,
    notifications: notes,
    unread: notes.filter((n) => !n.read).length,
  };
}

function newUser(username, password, isAdmin) {
  const salt = crypto.randomBytes(16).toString("hex");
  return {
    username, isAdmin: !!isAdmin,
    salt, passHash: sha256(salt + password),
    createdAt: Date.now(), lastLogin: 0, hwid: null,
    license: null, openRequest: null, notifications: [],
    resetMonth: monthKey(new Date()), resetsUsed: 0,
    mustChangePw: false, discordId: null,
    mustChangeUsername: false,
  };
}

async function mintToken(username) {
  const token = crypto.randomBytes(32).toString("hex");
  await store.saveToken(sha256(token), username);
  return token;
}

/* ---------------- routes ---------------- */

async function handle(req, res) {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    });
    res.end();
    return;
  }

  if (req.method === "GET" && p === "/api/health") {
    return send(res, 200, { ok: true, users: await store.usersCount(), db: USE_SB ? "supabase" : "json" });
  }

  if (req.method === "GET" && p === "/api/status") {
    const cutoff = Date.now() - ONLINE_TTL_MS;
    for (const [username, seenAt] of onlinePresence) {
      if (seenAt < cutoff) onlinePresence.delete(username);
    }
    // Namen fuer die klickbare Online-Liste im Launcher.
    return send(res, 200, {
      ok: true,
      onlineUsers: onlinePresence.size,
      names: Array.from(onlinePresence.keys()).slice(0, 50),
    });
  }

  if (req.method === "GET" && p === "/api/version") {
    try {
      const v = JSON.parse(fs.readFileSync(path.join(__dirname, "version.json"), "utf8"));
      return send(res, 200, {
        ok: true,
        mod: String(v.mod || ""),
        launcher: String(v.launcher || ""),
        launcherUrl: String(v.launcher || "") ? "/api/download/launcher" : "",
      });
    } catch (e) {
      return send(res, 200, { ok: true, mod: "", launcher: "", launcherUrl: "" });
    }
  }

  // Fester, immer gueltiger Link auf den aktuellen Launcher.
  // Diese Adresse kann dauerhaft weitergegeben werden - sie zeigt immer auf
  // die neueste Version, ohne dass sich der Link aendert. Wird direkt vom
  // Server ausgeliefert (kein GitHub-Redirect mehr) mit Range-Support.
  if (req.method === "GET" && p === "/api/download/launcher") {
    let st;
    try {
      st = fs.statSync(LAUNCHER_EXE);
    } catch (e) {
      return send(res, 404, { ok: false, error: "NO_LAUNCHER" });
    }
    const version = String(readVersion().launcher || "");
    const etag = '"' + crypto.createHash("sha1")
      .update(LAUNCHER_EXE + st.mtimeMs + st.size).digest("hex") + '"';
    const headers = {
      "Content-Type": "application/octet-stream",
      "Accept-Ranges": "bytes",
      "Content-Disposition": 'attachment; filename="Apfel Launcher' + (version ? " " + version : "") + '.exe"',
      ETag: etag,
      "Cache-Control": "no-cache",
      "Access-Control-Allow-Origin": "*",
      "X-Launcher-Version": version,
      "X-Launcher-Size": String(st.size),
    };

    // Range-Request: unterbrochenen Download fortsetzen.
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers["range"] || ""));
    if (range) {
      const start = range[1] ? parseInt(range[1], 10) : 0;
      const end = range[2] ? parseInt(range[2], 10) : st.size - 1;
      if (Number.isFinite(start) && Number.isFinite(end) && start <= end && start < st.size) {
        const last = Math.min(end, st.size - 1);
        headers["Content-Length"] = last - start + 1;
        headers["Content-Range"] = "bytes " + start + "-" + last + "/" + st.size;
        res.writeHead(206, headers);
        fs.createReadStream(LAUNCHER_EXE, { start, end: last }).pipe(res);
        return;
      }
    }

    headers["Content-Length"] = st.size;
    res.writeHead(200, headers);
    fs.createReadStream(LAUNCHER_EXE).pipe(res);
    return;
  }

  const body = req.method === "POST" ? await readBody(req) : {};
  if (req.method === "POST" && body === null) {
    return send(res, 400, { ok: false, error: "BAD_JSON" });
  }

  if (req.method === "POST" && p === "/api/setup") {
    if (await store.usersCount() > 0) {
      return send(res, 403, { ok: false, error: "ALREADY_SET_UP" });
    }
    const { username, password } = body;
    if (!validName(username) || !validPass(password)) {
      return send(res, 400, { ok: false, error: "BAD_CREDENTIALS" });
    }
    const u = newUser(username, password, true);
    await store.saveUser(u);
    const token = await mintToken(username);
    return send(res, 200, { ok: true, token, user: await userView(u) });
  }

  if (req.method === "POST" && p === "/api/login") {
    const { username, password, hwid } = body;
    const u = await store.getUser(username);
    if (!u || !validPass(password) || sha256(u.salt + password) !== u.passHash) {
      return send(res, 401, { ok: false, error: "BAD_LOGIN" });
    }
    if (!validHwid(hwid)) {
      return send(res, 400, { ok: false, error: "BAD_INPUT" });
    }
    if (u.hwid && u.hwid !== hwid) {
      return send(res, 403, { ok: false, error: "HWID_LOCKED", resetsLeft: resetsLeft(u) });
    }
    if (!u.hwid) u.hwid = hwid;
    u.lastLogin = Date.now();
    await store.saveUser(u);
    const token = await mintToken(username);
    return send(res, 200, { ok: true, token, user: await userView(u) });
  }

  // Bot: Account anlegen (oder Lizenz erneuern). Auth per BOT_SECRET.
  if (req.method === "POST" && p === "/api/bot/create") {
    const secret = (req.headers["authorization"] || "").replace(/^Bearer\s+/, "");
    if (!BOT_SECRET || secret !== BOT_SECRET) {
      return send(res, 403, { ok: false, error: "NO_AUTH" });
    }
    const { username, password, type, discordId } = body;
    if (!validName(username) || typeof password !== "string"
        || password.length < 4 || password.length > 72
        || !DURATIONS.hasOwnProperty(type)) {
      return send(res, 400, { ok: false, error: "BAD_INPUT" });
    }
    const now = Date.now();
    const lic = type === "lifetime"
      ? { type, grantedAt: now, expiresAt: null }
      : { type, grantedAt: now, expiresAt: now + DURATIONS[type] * 1000 };
    let u = await store.getUser(username);
    if (u) {
      u.salt = crypto.randomBytes(16).toString("hex");
      u.passHash = sha256(u.salt + password);
      u.license = lic;
      u.hwid = null;
      u.mustChangePw = true;
      if (discordId) u.discordId = String(discordId);
      await store.saveUser(u);
      await store.addNotification(username, "The Owner gave you a " + LICENSE_LABEL[type] + " Key!");
      return send(res, 200, { ok: true, created: false });
    }
    u = newUser(username, password, false);
    u.license = lic;
    u.mustChangePw = true;
    if (discordId) u.discordId = String(discordId);
    await store.saveUser(u);
    await store.addNotification(username, "The Owner gave you a " + LICENSE_LABEL[type] + " Key!");
    return send(res, 200, { ok: true, created: true });
  }

  const me = await authUser(req);
  if (!me && (p === "/api/me"
      || p === "/api/notifications/read" || p === "/api/hwid-reset"
      || p === "/api/change-password" || p === "/api/change-username"
      || p === "/api/presence"
      || p === "/api/announcements"
      || p === "/api/download/mod"
      || p === "/api/giveaway" || p === "/api/giveaway/join"
      || p.startsWith("/api/admin/"))) {
    return send(res, 401, { ok: false, error: "NO_AUTH" });
  }

  if (req.method === "POST" && p === "/api/presence") {
    if (body.active === false) onlinePresence.delete(me);
    else onlinePresence.set(me, Date.now());
    return send(res, 200, { ok: true });
  }

  if (req.method === "GET" && p === "/api/me") {
    return send(res, 200, { ok: true, user: await userView(me) });
  }

  // Announcements fuer alle User (vom Admin gepostet). Reihenfolge: neueste
  // zuerst. Jeder eingeloggte User darf lesen.
  if (req.method === "GET" && p === "/api/announcements") {
    const list = (await store.getSetting("announcements")) || [];
    const arr = Array.isArray(list) ? list : [];
    return send(res, 200, {
      ok: true,
      announcements: arr
        .map((a) => ({
          id: String(a.id || ""),
          title: String(a.title || ""),
          body: String(a.body || ""),
          at: a.at || 0,
          author: String(a.author || ""),
        }))
        .sort((a, b) => (b.at || 0) - (a.at || 0))
        .slice(0, 50),
    });
  }

  if (req.method === "GET" && p === "/api/download/mod") {
    try {
      if (!fs.existsSync(MOD_JAR)) {
        return send(res, 404, { ok: false, error: "NO_BUILD" });
      }
      const st = fs.statSync(MOD_JAR);
      const meta = modMeta(st);
      const ver = readVersion().mod || "";
      const etag = '"' + meta.sha1 + '"';

      if (req.headers["if-none-match"] === etag) {
        res.writeHead(304, { ETag: etag, "X-Mod-Version": ver, "X-Mod-SHA1": meta.sha1 });
        return res.end();
      }

      const headers = {
        "Content-Type": "application/java-archive",
        "Content-Length": st.size,
        "Content-Disposition": 'attachment; filename="' + MOD_JAR_NAME + '"',
        "Accept-Ranges": "bytes",
        ETag: etag,
        "Cache-Control": "no-cache",
        "X-Mod-Version": ver,
        "X-Mod-SHA1": meta.sha1,
        "X-Mod-Size": String(st.size),
      };

      // Range-Request: Launcher kann einen unterbrochenen Download fortsetzen.
      const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers["range"] || ""));
      if (range) {
        const start = range[1] ? parseInt(range[1], 10) : 0;
        const end = range[2] ? parseInt(range[2], 10) : st.size - 1;
        if (Number.isFinite(start) && Number.isFinite(end) && start <= end && start < st.size) {
          const last = Math.min(end, st.size - 1);
          headers["Content-Length"] = last - start + 1;
          headers["Content-Range"] = "bytes " + start + "-" + last + "/" + st.size;
          res.writeHead(206, headers);
          fs.createReadStream(MOD_JAR, { start, end: last }).pipe(res);
          return;
        }
      }

      res.writeHead(200, headers);
      fs.createReadStream(MOD_JAR).pipe(res);
    } catch (e) {
      send(res, 500, { ok: false, error: "SERVER_ERROR" });
    }
    return;
  }

  // Changelog (oeffentlich) + "gesehen"-Markierung
  if (req.method === "GET" && p === "/api/changelog") {
    const config = await loadChangelogConfig();
    const edited = config.edits || {};
    const deleted = new Set(config.deleted || []);
    const all = readChangelog().filter((e) => !deleted.has(e.version)).map((e) => edited[e.version] || e);
    for (const [version, entry] of Object.entries(edited)) {
      if (!all.some((e) => e.version === version) && !deleted.has(version)) all.push(entry);
    }
    all.sort((a, b) => newerVer(b.version, a.version) ? 1 : (newerVer(a.version, b.version) ? -1 : 0));
    const seen = me && me.changelogSeen ? String(me.changelogSeen) : "";
    return send(res, 200, {
      ok: true,
      mod: readVersion().mod || "",
      launcher: readVersion().launcher || "",
      seen,
      entries: all,
      unseen: all.some((e) => newerVer(e.version, seen)),
    });
  }

  if (req.method === "POST" && p === "/api/changelog/ack") {
    if (!me) return send(res, 401, { ok: false, error: "NO_AUTH" });
    const v = String(body.version || "");
    if (v) {
      me.changelogSeen = v;
      await store.saveUser(me);
    }
    return send(res, 200, { ok: true, seen: me.changelogSeen || "" });
  }

  // Anonyme Telemetrie: nur Versionen + Fehlerklasse, kein Name, kein HWID.
  if (req.method === "POST" && p === "/api/telemetry") {
    try {
      const kind = body.kind === "startup" ? "startup" : "crash";
      const ev = {
        kind,
        at: Date.now(),
        mod: String(body.mod || "").slice(0, 20),
        launcher: String(body.launcher || "").slice(0, 20),
        mc: String(body.mc || "").slice(0, 20),
        os: String(body.os || "").slice(0, 40),
        java: String(body.java || "").slice(0, 40),
        error: String(body.error || "").slice(0, 300),
        detail: String(body.detail || "").slice(0, 600),
      };
      if (!ev.mod && !ev.error) return send(res, 400, { ok: false, error: "BAD_INPUT" });
      await store.pushTelemetry(ev);
      return send(res, 200, { ok: true });
    } catch (e) {
      return send(res, 200, { ok: true });
    }
  }

  if (req.method === "POST" && p === "/api/change-password") {
    if (!validNewPass(body.password)) {
      return send(res, 400, { ok: false, error: "WEAK_PASSWORD" });
    }
    me.salt = crypto.randomBytes(16).toString("hex");
    me.passHash = sha256(me.salt + body.password);
    me.mustChangePw = false;
    await store.saveUser(me);
    return send(res, 200, { ok: true, user: await userView(me) });
  }

  if (req.method === "POST" && p === "/api/change-username") {
    const nn = body.username;
    if (!validName(nn)) {
      return send(res, 400, { ok: false, error: "BAD_INPUT" });
    }
    if (nn === me.username) {
      if (me.mustChangeUsername) return send(res, 400, { ok: false, error: "BAD_INPUT" });
      return send(res, 200, { ok: true, user: await userView(me) });
    }
    if (await store.getUser(nn)) {
      return send(res, 409, { ok: false, error: "NAME_TAKEN" });
    }
    const old = me.username;
    me.username = nn;
    me.mustChangeUsername = false;
    await store.renameUser(old, me);
    const token = await mintToken(nn);
    return send(res, 200, { ok: true, token, user: await userView(me) });
  }

  if (req.method === "POST" && p === "/api/notifications/read") {
    await store.markRead(me.username);
    return send(res, 200, { ok: true });
  }

  if (req.method === "POST" && p === "/api/hwid-reset") {
    const left = resetsLeft(me);
    if (left <= 0) {
      return send(res, 403, { ok: false, error: "NO_RESETS_LEFT", resetsLeft: 0 });
    }
    const mk = monthKey(new Date());
    if (me.resetMonth !== mk) { me.resetMonth = mk; me.resetsUsed = 0; }
    me.resetsUsed = (me.resetsUsed || 0) + 1;
    me.hwid = null;
    await store.saveUser(me);
    return send(res, 200, { ok: true, resetsLeft: resetsLeft(me) });
  }

  // Giveaway (alle eingeloggten User)
  if (req.method === "GET" && p === "/api/giveaway") {
    await maybeFinalizeGiveaway();
    return send(res, 200, giveawayView(me.username));
  }

  if (req.method === "POST" && p === "/api/giveaway/join") {
    await maybeFinalizeGiveaway();
    const g = giveawayState;
    if (!g || g.status !== "active" || Date.now() >= g.endsAt) {
      return send(res, 400, { ok: false, error: "NO_GIVEAWAY" });
    }
    if (g.joined.indexOf(me.username) === -1) g.joined.push(me.username);
    await saveGiveaway();
    return send(res, 200, giveawayView(me.username));
  }

  if (p.startsWith("/api/admin/") && !me.isAdmin) {
    return send(res, 403, { ok: false, error: "NOT_ADMIN" });
  }

  // Giveaway starten (Admin)
  if (req.method === "POST" && p === "/api/admin/giveaway/start") {
    await maybeFinalizeGiveaway();
    if (giveawayState && giveawayState.status === "active" && Date.now() < giveawayState.endsAt) {
      return send(res, 400, { ok: false, error: "GIVEAWAY_ACTIVE" });
    }
    const { type, durationMin, maxWinners } = body;
    if (!DURATIONS.hasOwnProperty(type)) {
      return send(res, 400, { ok: false, error: "BAD_INPUT" });
    }
    const dur = Math.max(1, Math.min(24 * 60, Math.round(Number(durationMin) || 60)));
    const mw = Math.max(1, Math.min(100, Math.round(Number(maxWinners) || 1)));
    const now = Date.now();
    giveawayState = {
      type, durationMin: dur, maxWinners: mw,
      startsAt: now, endsAt: now + dur * 60000,
      joined: [], status: "active", winners: [], test: false,
    };
    await loadGiveawayOnce();
    giveawayState = {
      type, durationMin: dur, maxWinners: mw,
      startsAt: now, endsAt: now + dur * 60000,
      joined: [], status: "active", winners: [], test: false,
    };
    await saveGiveaway();
    return send(res, 200, giveawayView(me.username));
  }

  // Testmodus: kurzes Giveaway, zieht Gewinner, vergibt aber KEINE Lizenz.
  if (req.method === "POST" && p === "/api/admin/giveaway/test") {
    await maybeFinalizeGiveaway();
    const dur = Math.max(1, Math.min(60, Math.round(Number(body.durationMin) || 3)));
    const mw = Math.max(1, Math.min(10, Math.round(Number(body.maxWinners) || 1)));
    const type = DURATIONS.hasOwnProperty(body.type) ? body.type : "7days";
    const now = Date.now();
    giveawayState = {
      type, durationMin: dur, maxWinners: mw,
      startsAt: now, endsAt: now + dur * 60000,
      joined: [], status: "active", winners: [], test: true,
    };
    await saveGiveaway();
    return send(res, 200, giveawayView(me.username));
  }

  // Diagnose: warum "funktioniert das Giveaway nicht"?
  if (req.method === "GET" && p === "/api/admin/giveaway/diag") {
    await loadGiveawayOnce();
    const g = giveawayState;
    return send(res, 200, {
      ok: true,
      diag: {
        storage: USE_SB ? "supabase" : "json",
        restarts: giveawayRestarts,
        uptimeSec: Math.round((Date.now() - SERVER_BOOTED_AT) / 1000),
        loaded: giveawayLoaded,
        hasState: !!g,
        state: g ? {
          type: g.type, status: g.status, test: !!g.test,
          joinedCount: g.joined.length, winners: g.winners || [],
          startsAgoSec: Math.round((Date.now() - g.startsAt) / 1000),
          endsInSec: Math.round((g.endsAt - Date.now()) / 1000),
        } : null,
      },
    });
  }

  // Giveaway sofort beenden + Gewinner ziehen (Admin)
  if (req.method === "POST" && p === "/api/admin/giveaway/end") {
    await loadGiveawayOnce();
    if (!giveawayState || giveawayState.status !== "active") {
      return send(res, 400, { ok: false, error: "NO_GIVEAWAY" });
    }
    await finalizeGiveaway();
    await saveGiveaway();
    return send(res, 200, giveawayView(me.username));
  }

  if (req.method === "GET" && p === "/api/admin/telemetry") {
    const limit = Math.max(1, Math.min(200, Math.round(Number(body.limit) || 50)));
    const rows = await store.listTelemetry(limit);
    return send(res, 200, { ok: true, events: rows || [] });
  }

  if (req.method === "GET" && p === "/api/admin/users") {
    const all = await store.listUsers();
    const list = [];
    for (const u of all) {
      list.push({
        username: u.username,
        isAdmin: !!u.isAdmin,
        createdAt: u.createdAt,
        lastLogin: u.lastLogin,
        hwid: u.hwid || null,
        license: licenseView(u),
        resetsLeft: resetsLeft(u),
        mustChangePw: !!u.mustChangePw,
      });
    }
    return send(res, 200, { ok: true, users: list });
  }

  if (req.method === "POST" && p === "/api/admin/create-user") {
    const username = String(body.username || "").trim();
    const type = String(body.licenseType || "none");
    if (!validName(username) || !["none", "lifetime", "month", "7days"].includes(type)
        || await store.getUser(username)) return send(res, 400, { ok: false, error: "BAD_INPUT" });
    // Shared first-login marker; new accounts are forced to set both credentials.
    const password = "Change";
    const user = newUser(username, password, false);
    user.mustChangePw = true;
    user.mustChangeUsername = true;
    if (type !== "none") {
      const now = Date.now();
      user.license = { type, grantedAt: now, expiresAt: type === "lifetime" ? null : now + DURATIONS[type] * 1000 };
    }
    try {
      await store.saveUser(user);
    } catch (e) {
      if (USE_SB) return send(res, 503, { ok: false, error: "DB_MIGRATION_REQUIRED" });
      throw e;
    }
    return send(res, 200, { ok: true, username, password, licenseType: type });
  }

  if (req.method === "POST" && (p === "/api/admin/changelog/save" || p === "/api/admin/changelog/delete" || p === "/api/admin/changelog/restore")) {
    // restore: geloeschte Versionen zuruecksetzen (alle wieder sichtbar).
    if (p.endsWith("/restore")) {
      const cfg = (await store.getSetting("changelog")) || { edits: {}, deleted: [] };
      cfg.edits = cfg.edits || {};
      cfg.deleted = [];
      await store.saveSetting("changelog", cfg);
      return send(res, 200, { ok: true });
    }
    const version = String(body.version || "").trim();
    if (!/^\d+(?:\.\d+){1,3}$/.test(version)) return send(res, 400, { ok: false, error: "BAD_INPUT" });
    const config = await loadChangelogConfig();
    config.edits = config.edits || {};
    config.deleted = Array.isArray(config.deleted) ? config.deleted : [];
    if (p.endsWith("/delete")) {
      delete config.edits[version];
      if (!config.deleted.includes(version)) config.deleted.push(version);
    } else {
      const split = (v, max, limit) => String(v || "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean).slice(0, max).map((x) => x.slice(0, limit));
      const tags = String(body.tags || "").split(",").map((x) => x.trim()).filter(Boolean).slice(0, 5).map((x) => x.slice(0, 32));
      const entry = { version, date: String(body.date || "").slice(0, 20), title: String(body.title || "").slice(0, 120), tags,
        changed: split(body.changed, 30, 240), fixed: split(body.fixed, 30, 240), note: String(body.note || "").slice(0, 500) };
      if (!entry.title) return send(res, 400, { ok: false, error: "BAD_INPUT" });
      config.edits[version] = entry;
      config.deleted = config.deleted.filter((v) => v !== version);
    }
    try {
      await store.saveSetting("changelog", config);
    } catch (e) {
      if (USE_SB) return send(res, 503, { ok: false, error: "DB_MIGRATION_REQUIRED" });
      throw e;
    }
    return send(res, 200, { ok: true });
  }

  if (req.method === "POST" && p === "/api/admin/set-password") {
    const { username, password } = body;
    const u = await store.getUser(username);
    if (!u || !validNewPass(password)) {
      return send(res, 400, { ok: false, error: "BAD_INPUT" });
    }
    u.salt = crypto.randomBytes(16).toString("hex");
    u.passHash = sha256(u.salt + password);
    u.mustChangePw = true;
    await store.saveUser(u);
    return send(res, 200, { ok: true });
  }

  if (req.method === "POST" && p === "/api/admin/grant") {
    const { username, type } = body;
    const u = await store.getUser(username);
    if (!u || !DURATIONS.hasOwnProperty(type)) {
      return send(res, 400, { ok: false, error: "BAD_INPUT" });
    }
    const now = Date.now();
    if (type === "lifetime") {
      u.license = { type, grantedAt: now, expiresAt: null };
    } else {
      const base = Math.max(now, (u.license && u.license.expiresAt) || 0);
      u.license = { type, grantedAt: now, expiresAt: base + DURATIONS[type] * 1000 };
    }
    u.openRequest = null;
    await store.saveUser(u);
    await store.resolveRequests(username, "granted");
    await store.addNotification(username, "The Owner gave you a " + LICENSE_LABEL[type] + " Key!");
    return send(res, 200, { ok: true, license: licenseView(u) });
  }

  if (req.method === "POST" && p === "/api/admin/revoke") {
    const u = await store.getUser(body.username);
    if (!u) return send(res, 400, { ok: false, error: "BAD_INPUT" });
    u.license = null;
    await store.saveUser(u);
    await store.addNotification(body.username, "Your license was revoked by the Owner.");
    return send(res, 200, { ok: true });
  }

  if (req.method === "POST" && p === "/api/admin/delete") {
    const u = await store.getUser(body.username);
    if (!u || u.username === me.username || u.isAdmin) {
      return send(res, 400, { ok: false, error: "BAD_INPUT" });
    }
    await store.deleteUser(u.username);
    return send(res, 200, { ok: true });
  }

  if (req.method === "POST" && p === "/api/admin/hwid-reset") {
    const u = await store.getUser(body.username);
    if (!u) return send(res, 400, { ok: false, error: "BAD_INPUT" });
    u.hwid = null;
    await store.saveUser(u);
    return send(res, 200, { ok: true });
  }

  // ---------- Admin-Rollen (geben / entziehen) ----------
  // Ein Admin kann andere befördern. Entziehen: nicht sich selbst und nicht
  // den letzten Admin (sonst wäre niemand mehr admin).
  if (req.method === "POST" && (p === "/api/admin/make-admin" || p === "/api/admin/revoke-admin")) {
    const u = await store.getUser(body.username);
    if (!u) return send(res, 400, { ok: false, error: "BAD_INPUT" });
    const grant = p.endsWith("make-admin");
    if (grant) {
      u.isAdmin = true;
      await store.saveUser(u);
      await store.addNotification(u.username, "You were promoted to Admin.");
      return send(res, 200, { ok: true, isAdmin: true });
    }
    // Entziehen: nicht sich selbst und nicht den letzten Admin.
    if (u.username === me.username) {
      return send(res, 400, { ok: false, error: "CANNOT_DEMOTE_SELF" });
    }
    const admins = (await store.listUsers()).filter((x) => x.isAdmin);
    if (admins.length <= 1) {
      return send(res, 400, { ok: false, error: "LAST_ADMIN" });
    }
    u.isAdmin = false;
    await store.saveUser(u);
    await store.addNotification(u.username, "Your Admin access was removed.");
    return send(res, 200, { ok: true, isAdmin: false });
  }

  // ---------- Announcements (verwalten) ----------
  if (req.method === "POST" && p === "/api/admin/announcements") {
    const title = String(body.title || "").trim().slice(0, 120);
    const text = String(body.body || "").trim().slice(0, 2000);
    if (!title || !text) return send(res, 400, { ok: false, error: "BAD_INPUT" });
    const list = (await store.getSetting("announcements")) || [];
    const arr = Array.isArray(list) ? list : [];
    const entry = {
      id: crypto.randomBytes(8).toString("hex"),
      title,
      body: text,
      at: Date.now(),
      author: me.username,
    };
    arr.push(entry);
    // Optional an alle User als Notification broadcasten.
    if (body.broadcast !== false) {
      try {
        const users = await store.listUsers();
        for (const usr of users) {
          try {
            await store.addNotification(usr.username, "Announcement: " + title);
          } catch (e2) {}
        }
      } catch (e) {}
    }
    await store.saveSetting("announcements", arr.slice(-200));
    return send(res, 200, { ok: true, announcement: entry });
  }

  if (req.method === "DELETE" && p === "/api/admin/announcements") {
    const id = String(body.id || "").trim();
    if (!id) return send(res, 400, { ok: false, error: "BAD_INPUT" });
    let list = (await store.getSetting("announcements")) || [];
    if (!Array.isArray(list)) list = [];
    list = list.filter((a) => String(a.id || "") !== id);
    await store.saveSetting("announcements", list);
    return send(res, 200, { ok: true });
  }

  if (req.method === "GET" && p === "/api/admin/announcements") {
    const list = (await store.getSetting("announcements")) || [];
    return send(res, 200, { ok: true, announcements: Array.isArray(list) ? list : [] });
  }

  // ---------- Update ausloesen (Mod / Launcher / Changelog) ----------
  // Schreibt version.json (Mod- und Launcher-Version) und optionale
  // Changelog-Aenderungen. Danach sieht jeder Launcher das Update.
  if (req.method === "POST" && p === "/api/admin/update") {
    const v = readVersion();
    const before = { mod: String(v.mod || ""), launcher: String(v.launcher || "") };
    let changed = false;
    if (body.mod !== undefined) {
      const mv = String(body.mod || "").trim();
      if (mv && !/^\d+(?:\.\d+){1,3}$/.test(mv)) return send(res, 400, { ok: false, error: "BAD_INPUT" });
      v.mod = mv;
      changed = true;
    }
    if (body.launcher !== undefined) {
      const lv = String(body.launcher || "").trim();
      if (lv && !/^\d+(?:\.\d+){1,3}$/.test(lv)) return send(res, 400, { ok: false, error: "BAD_INPUT" });
      v.launcher = lv;
      changed = true;
    }
    // Direkter Server-Download statt GitHub-Redirect.
    if (v.launcher) v.launcherUrl = "/api/download/launcher";
    if (changed) {
      fs.writeFileSync(path.join(__dirname, "version.json"),
        JSON.stringify(v, null, 2) + "\n", "utf8");
    }
    return send(res, 200, { ok: true, version: { mod: String(v.mod || ""), launcher: String(v.launcher || "") }, before });
  }

  return send(res, 404, { ok: false, error: "NOT_FOUND" });
}

http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    try { send(res, 500, { ok: false, error: "SERVER_ERROR" }); } catch (e2) {}
  });
}).listen(PORT, () => {
  console.log("ApfelClient license server on port " + PORT + " (db: " + (USE_SB ? "supabase" : "json") + ")");
  loadGiveawayOnce().then((g) => {
    if (g && g.status === "active") {
      console.log("Giveaway restored: " + g.type + ", " + (g.joined || []).length + " joined, restarts: " + giveawayRestarts);
      maybeFinalizeGiveaway().catch(() => {});
    } else if (g) {
      console.log("Giveaway (ended) restored, winners: " + ((g.winners || []).join(", ") || "-"));
    }
  }).catch(() => {});
});
