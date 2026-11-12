/**
 * Naschii's Adventure Map – Taktgeber für die automatische Aktualisierung
 *
 * 1) Stößt alle 15 Minuten den GitHub-Workflow "Streams und Clips aktualisieren" an.
 * 2) Nimmt gezeichnete Routen, Entwürfe, den Update-Knopf und „Seite offline/online“ der Webseite entgegen (doPost), prüft Twitch-Login und
 *    Bearbeitungsrecht (naschiitaschii, EDITORS, Mods des Kanals) und stößt "Route speichern" an.
 *
 * Einrichtung Taktgeber (einmalig):
 *   1. Projekteinstellungen (Zahnrad) → Skripteigenschaften → Eigenschaft hinzufügen:
 *        GITHUB_TOKEN = dein Fine-grained Token (Actions: Read and write, nur dieses Repo)
 *   2. Oben die Funktion "einrichten" auswählen → Ausführen → Zugriff erlauben
 *   3. Im Protokoll muss stehen: "Antwort von GitHub: 204 (OK)"
 *
 * Einrichtung Routen-Speichern (einmalig):
 *   Bereitstellen → Neue Bereitstellung → Typ "Web-App"
 *     Ausführen als: Ich · Zugriff: Jeder → Bereitstellen → Web-App-URL kopieren
 *   Nach jeder Code-Änderung: Bereitstellen → Bereitstellungen verwalten → Bearbeiten (Stift) → Version "Neue Version".
 *
 * Einrichtung Entwürfe (einmalig):
 *   Oben die Funktion "entwuerfeEinrichten" auswählen → Ausführen → Zugriff auf Google Drive erlauben.
 *   Im Protokoll steht dann der Link zum Ordner "Adventure Map – Entwürfe (privat)". Danach wie oben eine neue Version bereitstellen.
 */

const REPO = 'naschiis-adventure-map/naschiis-adventure-map.github.io';
const WORKFLOW = 'update.yml';
const SAVE_WORKFLOW = 'save-route.yml';
const CHANNEL = 'naschiitaschii';
const TWITCH_CLIENT_ID = '37d0tdpcaxwlyeyojbsh1pwwynr58w';   // öffentlich
const EDITORS = ['naschiitaschii', 'wlankabelvergessen'];    // dürfen immer; Mods von CHANNEL zusätzlich

/** Wird alle 15 Minuten automatisch ausgeführt. */
function anstossen() {
  const token = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');
  if (!token) throw new Error('Skripteigenschaft GITHUB_TOKEN fehlt (Projekteinstellungen → Skripteigenschaften).');
  const res = UrlFetchApp.fetch(`https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`, {
    method: 'post',
    contentType: 'application/json',
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    payload: JSON.stringify({ ref: 'main' }),
    muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  console.log('Antwort von GitHub: ' + code + (code === 204 ? ' (OK)' : ' – ' + res.getContentText()));
  if (code !== 204) throw new Error('GitHub hat den Lauf abgelehnt (' + code + '). Token prüfen: Ablaufdatum, Repo, Recht "Actions: Read and write".');
}

/** Einmal von Hand ausführen: legt den 15-Minuten-Zeitplan an und testet sofort. */
function einrichten() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'anstossen')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('anstossen').timeBased().everyMinutes(15).create();
  console.log('Zeitplan angelegt: alle 15 Minuten.');
  anstossen();
}

/** Falls du den Taktgeber einmal stoppen willst. */
function stoppen() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  console.log('Zeitplan entfernt.');
}

/* ---------------- Routen speichern ---------------- */

function antwort(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/** Webseite schickt { token, id, route }. Antwort: { ok, at } oder { ok:false, error, code }. */
function doPost(e) {
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const token = String(body.token || '');
    if (!token) return antwort({ ok: false, code: 'token', error: 'Nicht angemeldet.' });

    // 1. Twitch-Token prüfen: gültig und für unsere App ausgestellt?
    const v = UrlFetchApp.fetch('https://id.twitch.tv/oauth2/validate', { headers: { Authorization: 'OAuth ' + token }, muteHttpExceptions: true });
    if (v.getResponseCode() !== 200) return antwort({ ok: false, code: 'token', error: 'Twitch-Anmeldung abgelaufen.' });
    const who = JSON.parse(v.getContentText());
    if (who.client_id !== TWITCH_CLIENT_ID) return antwort({ ok: false, code: 'token', error: 'Fremder Twitch-Token.' });
    const login = String(who.login || '').toLowerCase();

    // 2. Darf diese Person bearbeiten?
    if (!(login === CHANNEL || EDITORS.indexOf(login) >= 0 || istMod(who.user_id, token))) {
      return antwort({ ok: false, code: 'forbidden', error: 'Nur Kanalbetreiber, Mods und Berechtigte dürfen das.' });
    }

    // 2b. Update-Knopf auf der Seite: Aktualisierung von Hand anstoßen (höchstens alle 2 Minuten)
    if (body.action === 'update') {
      const cache = CacheService.getScriptCache();
      if (cache.get('manual-update')) return antwort({ ok: false, code: 'wait', error: 'Gerade erst angestoßen. Bitte 2 Minuten warten.' });
      const ghTok = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');
      const r = UrlFetchApp.fetch(`https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`, {
        method: 'post', contentType: 'application/json', muteHttpExceptions: true,
        headers: { Authorization: 'Bearer ' + ghTok, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
        payload: JSON.stringify({ ref: 'main' }),
      });
      if (r.getResponseCode() !== 204) {
        console.log('GitHub (Update-Knopf): ' + r.getResponseCode() + ' ' + r.getContentText());
        return antwort({ ok: false, code: 'github', error: 'GitHub hat das Update abgelehnt (' + r.getResponseCode() + '). Vermutlich ist der GitHub-Token abgelaufen.' });
      }
      cache.put('manual-update', login, 120);
      console.log('Update von Hand angestoßen von ' + login);
      return antwort({ ok: true, at: new Date().toISOString(), by: login });
    }

    // 2c. Seite offline nehmen / wieder online stellen (Wartungsanzeige für Besucher)
    if (body.action === 'site') {
      const off = body.offline === true;
      const cache = CacheService.getScriptCache();
      if (cache.get('site-switch')) return antwort({ ok: false, code: 'wait', error: 'Gerade erst umgeschaltet. Bitte 30 Sekunden warten.' });
      const ghT = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');
      const rs = UrlFetchApp.fetch(`https://api.github.com/repos/${REPO}/actions/workflows/${SAVE_WORKFLOW}/dispatches`, {
        method: 'post', contentType: 'application/json', muteHttpExceptions: true,
        headers: { Authorization: 'Bearer ' + ghT, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
        payload: JSON.stringify({ ref: 'main', inputs: { payload: JSON.stringify({ site: { offline: off } }) } }),
      });
      if (rs.getResponseCode() !== 204) {
        console.log('GitHub (Seitenstatus): ' + rs.getResponseCode() + ' ' + rs.getContentText());
        return antwort({ ok: false, code: 'github', error: 'GitHub hat das Umschalten abgelehnt (' + rs.getResponseCode() + ').' });
      }
      cache.put('site-switch', login, 30);
      console.log('Seite ' + (off ? 'OFFLINE' : 'ONLINE') + ' gestellt von ' + login);
      return antwort({ ok: true, at: new Date().toISOString(), by: login, offline: off });
    }

    // 2d. Entwürfe: bis zu 10 Routen-Varianten pro Stream, privat in deinem Google Drive (nicht öffentlich)
    if (body.action === 'drafts' || body.action === 'draft-save' || body.action === 'draft-del' || body.action === 'draft-backup') {
      const sid = String(body.id || '');
      if (!/^[\w-]{1,80}$/.test(sid)) return antwort({ ok: false, error: 'Ungültiger Stream.' });
      const lock = LockService.getScriptLock();
      lock.waitLock(15000);
      try {
        let list = entwuerfeLesen(sid);
        // Automatische Sicherung: bisherige öffentliche Route vor dem Überschreiben (eine pro Stream, zählt nicht zu den 10)
        if (body.action === 'draft-backup') {
          const route = body.route;
          if (!route || typeof route !== 'object') return antwort({ ok: false, error: 'Keine Route zum Sichern.' });
          if (JSON.stringify(route).length > 60000) return antwort({ ok: false, error: 'Route zu groß für die Sicherung.' });
          const tag = Utilities.formatDate(new Date(), 'Europe/Berlin', 'dd.MM., HH:mm');
          list = list.filter(x => !x.backup);
          list.push({ did: 'backup', backup: true, name: 'Vorherige Route (ersetzt am ' + tag + ')', by: login, at: new Date().toISOString(), route: route });
          entwuerfeSchreiben(sid, list);
          console.log('Sicherung ' + sid + ' angelegt von ' + login);
          return antwort({ ok: true, drafts: list });
        }
        if (body.action === 'draft-save') {
          const d = body.draft || {};
          const route = d.route;
          if (!route || typeof route !== 'object') return antwort({ ok: false, error: 'Entwurf ist leer.' });
          const size = JSON.stringify(route).length;
          if (size > 60000) return antwort({ ok: false, error: 'Entwurf zu groß. Bitte gröber zeichnen.' });
          const name = String(d.name || 'Entwurf').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 60) || 'Entwurf';
          const did = String(d.did || '');
          const vorhanden = did && list.find(x => x.did === did);
          if (vorhanden) {
            vorhanden.name = name; vorhanden.route = route; vorhanden.by = login; vorhanden.at = new Date().toISOString();
          } else {
            if (list.filter(x => !x.backup).length >= 10) return antwort({ ok: false, code: 'full', error: 'Höchstens 10 Entwürfe pro Stream.' });
            list.push({ did: Utilities.getUuid().slice(0, 8), name: name, by: login, at: new Date().toISOString(), route: route });
          }
          entwuerfeSchreiben(sid, list);
          const neu = vorhanden || list[list.length - 1];
          console.log('Entwurf ' + sid + '/' + neu.did + ' gespeichert von ' + login);
          return antwort({ ok: true, did: neu.did, drafts: list });
        }
        if (body.action === 'draft-del') {
          const did = String(body.did || '');
          list = list.filter(x => x.did !== did);
          entwuerfeSchreiben(sid, list);
          console.log('Entwurf ' + sid + '/' + did + ' gelöscht von ' + login);
          return antwort({ ok: true, drafts: list });
        }
        return antwort({ ok: true, drafts: list });
      } finally {
        lock.releaseLock();
      }
    }

    // 3. Grobe Prüfung der Daten (die genaue Prüfung macht scripts/save-route.mjs)
    const id = String(body.id || '');
    if (!/^[\w-]{1,80}$/.test(id)) return antwort({ ok: false, error: 'Ungültiger Stream.' });
    const route = body.route === null ? null : body.route;
    const payload = JSON.stringify({ id: id, route: route });   // Bearbeiter wird nicht veröffentlicht
    if (payload.length > 60000) return antwort({ ok: false, error: 'Route zu groß. Bitte gröber zeichnen.' });

    // 4. GitHub-Workflow "Route speichern" anstoßen
    const ghToken = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');
    const res = UrlFetchApp.fetch(`https://api.github.com/repos/${REPO}/actions/workflows/${SAVE_WORKFLOW}/dispatches`, {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      headers: { Authorization: 'Bearer ' + ghToken, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      payload: JSON.stringify({ ref: 'main', inputs: { payload: payload } }),
    });
    if (res.getResponseCode() !== 204) {
      console.log('GitHub: ' + res.getResponseCode() + ' ' + res.getContentText());
      return antwort({ ok: false, error: 'GitHub hat das Speichern abgelehnt (' + res.getResponseCode() + ').' });
    }
    console.log('Route ' + id + ' gespeichert von ' + login);
    return antwort({ ok: true, at: new Date().toISOString(), by: login });
  } catch (err) {
    console.log(err);
    return antwort({ ok: false, error: 'Interner Fehler: ' + err });
  }
}

/** Ist user_id Moderator bei CHANNEL? (Token braucht den Scope user:read:moderated_channels) */
function istMod(userId, token) {
  let cursor = '';
  for (let i = 0; i < 10; i++) {
    const res = UrlFetchApp.fetch('https://api.twitch.tv/helix/moderation/channels?first=100&user_id=' + encodeURIComponent(userId) + (cursor ? '&after=' + encodeURIComponent(cursor) : ''), {
      headers: { Authorization: 'Bearer ' + token, 'Client-Id': TWITCH_CLIENT_ID }, muteHttpExceptions: true,
    });
    if (res.getResponseCode() !== 200) return false;
    const j = JSON.parse(res.getContentText());
    if ((j.data || []).some(c => String(c.broadcaster_login).toLowerCase() === CHANNEL)) return true;
    cursor = j.pagination && j.pagination.cursor;
    if (!cursor) return false;
  }
  return false;
}

/* ---------------- Entwürfe (privat in Google Drive) ---------------- */

/** Ordner "Adventure Map – Entwürfe (privat)" in deinem Google Drive (wird beim ersten Mal angelegt). */
function entwurfOrdner() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('DRAFT_FOLDER');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) {} }
  const f = DriveApp.createFolder('Adventure Map – Entwürfe (privat)');
  props.setProperty('DRAFT_FOLDER', f.getId());
  return f;
}
function entwuerfeLesen(streamId) {
  const it = entwurfOrdner().getFilesByName('entwuerfe-' + streamId + '.json');
  if (!it.hasNext()) return [];
  try { const l = JSON.parse(it.next().getBlob().getDataAsString()); return Array.isArray(l) ? l : []; } catch (e) { return []; }
}
function entwuerfeSchreiben(streamId, list) {
  const name = 'entwuerfe-' + streamId + '.json', ordner = entwurfOrdner(), it = ordner.getFilesByName(name);
  const inhalt = JSON.stringify(list);
  if (it.hasNext()) { const f = it.next(); if (list.length) f.setContent(inhalt); else f.setTrashed(true); }
  else if (list.length) ordner.createFile(name, inhalt, MimeType.PLAIN_TEXT);
}
/** Einmal von Hand ausführen (Zugriff auf Google Drive erlauben): legt den Entwürfe-Ordner an. */
function entwuerfeEinrichten() {
  const f = entwurfOrdner();
  console.log('Entwürfe-Ordner bereit: ' + f.getName() + ' (' + f.getUrl() + ')');
}

/**
 * Einmal von Hand ausführen: übernimmt automatisch erstellte Routen-Vorlagen als Entwürfe.
 * Vorher die Datei "vorlagen-import.json" in den Ordner "Adventure Map – Entwürfe (privat)" hochladen.
 * Jede Vorlage landet als Entwurf "Automatische Vorlage (grob)" beim jeweiligen Stream – nichts wird veröffentlicht.
 * Ein erneuter Import ersetzt nur die alte automatische Vorlage, eigene Entwürfe bleiben unangetastet.
 */
function vorlagenImportieren() {
  const ordner = entwurfOrdner();
  const it = ordner.getFilesByName('vorlagen-import.json');
  if (!it.hasNext()) throw new Error('Datei "vorlagen-import.json" nicht im Entwürfe-Ordner gefunden.');
  const datei = it.next();
  const alle = JSON.parse(datei.getBlob().getDataAsString());
  const NAME = 'Automatische Vorlage (grob)';
  let n = 0;
  Object.keys(alle).forEach(function (sid) {
    if (!/^[\w-]{1,80}$/.test(sid) || !alle[sid] || typeof alle[sid] !== 'object') return;
    const list = entwuerfeLesen(sid).filter(function (x) { return x.name !== NAME; });
    if (list.filter(function (x) { return !x.backup; }).length >= 10) { console.log('Übersprungen (schon 10 Entwürfe): ' + sid); return; }
    list.push({ did: Utilities.getUuid().slice(0, 8), name: NAME, by: 'automatisch', at: new Date().toISOString(), route: alle[sid] });
    entwuerfeSchreiben(sid, list);
    n++;
  });
  datei.setTrashed(true);
  console.log(n + ' Vorlagen als Entwürfe gespeichert. Die Import-Datei liegt jetzt im Papierkorb.');
}

/** Zum Testen im Editor: zeigt, dass die Web-App erreichbar ist. */
function doGet() {
  return antwort({ ok: true, info: 'Adventure Map Speicher-Dienst läuft.' });
}
