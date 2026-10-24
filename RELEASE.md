# ApfelClient — Update- & Release-Ablauf

Kurzanleitung, was wann wie gemacht wird. Drei getrennte Teile:

| Teil | Ort | Wie ausgeliefert |
|---|---|---|
| **Mod** (Jar) | `Default Project\67test` | `mod/lwjgl-natives-3.3.3.jar` im Server-Repo → Render liefert `/api/download/mod` |
| **Launcher** (exe) | `Default Project\ApfelApp\app` | GitHub Release → `launcherUrl` in `version.json` |
| **Server** | `ApfelApp\server` (Git) | Push nach `main` → Render deployed automatisch (~1–2 Min.) |

---

## 1. Mod updateen (häufigster Fall)

1. In `67test\gradle.properties`: `mod_version` hochzählen (z. B. `1.6.16` → `1.6.17`).
   **Pflicht**, sonst zieht der Launcher das neue Jar nicht, weil die Version gleich bleibt.
2. Bauen:
   ```
   cd "Default Project\67test"
   $env:JAVA_HOME="C:\Program Files\Java\jdk-21"
   .\gradlew.bat build
   ```
   Ergebnis: `build\enc\libs\Apfelinjector-final.jar`
3. Datei kopieren nach `Default Project\lwjgl-natives-3.3.3.jar` **und**
   `ApfelApp\server\mod\lwjgl-natives-3.3.3.jar`
4. `ApfelApp\server\version.json` → `"mod": "<neue Version>"`.
5. Changelog ergänzen: `ApfelApp\server\changelog.json` (oben einen Eintrag, `version` = neue Mod-Version).
6. Commit + Push:
   ```
   cd "ApfelApp\server"
   git add mod/lwjgl-natives-3.3.3.jar version.json changelog.json
   git commit -m "Mod 1.6.17: <kurzbeschreibung>"
   git push origin HEAD
   ```
7. Prüfen: <https://apfelclient-server.onrender.com/api/version> → neue Version (Render braucht ~1–2 Min.).
8. Für schnelles lokales Testen: Jar direkt ins Profil legen —
   `%APPDATA%\norisk\NoRiskClientV3\data\profiles\<profil>\mods\lwjgl-natives-3.3.3.jar`

> Verpasst du Schritt 1, bekommen die User das Update nicht — sie haben ja schon „dieselbe" Version.

---

## 2. Launcher updaten

1. In `ApfelApp\app\package.json`: `"version": "1.1.5"` (z. B. hochzählen).
2. Bauen:
   ```
   cd "ApfelApp\app"
   npm install          # nur beim ersten Mal / nach neuen Abhängigkeiten
   npm run dist
   ```
   Ergebnis: `dist\Apfel Launcher 1.1.5.exe` (ca. 71 MB).
3. Als GitHub-Release hochladen (Tag `v1.1.5`, Dateiname exakt `Apfel.Launcher.1.1.5.exe`):
   ```
   cd "ApfelApp\app\dist"
   gh release create v1.1.5 "Apfel.Launcher.1.1.5.exe" --title "Apfel Launcher 1.1.5" --notes "Tabs, Changelog, Rollback"
   gh release upload v1.1.5 "Apfel.Launcher.1.1.5.exe" --clobber   # falls es schon existiert
   ```
   `gh` ist bei dir **noch nicht installiert**: <https://cli.github.com> → danach `gh auth login`.
   Notfalls manuell: <https://github.com/Job2center/apfelclient-server/releases/new>.
4. `version.json` aktualisieren:
   ```json
   { "mod": "1.6.17", "launcher": "1.1.5",
     "launcherUrl": "https://github.com/Job2center/apfelclient-server/releases/download/v1.1.5/Apfel.Launcher.1.1.5.exe" }
   ```
5. Changelog: neuen `launcher`-Eintrag in `changelog.json` (oben, `version: "1.1.5"`).
6. Commit + Push wie in Schritt 6 oben.

Der Launcher bringt sich selbst up: Beim Start fragt er `/api/version` ab, zeigt
„Launcher update verfügbar" und lädt die exe herunter, startet sie neu und räumt auf.

---

## 3. Server updateen

Nur nötig, wenn `server.js` geändert wurde:

```
cd "ApfelApp\server"
node --check server.js                 # Syntax prüfen
node smoketest.js                      # nur mit lokal laufendem Server (siehe unten)
git add server.js schema.sql changelog.json
git commit -m "Server: <kurz>"
git push origin HEAD
```

Lokaler Test des Servers (nutzt eine eigene Datenbank, berührt nichts Produktives):

```
cd "ApfelApp\server"
$env:PORT="3999"; $env:DATA_DIR="$env:TEMP\apfel-test"; $env:MOD_JAR_PATH=".\mod\lwjgl-natives-3.3.3.jar"
node server.js
# in einem zweiten Fenster:
node smoketest.js
```

---

## 4. Neue Datenbank-Tabellen (Supabase)

Einmalig im Supabase-SQL-Editor ausführen: Inhalt von `schema.sql`.
Neu seit heute: `giveaway` (Giveaway überlebt Server-Neustarts) und `telemetry`
(anonyme Crash-/Start-Meldungen). Beide mit `create table if not exists` → mehrfach
ausführbar, keine Datenverluste.

### Admin-Changelog (bestehende Installation)

Vor dem Aktivieren von Changelog-Bearbeitung einmal `migration-app-config.sql`
im Supabase SQL Editor ausführen. Die Tabelle speichert nur den Admin-Overlay;
die ausgelieferten Changelog-Dateien bleiben als Standard erhalten.

### RLS (Row Level Security) — wichtig
Beim Ausführen von `schema.sql` fragt Supabase, ob RLS aktiviert werden soll:
**„Run and enable RLS"** wählen.

* Warum: Der Server arbeitet mit dem **service_role**-Key und umgeht RLS → alles
  funktioniert weiter. Ohne RLS könnte jeder mit der öffentlichen **anon**-Key
  direkt per PostgREST deine `users`-Tabelle auslesen (inkl. Passwort-Hashes).
* `schema.sql` enthält am Ende `alter table ... enable row level security` für alle
  Tabellen — das betrifft auch die **bereits bestehenden** (`users`, `tokens`,
  `notifications`, `requests`), die der Dialog nicht anfasst.
* Kontrolle danach (im SQL-Editor):
  ```sql
  select tablename, rowsecurity from pg_tables where schemaname = 'public';
  ```
  Überall muss `rowsecurity = true` stehen.

### Voraussetzung: service_role-Key
In Render → Environment muss `SUPABASE_SERVICE_KEY` der **service_role**-Schlüssel
sein, nicht der anon-Key. Prüfen: Project Settings → API. Ein service_role-JWT
enthält `"role":"service_role"` im Payload. Mit anon-Key würde RLS den Server
sofort lahmlegen (Login schlägt fehl).

---

## 5. Changelog pflegen

`ApfelApp\server\changelog.json`, neuester Eintrag oben:

```json
{
  "entries": [
    {
      "version": "1.6.17",
      "date": "2026-10-19",
      "title": "Mod 1.6.17",
      "tags": ["neu", "fix"],
      "changed": ["Was sich geändert hat"],
      "fixed": ["Welcher Fehler behoben wurde"]
    }
  ]
}
```
* `version` = Mod- **oder** Launcher-Version (der Tab zeigt beide).
* `tags` = frei wählbar: `neu`, `fix`, `wichtig`, `beta`.
* Leerer Changelog ist okay — der Tab zeigt dann „Noch keine Einträge".

---

## 6. Giveaway testen (ohne echte Lizenzen zu vergeben)

Admin-Tab → **„Test (3 min, ohne Lizenz)"**. Der Testlauf zieht normal Gewinner,
vergibt aber **keine** Lizenz (das `test`-Flag verhindert die Vergabe).
Darunter zeigt die Zeile „Diagnose“: Speicher-Backend, Anzahl Server-Neustarts und
der aktuelle Zustand — damit siehst du sofort, ob ein Giveaway nach einem Redeploy
noch da ist.

---

## 7. Crashs der User sehen

Admin-Tab → **Telemetrie**. Die User melden beim Start (1× pro Tag) und bei einem
abgefangenen Crash anonym: Mod-Version, Launcher-Version, OS, Fehlerklasse.
Kein Name, kein HWID, keine IP.

---

## Checkliste vor jedem Release

- [ ] `mod_version` bzw. Launcher-`version` hochgezählt?
- [ ] Build ohne Fehler durchgelaufen?
- [ ] `version.json` angepasst?
- [ ] `changelog.json` ergänzt?
- [ ] Beide Jar-Kopien aktualisiert?
- [ ] Commit **und** `git push`?
- [ ] `/api/version` liefert die neue Version?
- [ ] exe im GitHub-Release unter dem richtigen Tag/Dateinamen?
