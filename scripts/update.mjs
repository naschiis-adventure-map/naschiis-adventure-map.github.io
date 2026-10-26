// Holt neue Streams (VODs) und Clips von Twitch und pflegt sie in data/streams.json ein.
// Läuft per GitHub Actions. Braucht TWITCH_CLIENT_ID und TWITCH_CLIENT_SECRET als Umgebungsvariablen.
// Node 20+, keine Abhängigkeiten.
import { readFile, writeFile } from 'node:fs/promises';

const LOGIN = process.env.TWITCH_LOGIN || 'naschiitaschii';
const CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;
const CLIP_DAYS = Number(process.env.CLIP_DAYS || 30);   // wie weit zurück Clips geprüft werden
const MIN_DATE = '2025-01-01';                           // ältere Streams werden weder angezeigt noch hinzugefügt
const MATCH_MIN = 25;                                     // Toleranz beim Abgleich von Startzeiten
const TZ = 'Europe/Berlin';
const DATA = new URL('../data/streams.json', import.meta.url);
const LOCS = new URL('../data/locations.json', import.meta.url);
const META = new URL('../data/meta.json', import.meta.url);

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('TWITCH_CLIENT_ID und TWITCH_CLIENT_SECRET fehlen (GitHub: Settings → Secrets and variables → Actions).');
  process.exit(1);
}

// ---------- Twitch API ----------
async function token() {
  const r = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: 'client_credentials' }),
  });
  if (!r.ok) throw new Error('Token-Abruf fehlgeschlagen: ' + r.status + ' ' + (await r.text()));
  return (await r.json()).access_token;
}
let TOKEN;
async function helix(path, params = {}) {
  const out = [];
  let cursor;
  for (let page = 0; page < 50; page++) {
    const q = new URLSearchParams(params); // akzeptiert Objekt oder URLSearchParams
    if (cursor) q.set('after', cursor);
    const r = await fetch('https://api.twitch.tv/helix/' + path + '?' + q, {
      headers: { 'Client-Id': CLIENT_ID, Authorization: 'Bearer ' + TOKEN },
    });
    if (r.status === 429) { await new Promise(s => setTimeout(s, 2000)); page--; continue; }
    if (!r.ok) throw new Error(path + ': ' + r.status + ' ' + (await r.text()));
    const j = await r.json();
    out.push(...(j.data || []));
    cursor = j.pagination && j.pagination.cursor;
    if (!cursor || !(j.data || []).length) break;
  }
  return out;
}

// ---------- Helfer ----------
const pad = n => String(n).padStart(2, '0');
function berlin(date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour === '24' ? '00' : p.hour}:${p.minute}` };
}
// "Europe/Berlin"-Ortszeit -> UTC-Zeitpunkt (über Offset-Schätzung, auf Minuten genau)
function fromBerlin(date, time) {
  const guess = new Date(`${date}T${time}:00Z`);
  for (let i = 0; i < 2; i++) {
    const b = berlin(guess);
    const diff = (new Date(`${b.date}T${b.time}:00Z`) - new Date(`${date}T${time}:00Z`));
    guess.setTime(guess.getTime() - diff);
  }
  return guess;
}
function durationSec(s) { // "3h12m5s" -> Sekunden
  const m = /(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/.exec(s || '') || [];
  return (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0);
}
function durationMin(s) { // "3h12m5s"
  const m = /(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/.exec(s || '') || [];
  return Math.max(1, Math.round((+(m[1] || 0)) * 60 + (+(m[2] || 0)) + (+(m[3] || 0)) / 60));
}
function cleanTitle(t) {
  return String(t || '')
    .replace(/\s*[|│┃]?\s*!(subtember|subathon|rad|dc|insta|tt|yt|ig|clip)\b.*$/i, '')
    .replace(/\s*\|\s*10 SUBS.*$/i, '')
    .replace(/[\s|┃│]+$/, '')
    .trim();
}

// ---------- Ablauf ----------
const streams = JSON.parse(await readFile(DATA, 'utf8'));
// Nur Streams ab MIN_DATE, ohne Zuschauer- und Followerzahlen (werden nicht mehr erfasst)
const VIEWER_FIELDS = ['viewerSamples', 'avgViewers', 'maxViewers', 'followersStart', 'followers'];
function prune() {
  for (let i = streams.length - 1; i >= 0; i--) if (!streams[i].date || streams[i].date < MIN_DATE) streams.splice(i, 1);
  for (const r of streams) for (const k of VIEWER_FIELDS) delete r[k];
}
prune();
const locs = JSON.parse(await readFile(LOCS, 'utf8'));
// Ortsnamen im Titel erkennen. Standard: ganzes Wort (auch "Kölner", "Berlins"),
// Einträge mit "prefix": true auch als Wortanfang (z. B. "dokom" für "DoKomi"/"Dokoomiii").
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const matchers = locs.map(l => ({ l, re: new RegExp('(^|[^\\p{L}])' + esc(l.key) + (l.prefix ? '' : '(er|s|n)?(?![\\p{L}])'), 'iu') }));
function locate(title) {
  const m = matchers.find(x => x.re.test(title));
  return m ? { name: m.l.name, lat: m.l.lat, lng: m.l.lng, approx: true } : undefined;
}
const startOf = r => fromBerlin(r.date, r.start || '00:00');

TOKEN = await token();
const [user] = await helix('users', { login: LOGIN });
if (!user) throw new Error('Kanal nicht gefunden: ' + LOGIN);

// 0) Laufenden Stream erfassen (die Action läuft alle 15 Minuten).
//    So landet jeder Stream in der Liste – auch wenn Twitch kein öffentliches VOD anbietet.
let added = 0, updated = 0, liveNote = 'offline';
const [live] = await helix('streams', { user_id: user.id, type: 'live' });
if (live) {
  const start = new Date(live.started_at);
  const nowMin = Math.max(1, Math.round((Date.now() - start) / 60000));
  let r = streams.find(x => x.streamId === live.id)
       || streams.find(x => !x.streamId && Math.abs(startOf(x) - start) <= MATCH_MIN * 60000);
  if (!r) {
    const b = berlin(start);
    r = { id: `ls-${live.id}`, source: 'live', title: '', date: b.date, start: b.time, durationMin: nowMin, desc: '', points: [], stops: [], clips: [] };
    streams.push(r); added++;
  }
  r.streamId = live.id;
  if (r.source !== 'twitchtracker') {
    r.title = cleanTitle(live.title);
  }
  r.durationMin = Math.max(r.durationMin || 0, nowMin);
  if (live.game_name) r.game = live.game_name;
  r.live = true;
  liveNote = `LIVE seit ${nowMin} Min. · ${live.game_name || ''}`;
}
for (const r of streams) if (r.live && (!live || r.streamId !== live.id)) delete r.live;

// 1) Streams aus den VODs (Twitch hält sie je nach Status 7–60 Tage vor)
const videos = await helix('videos', { user_id: user.id, type: 'archive', first: '100' });
for (const v of videos) {
  const start = new Date(v.created_at);
  const dur = durationMin(v.duration);
  const title = cleanTitle(v.title);
  let r = streams.find(x => x.vodId === v.id)
       || streams.find(x => !x.vodId && Math.abs(startOf(x) - start) <= MATCH_MIN * 60000);
  if (r) {
    const before = JSON.stringify([r.vodId, r.durationMin, r.title]);
    r.vodId = v.id;
    // Dauer wächst, solange ein Stream noch läuft; nie kürzen, was TwitchTracker schon hatte
    if (r.source !== 'twitchtracker' || dur > r.durationMin) r.durationMin = Math.max(r.durationMin || 0, dur);
    if (r.source !== 'twitchtracker') { r.title = title; if (!r.location) { const l = locate(title); if (l) r.location = l; } }
    r.vod = { id: v.id, sec: durationSec(v.duration), start: v.created_at };   // VoD ist (noch) abspielbar
    if (JSON.stringify([r.vodId, r.durationMin, r.title]) !== before) updated++;
  } else {
    const b = berlin(start);
    const n = {
      id: `tw-${v.id}`, vodId: v.id, source: 'twitch', title, date: b.date, start: b.time, durationMin: dur,
      desc: '', points: [], stops: [], clips: [], vod: { id: v.id, sec: durationSec(v.duration), start: v.created_at },
    };
    const l = locate(title); if (l) n.location = l;
    streams.push(n); added++;
  }
}

// VoDs, die Twitch inzwischen gelöscht hat, nicht mehr anbieten
{
  const vodIds = new Set(videos.map(v => v.id));
  for (const r of streams) if (r.vod && !vodIds.has(r.vod.id)) delete r.vod;
}

// Orte nachtragen: Streams ohne Ort bekommen einen, sobald ihr Titel zu einem Eintrag in data/locations.json passt.
// (Bestehende Orte werden nie überschrieben – so wirken neue Einträge in der Ortsliste auch rückwirkend.)
let located = 0;
for (const r of streams) if (!r.location) { const l = locate(r.title); if (l) { r.location = l; located++; } }

// 2) Clips der letzten CLIP_DAYS Tage
const since = new Date(Date.now() - CLIP_DAYS * 86400000).toISOString();
const clips = await helix('clips', { broadcaster_id: user.id, started_at: since, ended_at: new Date().toISOString(), first: '100' });
// Einmaliger Nachhol-Lauf (BACKFILL=1): für jeden Stream einzeln nach Clips fragen.
// Twitch liefert bei langen Zeiträumen nur die meistgesehenen Clips, so fehlen sonst Clips mit wenigen Aufrufen.
if (process.env.BACKFILL === '1' || process.env.BACKFILL === 'true') {
  const seenIds = new Set(clips.map(c => c.id));
  let extra = 0;
  for (const r of streams) {
    const s = startOf(r); if (isNaN(s)) continue;
    const from = new Date(+s - 10 * 60000).toISOString(), to = new Date(+s + (r.durationMin + 30) * 60000).toISOString();
    try {
      for (const c of await helix('clips', { broadcaster_id: user.id, started_at: from, ended_at: to, first: '100' })) {
        if (!seenIds.has(c.id)) { seenIds.add(c.id); clips.push(c); extra++; }
      }
    } catch (e) { console.warn('Nachhol-Abfrage fehlgeschlagen für', r.id, e.message); }
  }
  // Streams, für die nichts kam: breiter suchen (1 Tag davor bis 1 Tag danach)
  let wide = 0;
  for (const r of streams) {
    const s = startOf(r); if (isNaN(s)) continue;
    const has = clips.some(c => { const t = new Date(c.created_at); return t >= s - 10 * 60000 && t <= +s + (r.durationMin + 30) * 60000; });
    if (has || (r.clips || []).length) continue;
    try {
      const got = await helix('clips', { broadcaster_id: user.id, started_at: new Date(+s - 86400000).toISOString(), ended_at: new Date(+s + (r.durationMin * 60000) + 86400000).toISOString(), first: '100' });
      const inside = got.filter(c => { const t = new Date(c.created_at); return t >= s - 10 * 60000 && t <= +s + (r.durationMin + 30) * 60000; });
      console.log(`Breite Suche ${r.id}: ${got.length} Clips im ±1-Tag-Fenster, davon ${inside.length} im Stream`);
      for (const c of got) if (!seenIds.has(c.id)) { seenIds.add(c.id); clips.push(c); extra++; wide++; }
    } catch (e) { console.warn('Breite Suche fehlgeschlagen für', r.id, e.message); }
  }
  console.log('Breite Suche: ' + wide + ' weitere Clips.');
  console.log('Nachhol-Lauf: ' + extra + ' Clips aus den Stream-Zeiträumen geholt (neue und bekannte).');
}
const gameIds = [...new Set(clips.map(c => c.game_id).filter(Boolean))];
const games = {};
for (let i = 0; i < gameIds.length; i += 100) {
  const q = new URLSearchParams(); gameIds.slice(i, i + 100).forEach(id => q.append('id', id));
  for (const g of await helix('games', q)) games[g.id] = g.name;
}
const known = new Map();
for (const r of streams) for (const c of r.clips || []) known.set(c.url.split('/').pop(), { r, c });

let clipsNew = 0, clipsUpd = 0, clipsLost = 0;
for (const c of clips) {
  const slug = c.id;
  const k = known.get(slug);
  if (k) { if (k.c.views !== c.view_count) { k.c.views = c.view_count; clipsUpd++; } continue; }
  // Zuordnung: erst über das VOD, sonst über die Zeit (Stream, der lief), sonst letzter Stream davor (≤ 72 h)
  const t = new Date(c.created_at);
  let r = c.video_id && streams.find(x => x.vodId === c.video_id);
  if (!r) {
    const hits = streams.filter(x => { const s = startOf(x); return t >= s - 5 * 60000 && t <= +s + (x.durationMin + 10) * 60000; });
    r = hits.sort((a, b) => Math.abs(t - startOf(a)) - Math.abs(t - startOf(b)))[0];
  }
  if (!r) {
    const prev = streams.filter(x => startOf(x) <= t && t - startOf(x) <= 72 * 3600000);
    r = prev.sort((a, b) => startOf(b) - startOf(a))[0];
  }
  if (!r) { clipsLost++; continue; }
  r.clips = r.clips || [];
  const entry = {
    title: (c.title || 'Clip').trim(), url: `https://www.twitch.tv/${LOGIN}/clip/${slug}`,
    views: c.view_count, by: c.creator_name || '', dur: Math.round(c.duration || 0), game: games[c.game_id] || '',
  };
  r.clips.push(entry);
  known.set(slug, { r, c: entry });   // gleicher Clip kann in mehreren Seiten der Antwort auftauchen
  clipsNew++;
}

// Doppelte Clips entfernen (gleiche URL nur einmal behalten)
{
  const seen = new Set();
  for (const r of streams) r.clips = (r.clips || []).filter(c => !seen.has(c.url) && seen.add(c.url));
}

// 3) Alle gespeicherten Clips prüfen: gelöschte entfernen, Aufrufe aktualisieren
//    Twitch liefert bei /clips?id=… nur Clips zurück, die noch existieren (bis 100 IDs pro Anfrage).
const stored = [];
for (const r of streams) for (const c of r.clips || []) stored.push({ r, c, id: c.url.split('/').pop() });
const alive = new Map();
let checkFailed = false;
for (let i = 0; i < stored.length; i += 100) {
  const batch = stored.slice(i, i + 100);
  const q = new URLSearchParams(); batch.forEach(s => q.append('id', s.id));
  try {
    const res = await helix('clips', q);
    // Sicherheitsnetz: ein komplett leerer Block deutet eher auf einen API-Fehler hin als auf 100 gelöschte Clips
    if (!res.length && batch.length >= 20) { checkFailed = true; console.warn('Leere Antwort für einen Clip-Block, Prüfung übersprungen.'); continue; }
    for (const c of res) alive.set(c.id, c);
  } catch (e) { checkFailed = true; console.warn('Clip-Prüfung fehlgeschlagen:', e.message); }
}
let clipsDel = 0;
const missing = stored.filter(s => !alive.has(s.id));
if (!checkFailed && missing.length > stored.length * 0.25) {
  console.warn(`${missing.length} von ${stored.length} Clips fehlen – das sieht nach einem API-Problem aus, es wird nichts gelöscht.`);
} else if (!checkFailed) {
  const gone = new Set(missing.map(s => s.c));
  for (const r of streams) {
    const before = (r.clips || []).length;
    r.clips = (r.clips || []).filter(c => !gone.has(c));
    clipsDel += before - r.clips.length;
  }
  if (clipsDel) console.log('Gelöschte Clips entfernt:', missing.map(s => s.c.title).join(' | '));
}
// Kategorienamen für alle noch vorhandenen Clips nachschlagen
const missingGames = [...new Set([...alive.values()].map(c => c.game_id).filter(id => id && !games[id]))];
for (let i = 0; i < missingGames.length; i += 100) {
  const q = new URLSearchParams(); missingGames.slice(i, i + 100).forEach(id => q.append('id', id));
  try { for (const g of await helix('games', q)) games[g.id] = g.name; } catch (e) { console.warn('Kategorien:', e.message); }
}
// Clips umhängen: liegt die Erstellzeit eindeutig im Zeitfenster eines anderen Streams, gehört der Clip dorthin.
// (Clips, die später aus dem VOD geschnitten wurden, liegen in keinem Fenster und bleiben, wo sie sind.)
// Streams mit "openEnd" (nachgetragen, Dauer unbekannt) reichen bis zum nächsten Stream, höchstens 12 Std.
const byStart = [...streams].sort((a, b) => startOf(a) - startOf(b));
const windowOf = r => {
  const s = +startOf(r);
  if (r.openEnd) { const nx = byStart.find(x => +startOf(x) > s); return [s - 5 * 60000, Math.min(nx ? +startOf(nx) - 60000 : Infinity, s + 12 * 3600000)]; }
  return [s - 5 * 60000, s + ((r.durationMin || 0) + 10) * 60000];
};
// Clips, die später aus dem VOD geschnitten wurden: der eigentliche Moment im Stream ist
// Startzeit des VODs + Position des Clips im VOD (vod_offset). Das ist genauer als die Erstellzeit.
const vodStart = new Map();
{
  const ids = [...new Set([...alive.values()].filter(a => a.video_id && a.vod_offset != null).map(a => a.video_id))];
  for (let i = 0; i < ids.length; i += 100) {
    const q = new URLSearchParams(); ids.slice(i, i + 100).forEach(id => q.append('id', id));
    try { for (const v of await helix('videos', q)) if (v.type === 'archive') vodStart.set(v.id, +new Date(v.created_at)); }
    catch (e) { console.warn('VOD-Abfrage:', e.message); }
  }
}
const momentOf = a => (a.video_id && a.vod_offset != null && vodStart.has(a.video_id)) ? vodStart.get(a.video_id) + a.vod_offset * 1000 : +new Date(a.created_at);
let clipsMoved = 0;
for (const s of stored) {
  const a = alive.get(s.id);
  if (!a || !a.created_at) continue;
  s.c.at = a.created_at;
  const t = momentOf(a);
  if (t !== +new Date(a.created_at)) s.c.moment = new Date(t).toISOString(); else delete s.c.moment;
  const [o0, o1] = windowOf(s.r);
  if (t >= o0 && t <= o1) continue;
  let target = streams.find(x => x !== s.r && (([w0, w1]) => t >= w0 && t <= w1)(windowOf(x)));
  if (!target) {
    // Clip wurde nach dem Stream aus einem VOD geschnitten (liegt in keinem Zeitfenster).
    // Meist wird das letzte VOD geclippt: letzter Stream davor (max. 3 Tage), bevorzugt mit passender Kategorie.
    const g = a.game_id && games[a.game_id];
    const hasCat = r => !g || r.category === g || r.game === g || (r.clips || []).some(c => c !== s.c && c.game === g && c.at && (([w0, w1]) => +new Date(c.at) >= w0 && +new Date(c.at) <= w1)(windowOf(r)));
    const cand = byStart.filter(x => windowOf(x)[1] <= t && t - windowOf(x)[1] <= 3 * 86400000);
    if (cand.length) target = [...cand].reverse().find(hasCat) || cand[cand.length - 1];
  }
  if (!target || target === s.r) continue;
  s.r.clips = s.r.clips.filter(c => c !== s.c);
  (target.clips = target.clips || []).push(s.c);
  s.r = target; clipsMoved++;
}
// Nachgetragene Streams: Dauer mindestens bis zum letzten Clip
for (const r of streams) if (r.openEnd) {
  const last = Math.max(0, ...(r.clips || []).map(c => c.at ? +new Date(c.at) : 0));
  if (last) r.durationMin = Math.max(r.durationMin || 0, Math.round((last - startOf(r)) / 60000) + 5);
}
if (clipsMoved) console.log('Clips umgehängt:', clipsMoved);

for (const s of stored) {
  const a = alive.get(s.id);
  if (!a) continue;
  // Stelle des Clips im VoD (Sekunden ab Streamstart) für die Zeitleiste unter dem VoD-Player
  if (s.r.vod && a.video_id === s.r.vod.id && a.vod_offset != null) s.c.off = a.vod_offset; else delete s.c.off;
  if (s.c.views !== a.view_count) { s.c.views = a.view_count; clipsUpd++; }
  if (a.title && s.c.title !== a.title.trim()) s.c.title = a.title.trim();   // umbenannte Clips
  if (a.thumbnail_url) s.c.thumb = a.thumbnail_url;                          // Vorschaubild
  if (a.game_id && games[a.game_id]) s.c.game = games[a.game_id];            // Kategorie
}

// 4) Kategorie je Stream: häufigste Kategorie seiner Clips
for (const r of streams) {
  const cnt = {};
  for (const c of r.clips || []) if (c.game) cnt[c.game] = (cnt[c.game] || 0) + 1;
  const top = Object.entries(cnt).sort((a, b) => b[1] - a[1])[0];
  if (r.game) r.category = r.game;               // live gemessene Kategorie hat Vorrang
  else if (top) r.category = top[0]; else delete r.category;
}

// 4b) Coverbilder der Stream-Kategorien (Twitch-Boxart) in data/categories.json – nur fehlende nachschlagen
{
  const CATS = new URL('../data/categories.json', import.meta.url);
  let cats = {};
  try { cats = JSON.parse(await readFile(CATS, 'utf8')); } catch {}
  const want = [...new Set(streams.map(r => r.category).filter(Boolean))];
  const missing = want.filter(n => !cats[n]);
  for (let i = 0; i < missing.length; i += 100) {
    const q = new URLSearchParams(); missing.slice(i, i + 100).forEach(n => q.append('name', n));
    try {
      for (const g of await helix('games', q)) {
        const name = missing.find(n => n.toLowerCase() === String(g.name).toLowerCase()) || g.name;
        cats[name] = { id: g.id, box: String(g.box_art_url || '').replace('{width}', '52').replace('{height}', '72') };
      }
    } catch (e) { console.warn('Kategorie-Bilder:', e.message); }
  }
  const keys = Object.keys(cats).sort();
  const out = '{\n' + keys.map(k => `  ${JSON.stringify(k)}: ${JSON.stringify(cats[k])}`).join(',\n') + '\n}\n';
  let oldCats = ''; try { oldCats = await readFile(CATS, 'utf8'); } catch {}
  if (out !== oldCats) { await writeFile(CATS, out); console.log('Kategorie-Bilder: ' + keys.length + ' (' + missing.length + ' neu gesucht)'); }
}

// 4b) Coverbilder der Kategorien (Twitch-Boxart) in data/categories.json – nur fehlende nachschlagen
{
  const CATS = new URL('../data/categories.json', import.meta.url);
  let cats = {};
  try { cats = JSON.parse(await readFile(CATS, 'utf8')); } catch {}
  const want = [...new Set(streams.map(r => r.category).concat(streams.flatMap(r => (r.clips || []).map(c => c.game))).filter(Boolean))];
  const missing = want.filter(n => !cats[n]);
  for (let i = 0; i < missing.length; i += 100) {
    const q = new URLSearchParams(); missing.slice(i, i + 100).forEach(n => q.append('name', n));
    try {
      for (const g of await helix('games', q)) {
        const name = missing.find(n => n.toLowerCase() === String(g.name).toLowerCase()) || g.name;
        cats[name] = { id: g.id, box: String(g.box_art_url || '').replace('{width}', '52').replace('{height}', '72') };
      }
    } catch (e) { console.warn('Kategorie-Bilder:', e.message); }
  }
  const keys = Object.keys(cats).sort();
  const out = '{\n' + keys.map(k => `  ${JSON.stringify(k)}: ${JSON.stringify(cats[k])}`).join(',\n') + '\n}\n';
  let oldCats = ''; try { oldCats = await readFile(CATS, 'utf8'); } catch {}
  if (out !== oldCats) { await writeFile(CATS, out); console.log('Kategorie-Bilder: ' + keys.length + ' (' + missing.length + ' neu gesucht)'); }
}

// 5) Orte aus Clip-Titeln: z. B. "Tanz in Venedig". Mindestens 2 passende Clips,
//    bei IRL-Streams reicht einer. Orte aus dem Streamtitel haben immer Vorrang.
let fromClips = 0;
for (const r of streams) {
  if (r.location) continue;
  const cnt = new Map();
  for (const c of r.clips || []) { const l = locate(c.title || ''); if (l) { const k = l.name; cnt.set(k, { l, n: (cnt.get(k)?.n || 0) + 1 }); } }
  const best = [...cnt.values()].sort((a, b) => b.n - a.n)[0];
  if (best && (best.n >= 2 || (best.n >= 1 && r.category === 'IRL'))) { r.location = { ...best.l, from: 'clips' }; fromClips++; }
}

prune();
for (const r of streams) (r.clips || []).sort((a, b) => b.views - a.views);
streams.sort((a, b) => (b.date + b.start).localeCompare(a.date + a.start));

const json = JSON.stringify(streams, null, 0).replace(/\},\{"id"/g, '},\n{"id"');
const old = await readFile(DATA, 'utf8');
let meta = {};
try { meta = JSON.parse(await readFile(META, 'utf8')); } catch {}
const profile = { profileImage: user.profile_image_url || meta.profileImage || null, displayName: user.display_name || meta.displayName || LOGIN };
const profileChanged = profile.profileImage !== meta.profileImage || profile.displayName !== meta.displayName;
if (json !== old) await writeFile(DATA, json);
const clipTotal = streams.reduce((s, r) => s + (r.clips || []).length, 0);
if (json !== old || profileChanged) {
  await writeFile(META, JSON.stringify({ updated: json !== old ? new Date().toISOString() : meta.updated, streams: streams.length, clips: clipTotal, ...profile }, null, 1) + '\n');
}
// Teilen-Vorschaubild nur neu erzeugen, wenn sich die Zahlen geändert haben (nicht bei jeder Zuschauer-Messung)
const { existsSync } = await import('node:fs');
if (meta.streams !== streams.length || meta.clips !== clipTotal || profileChanged || !existsSync(new URL('../og.png', import.meta.url)) || !existsSync(new URL('../favicon.png', import.meta.url))) {
  await writeFile(new URL('../.og-needed', import.meta.url), '1');
}
console.log('Live:', liveNote);
console.log(`VODs geprüft: ${videos.length} · neue Streams: ${added} · aktualisiert: ${updated} · Orte nachgetragen: ${located} (aus Clip-Titeln: ${fromClips})`);
console.log(`Clips geprüft: ${clips.length} neue · ${stored.length} gespeicherte · neu: ${clipsNew} · gelöscht: ${clipsDel} · Aufrufe aktualisiert: ${clipsUpd} · ohne Stream: ${clipsLost}`);
