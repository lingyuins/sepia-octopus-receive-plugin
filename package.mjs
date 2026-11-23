#!/usr/bin/env node
// Package the Octopus Receive plugin into an installable .zip (stored entries).
// Build the wasm first: cargo build --target wasm32-unknown-unknown --release
// Then: node sepia-octopus-receive/package.mjs
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const wasm = join(here, 'target', 'wasm32-unknown-unknown', 'release', 'sepia_octopus_receive.wasm')
if (!existsSync(wasm)) {
  console.error('Missing wasm. Run: cargo build --target wasm32-unknown-unknown --release (in this folder)')
  process.exit(1)
}
const out = join(here, 'octopus-receive.zip')
const files = [
  ['manifest.json', join(here, 'manifest.json')],
  ['plugin.wasm', wasm],
  ['ui/index.html', join(here, 'ui', 'index.html')],
  ['ui/mapping.js', join(here, 'ui', 'mapping.js')],
]
function crc32(buf) {
  const table = []
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  let crc = 0xffffffff
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}
const chunks = []
const central = []
let offset = 0
for (const [name, path] of files) {
  const data = readFileSync(path)
  const nameBuf = Buffer.from(name, 'utf8')
  const crc = crc32(data)
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6)
  local.writeUInt16LE(0, 8); local.writeUInt16LE(0, 10); local.writeUInt16LE(0, 12)
  local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22)
  local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28)
  chunks.push(local, nameBuf, data)
  const cd = Buffer.alloc(46)
  cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6)
  cd.writeUInt16LE(0, 8); cd.writeUInt16LE(0, 10); cd.writeUInt16LE(0, 12); cd.writeUInt16LE(0, 14)
  cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(data.length, 24)
  cd.writeUInt16LE(nameBuf.length, 28); cd.writeUInt16LE(0, 30); cd.writeUInt16LE(0, 32)
  cd.writeUInt16LE(0, 34); cd.writeUInt16LE(0, 36); cd.writeUInt32LE(0, 38); cd.writeUInt32LE(offset, 42)
  central.push(Buffer.concat([cd, nameBuf]))
  offset += local.length + nameBuf.length + data.length
}
const centralBuf = Buffer.concat(central)
const end = Buffer.alloc(22)
end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6)
end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10)
end.writeUInt32LE(centralBuf.length, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(0, 20)
writeFileSync(out, Buffer.concat([...chunks, centralBuf, end]))
console.log(`Wrote ${out} (${files.length} files)`)