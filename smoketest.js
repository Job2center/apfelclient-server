"use strict";
// Smoke-Test fuer die neuen Server-Routen (lokaler JSON-Modus).
const BASE = "http://127.0.0.1:3999";

async function j(path, opts) {
  const res = await fetch(BASE + path, {
    method: (opts && opts.method) || "GET",
    headers: Object.assign(
      { "Content-Type": "application/json" },
      opts && opts.token ? { Authorization: "Bearer " + opts.token } : {}
    ),
    body: opts && opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  return { status: res.status, data };
}

function ok(name, cond, extra) {
  console.log((cond ? "PASS  " : "FAIL  ") + name + (extra ? "  [" + extra + "]" : ""));
  if (!cond) process.exitCode = 1;
}

(async () => {
  const v = await j("/api/version");
  ok("GET /api/version", v.data && v.data.ok, "mod=" + (v.data && v.data.mod));

  const cl = await j("/api/changelog");
  ok("GET /api/changelog (ohne Login)", cl.data && cl.data.ok && Array.isArray(cl.data.entries),
    "entries=" + (cl.data && cl.data.entries && cl.data.entries.length));

  const su = await j("/api/setup", { method: "POST", body: { username: "owner", password: "test1234" } });
  ok("POST /api/setup", su.data && su.data.ok);
  const token = su.data.token;

  const me = await j("/api/me", { token });
  ok("GET /api/me", me.data && me.data.ok);

  const test = await j("/api/admin/giveaway/test", { method: "POST", token, body: { durationMin: 3 } });
  ok("POST /api/admin/giveaway/test", test.data && test.data.ok && test.data.giveaway && test.data.giveaway.test,
    "test=" + (test.data.giveaway && test.data.giveaway.test));

  const gw1 = await j("/api/giveaway", { token });
  ok("GET /api/giveaway nach Test-Start", gw1.data.giveaway && gw1.data.giveaway.status === "active");

  const join = await j("/api/giveaway/join", { method: "POST", token });
  ok("POST /api/giveaway/join", join.data.giveaway && join.data.giveaway.joinedCount === 1);

  const diag = await j("/api/admin/giveaway/diag", { token });
  ok("GET /api/admin/giveaway/diag", diag.data && diag.data.diag && diag.data.diag.hasState,
    "storage=" + (diag.data.diag && diag.data.diag.storage) + " restarts=" + (diag.data.diag && diag.data.diag.restarts));

  const end = await j("/api/admin/giveaway/end", { method: "POST", token });
  ok("POST /api/admin/giveaway/end", end.data.giveaway && end.data.giveaway.status === "ended",
    "winners=" + JSON.stringify(end.data.giveaway && end.data.giveaway.winners));

  const ack = await j("/api/changelog/ack", { method: "POST", token, body: { version: "1.6.16" } });
  ok("POST /api/changelog/ack", ack.data && ack.data.ok, "seen=" + (ack.data && ack.data.seen));
  const cl2 = await j("/api/changelog", { token });
  ok("Changelog merkt sich 'gesehen'", cl2.data && cl2.data.seen === "1.6.16" && cl2.data.unseen === false);

  const tel = await j("/api/telemetry", { method: "POST", body: { kind: "crash", mod: "1.6.16", error: "InjectionError" } });
  ok("POST /api/telemetry (ohne Login)", tel.data && tel.data.ok);
  const tels = await j("/api/admin/telemetry", { token });
  ok("GET /api/admin/telemetry", tels.data && tels.data.events && tels.data.events.length > 0);

  const res = await fetch(BASE + "/api/download/mod", { headers: { Authorization: "Bearer " + token } });
  const sha1 = res.headers.get("x-mod-sha1");
  const ver = res.headers.get("x-mod-version");
  const etag = res.headers.get("etag");
  const buf = Buffer.from(await res.arrayBuffer());
  const crypto = require("node:crypto");
  const real = crypto.createHash("sha1").update(buf).digest("hex");
  ok("GET /api/download/mod mit Hash-Headern", !!sha1 && !!etag && !!ver,
    "ver=" + ver + " sha1=" + (sha1 || "").slice(0, 12) + " bytes=" + buf.length);
  ok("SHA1 im Header stimmt mit der Datei", sha1 === real, real.slice(0, 12));

  const res2 = await fetch(BASE + "/api/download/mod", { headers: { Authorization: "Bearer " + token, "If-None-Match": etag } });
  ok("If-None-Match -> 304", res2.status === 304, "status=" + res2.status);

  const res3 = await fetch(BASE + "/api/download/mod", { headers: { Authorization: "Bearer " + token, Range: "bytes=0-99" } });
  const part = Buffer.from(await res3.arrayBuffer());
  ok("Range-Request -> 206 + 100 Bytes", res3.status === 206 && part.length === 100, "status=" + res3.status);

  const noAuth = await j("/api/admin/telemetry");
  ok("Admin-Telemetrie ohne Login gesperrt", noAuth.status === 401);
})().catch((e) => { console.error("TESTFEHLER:", e.message); process.exitCode = 1; });