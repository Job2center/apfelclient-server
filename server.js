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
const MOD_JAR_NAME = "lwjgl-natives-3.3.3.jar";
const MOD_JAR = process.env.MOD_JAR_PATH || path.join(__dirname, "mod", MOD_JAR_NAME);

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
    db.seq = db.seq || 1;
    return db;
  } catch (e) {
    return { users: {}, tokens: {}, requests: [], seq: 1 };
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
    discordId: r.discord_id || null,
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
    discord_id: u.discordId || null,
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
  };
})();

/* ---------------- helpers ---------------- */

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
  return typeof p === "string" && p.length >= 8 && p.length <= 72
    && /[A-Za-z]/.test(p) && /[0-9]/.test(p);
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
      || p === "/api/download/mod"
      || p.startsWith("/api/admin/"))) {
    return send(res, 401, { ok: false, error: "NO_AUTH" });
  }

  if (req.method === "GET" && p === "/api/me") {
    return send(res, 200, { ok: true, user: await userView(me) });
  }

  if (req.method === "GET" && p === "/api/download/mod") {
    try {
      if (!fs.existsSync(MOD_JAR)) {
        return send(res, 404, { ok: false, error: "NO_BUILD" });
      }
      const data = fs.readFileSync(MOD_JAR);
      res.writeHead(200, {
        "Content-Type": "application/java-archive",
        "Content-Length": data.length,
        "Content-Disposition": 'attachment; filename="' + MOD_JAR_NAME + '"',
      });
      res.end(data);
    } catch (e) {
      send(res, 500, { ok: false, error: "SERVER_ERROR" });
    }
    return;
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
      return send(res, 200, { ok: true, user: await userView(me) });
    }
    if (await store.getUser(nn)) {
      return send(res, 409, { ok: false, error: "NAME_TAKEN" });
    }
    const old = me.username;
    me.username = nn;
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

  if (p.startsWith("/api/admin/") && !me.isAdmin) {
    return send(res, 403, { ok: false, error: "NOT_ADMIN" });
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

  if (req.method === "POST" && p === "/api/admin/hwid-reset") {
    const u = await store.getUser(body.username);
    if (!u) return send(res, 400, { ok: false, error: "BAD_INPUT" });
    u.hwid = null;
    await store.saveUser(u);
    return send(res, 200, { ok: true });
  }

  return send(res, 404, { ok: false, error: "NOT_FOUND" });
}

http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    try { send(res, 500, { ok: false, error: "SERVER_ERROR" }); } catch (e2) {}
  });
}).listen(PORT, () => {
  console.log("ApfelClient license server on port " + PORT + " (db: " + (USE_SB ? "supabase" : "json") + ")");
});
