// Zips dist/ into release/usuals-<version>.zip for the Chrome Web Store.
//
// manifest.json carries `key`, so an unpacked build gets the store's extension
// id and signs in with the OAuth client registered against it. The store holds
// that key itself and refuses a package that brings its own, so the zipped
// manifest leaves it out. The icon SVGs are sources for the PNGs and the
// manifest does not use them, so they stay out too.
//
// Run with `npm run package`, which builds first. Node 22.2+ (zlib.crc32).

import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from 'fs';
import { join, relative, resolve, sep } from 'path';
import { crc32, deflateRawSync } from 'zlib';

const root = resolve(import.meta.dirname, '..');
const dist = join(root, 'dist');

function filesUnder(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'));
delete manifest.key;

const entries = filesUnder(dist)
  .map((path) => relative(dist, path).split(sep).join('/'))
  .filter((name) => !name.endsWith('.svg'))
  .sort((a, b) => (a === 'manifest.json' ? -1 : b === 'manifest.json' ? 1 : a.localeCompare(b)))
  .map((name) => ({
    name,
    data: name === 'manifest.json'
      ? Buffer.from(JSON.stringify(manifest, null, 2) + '\n')
      : readFileSync(join(dist, name)),
    mtime: statSync(join(dist, name)).mtime,
  }));

// A plain ZIP: one deflated entry per file, then the central directory.
function dosDateTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

const locals = [];
const centrals = [];
let offset = 0;
for (const { name, data, mtime } of entries) {
  const nameBytes = Buffer.from(name, 'utf8');
  const packed = deflateRawSync(data, { level: 9 });
  const crc = crc32(data);
  const { time, day } = dosDateTime(mtime);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);        // version needed
  local.writeUInt16LE(0x0800, 6);    // names are UTF-8
  local.writeUInt16LE(8, 8);         // deflate
  local.writeUInt16LE(time, 10);
  local.writeUInt16LE(day, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(packed.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  locals.push(local, nameBytes, packed);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);      // version made by
  central.writeUInt16LE(20, 6);      // version needed
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt16LE(time, 12);
  central.writeUInt16LE(day, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(packed.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt32LE(offset, 42);
  centrals.push(central, nameBytes);

  offset += local.length + nameBytes.length + packed.length;
}

const directory = Buffer.concat(centrals);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(entries.length, 8);
end.writeUInt16LE(entries.length, 10);
end.writeUInt32LE(directory.length, 12);
end.writeUInt32LE(offset, 16);

const out = join(root, 'release', `usuals-${manifest.version}.zip`);
mkdirSync(join(root, 'release'), { recursive: true });
writeFileSync(out, Buffer.concat([...locals, directory, end]));

console.log(`${relative(root, out)}: ${entries.length} files, manifest without key`);
for (const { name, data } of entries) console.log(`  ${String(data.length).padStart(9)}  ${name}`);
