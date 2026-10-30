// Zählt beim Veröffentlichen die Kennzahlen für den Changelog direkt aus der Git-Historie
// und schreibt sie nach data/stats.json (wird nur veröffentlicht, nicht committet).
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const BOT = 'adventure-map-bot';
const log = execSync('git log --format=%an%x09%cs%x09%s', { encoding: 'utf8' }).trim().split('\n').map(l => l.split('\t'));
const own = log.filter(([a]) => a !== BOT);
const bot = log.filter(([a]) => a === BOT);
const stats = {
  first: log.map(([, d]) => d).sort()[0],            // erster Commit (YYYY-MM-DD)
  changes: own.length,                               // Änderungen von Hand (Chris und Claude)
  dataUpdates: bot.filter(([, , s]) => s.startsWith('Daten aktualisiert')).length,
  routes: bot.filter(([, , s]) => s.startsWith('Route gespeichert')).length,
  at: new Date().toISOString(),
};
writeFileSync('data/stats.json', JSON.stringify(stats) + '\n');
console.log(stats);
