#!/usr/bin/env node
// Generates the app logo: a green rounded square with a lowercase "l" set in the
// app's own font (Leckerli One, the wordmark font). Outputs assets/logo.svg and a
// 1024x1024 assets/logo.png, the master `tauri icon` consumes.
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import opentype from 'opentype.js'
import { decompress } from 'wawoff2'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const SIZE = 1024
const CORNER_RADIUS = 0.2237 * SIZE // macOS squircle proportion
const BACKGROUND = '#132a1e' // --color-deck-800
const FOREGROUND = '#ffffff'
const GLYPH = 'L'
const GLYPH_HEIGHT = 0.6 // share of the icon the glyph fills

const rasterize = (svgPath, pngPath) => {
  for (const [bin, args] of [
    ['magick', ['-background', 'none', svgPath, pngPath]],
    ['rsvg-convert', ['-w', String(SIZE), '-h', String(SIZE), '-o', pngPath, svgPath]],
  ]) {
    try {
      execFileSync(bin, args, { stdio: 'inherit' })
      return bin
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  throw new Error('need ImageMagick (`brew install imagemagick`) or rsvg-convert to rasterize the SVG')
}

const ttf = await decompress(await readFile(join(root, 'src/assets/fonts/leckerli-one.woff2')))
const font = opentype.parse(Uint8Array.from(ttf).buffer)

const glyph = font.charToGlyph(GLYPH)
const box = glyph.getBoundingBox()
const path = glyph.getPath(0, 0, (font.unitsPerEm * (GLYPH_HEIGHT * SIZE)) / (box.y2 - box.y1))
// Center on the glyph's ink, not its metrics — a script "l" sits well off its baseline.
const ink = path.getBoundingBox()
const dx = (SIZE - (ink.x2 - ink.x1)) / 2 - ink.x1
const dy = (SIZE - (ink.y2 - ink.y1)) / 2 - ink.y1

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
  <rect width="${SIZE}" height="${SIZE}" rx="${CORNER_RADIUS}" ry="${CORNER_RADIUS}" fill="${BACKGROUND}"/>
  <path transform="translate(${dx.toFixed(2)} ${dy.toFixed(2)})" fill="${FOREGROUND}" d="${path.toPathData(2)}"/>
</svg>
`

await mkdir(join(root, 'assets'), { recursive: true })
const svgPath = join(root, 'assets/logo.svg')
const pngPath = join(root, 'assets/logo.png')
await writeFile(svgPath, svg)
rasterize(svgPath, pngPath)

console.log(`wrote assets/logo.svg and assets/logo.png (${SIZE}x${SIZE})`)
