// Kompakte Fassung von data/streams.json für die Webseite (data/streams.min.json):
// Clip-Adressen und Vorschaubilder fangen fast immer gleich an – gespeichert wird nur der eindeutige Teil.
// Die Seite setzt die vollen Adressen beim Laden wieder zusammen (siehe expandStreams in index.html).
const TPRE = 'https://static-cdn.jtvnw.net/twitch-video-assets/twitch-vap-video-assets-prod-us-west-2/';
const TDEF = 'thumb-0000000000-480x272';
export function compactStreams(streams, login) {
  const upre = `https://www.twitch.tv/${login}/clip/`;
  return streams.map(r => ({
    ...r,
    clips: (r.clips || []).map(c => {
      const o = { ...c };
      if (typeof o.url === 'string' && o.url.startsWith(upre)) { o.u = o.url.slice(upre.length); delete o.url; }
      const m = typeof o.thumb === 'string' && o.thumb.startsWith(TPRE) && /^([^/]+)\/landscape\/thumb\/([^/]+)\.jpg$/.exec(o.thumb.slice(TPRE.length));
      if (m) { o.t = m[2] === TDEF ? m[1] : m[1] + '/' + m[2]; delete o.thumb; }
      return o;
    }),
  }));
}
