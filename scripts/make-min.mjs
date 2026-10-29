// Erzeugt data/streams.min.json einmalig aus data/streams.json (sonst macht das update.mjs bei jedem Lauf)
import { readFile, writeFile } from 'node:fs/promises';
import { compactStreams } from './compact.mjs';
const s = JSON.parse(await readFile(new URL('../data/streams.json', import.meta.url), 'utf8'));
await writeFile(new URL('../data/streams.min.json', import.meta.url), JSON.stringify(compactStreams(s, process.env.TWITCH_LOGIN || 'naschiitaschii')));
console.log('streams.min.json geschrieben');
