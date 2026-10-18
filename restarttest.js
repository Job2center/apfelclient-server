"use strict";
// Beweis-Test: Giveaway muss einen Server-Neustart ueberleben.
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
  try { data = await res.json(); } catch (e) {}
  return { status: res.status, data };
}

const token = process.argv[2];
const phase = process.argv[3] || "before";

(async () => {
  if (phase === "before") {
    const g = await j("/api/admin/giveaway/test", { method: "POST", token, body: { durationMin: 30 } });
    const gw = g.data.giveaway;
    console.log("gestartet: status=" + gw.status + " joined=" + gw.joinedCount + " endetIn=" + Math.round(gw.endsIn / 1000) + "s");
    const jn = await j("/api/giveaway/join", { method: "POST", token });
    console.log("gejoint: joined=" + jn.data.giveaway.joinedCount);
    return;
  }
  const g = await j("/api/giveaway", { token });
  const d = await j("/api/admin/giveaway/diag", { token });
  const gw = g.data.giveaway;
  console.log("nach Neustart: status=" + (gw && gw.status) + " joined=" + (gw && gw.joinedCount)
    + " restarts=" + (d.data.diag && d.data.diag.restarts)
    + " geladen=" + (d.data.diag && d.data.diag.loaded));
  if (!gw || gw.status !== "active" || gw.joinedCount !== 1) {
    console.log("FEHLER: Giveaway ging beim Neustart verloren");
    process.exitCode = 1;
  } else {
    console.log("OK: Giveaway inkl. Teilnehmer ueberlebt den Neustart");
  }
})().catch((e) => { console.error("TESTFEHLER:", e.message); process.exitCode = 1; });