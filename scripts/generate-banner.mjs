#!/usr/bin/env node
// Generates the README banner: the "Lookout" wordmark (Leckerli One, the app's own font) over a
// low-fidelity skeleton of the review board — five columns of placeholder cards, cropped and faded
// at the bottom edge. Outputs assets/banner.svg and a 2x assets/banner.png.
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import opentype from 'opentype.js'
import { decompress } from 'wawoff2'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const W = 1280
const H = 400
const SCALE = 2 // render the PNG at 2x so the banner stays crisp on retina

// palette: src/index.css
const BG = '#0b1d14' // --color-deck-900
const CARD_BG = '#132a1e' // --color-deck-800
const CARD_BORDER = '#1e402d' // --color-deck-700
const COLUMN_BG = '#1fa35c' // --color-grass-600, laid over the background at 10%
const SKELETON = '#9db8aa' // --color-deck-400
const AVATAR = '#2a5540' // --color-deck-600
const TAG = { grass: '#2bbd6e', amber: '#fbbf24', purple: '#c084fc', red: '#f87171' }
const RUNNING = '#fbbf24' // the amber a card wears while a claude run is live

const WORDMARK = 'Lookout'
const WORDMARK_HEIGHT = 104 // ink height, in canvas units
const WORDMARK_TOP = 58

const PAD_X = 57
const GAP = 14
const COL_W = 222
const BOARD_TOP = 196
const FADE_TOP = 262 // below this the board dissolves into the bottom edge
const FADE_END = 396
const CARD_GAP = 8
const INNER = COL_W - 16 - 20 // column padding, then card padding

// The board, column by column: header bar width (stands in for Watching / Needs Review / Reviewed /
// Follow-up / Done) and the cards under it. `lines` are title-bar widths as a share of the card's
// inner width; `state` gives a card the amber treatment of a live run. Cards past the bottom edge
// are dropped, so the third row only ever shows if the layout above it gets shorter.
const COLUMNS = [
  {
    header: 58,
    cards: [
      { lines: [0.94, 0.52], tags: ['grass'] },
      { lines: [0.72], tags: [] },
      { lines: [0.88, 0.61], tags: ['grass'] },
    ],
  },
  {
    header: 86,
    cards: [
      { lines: [0.9, 0.44], tags: ['amber'], state: 'running' },
      { lines: [0.81, 0.58], tags: ['grass', 'red'] },
      { lines: [0.66], tags: ['grass'] },
    ],
  },
  {
    header: 58,
    cards: [
      { lines: [0.93, 0.39], tags: ['grass', 'grass'] },
      { lines: [0.77, 0.63], tags: ['grass'] },
    ],
  },
  {
    header: 64,
    cards: [
      { lines: [0.85], tags: ['grass', 'amber'] },
      { lines: [0.91, 0.47], tags: ['grass'] },
      { lines: [0.7], tags: [] },
    ],
  },
  {
    header: 32,
    cards: [
      { lines: [0.89, 0.55], tags: ['purple'] },
      { lines: [0.74], tags: ['purple', 'grass'] },
      { lines: [0.86, 0.41], tags: ['grass'] },
    ],
  },
]

const rasterize = (svgPath, pngPath) => {
  for (const [bin, args] of [
    ['magick', ['-background', 'none', svgPath, pngPath]],
    ['rsvg-convert', ['-w', String(W * SCALE), '-h', String(H * SCALE), '-o', pngPath, svgPath]],
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

const n = (v) => Number(v.toFixed(2))

// ImageMagick's built-in SVG renderer is the only one we can count on, and it doesn't do gradient
// masks — so the fade is baked in, one opacity per card, taken from where the card starts.
const fade = (y) => Math.max(0, Math.min(1, (FADE_END - y) / (FADE_END - FADE_TOP)))

const rect = (x, y, w, h, r, fill, opacity) =>
  `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" rx="${r}" fill="${fill}" fill-opacity="${n(opacity)}"/>`

// One skeleton card: title bars, an author row (avatar + name + repo#number), then a tag row.
const card = (x, y, { lines, tags, state }) => {
  const f = fade(y)
  const cx = x + 10
  const parts = []
  let cy = y + 12
  for (const [i, share] of lines.entries()) {
    parts.push(rect(cx, cy, INNER * share, 8, 4, SKELETON, (i === 0 ? 0.38 : 0.26) * f))
    cy += 14
  }
  cy += 4
  parts.push(
    `<circle cx="${n(cx + 6)}" cy="${n(cy + 6)}" r="6" fill="${AVATAR}" fill-opacity="${n(f)}"/>`,
    rect(cx + 18, cy + 2, 56, 7, 3.5, SKELETON, 0.3 * f),
    rect(x + COL_W - 16 - 10 - 46, cy + 2, 46, 7, 3.5, SKELETON, 0.18 * f),
  )
  cy += 20
  let tx = cx
  for (const tag of tags) {
    const w = tag === 'grass' ? 44 : 34
    parts.push(rect(tx, cy, w, 12, 4, TAG[tag], 0.3 * f))
    tx += w + 6
  }
  const h = cy + (tags.length ? 12 : 0) + 10 - y
  const bg = state === 'running' ? RUNNING : CARD_BG
  const border = state === 'running' ? RUNNING : CARD_BORDER
  return [
    `<rect x="${n(x)}" y="${n(y)}" width="${COL_W - 16}" height="${n(h)}" rx="9" fill="${bg}" fill-opacity="${n((state === 'running' ? 0.1 : 0.85) * f)}" stroke="${border}" stroke-opacity="${n((state === 'running' ? 0.6 : 1) * f)}"/>`,
    ...parts,
  ].join('\n    ')
}

const column = (col, i) => {
  const x = PAD_X + i * (COL_W + GAP)
  const parts = [
    rect(x, BOARD_TOP, COL_W, H - BOARD_TOP + 20, 10, COLUMN_BG, 0.1),
    rect(x + 9, BOARD_TOP + 15, col.header, 8, 4, SKELETON, 0.45),
    rect(x + 9 + col.header + 8, BOARD_TOP + 15, 16, 8, 4, SKELETON, 0.25),
  ]
  let y = BOARD_TOP + 36
  for (const c of col.cards) {
    if (y > H) break
    const body = card(x + 8, y, c)
    parts.push(body)
    y += Number(/height="([\d.]+)"/.exec(body)[1]) + CARD_GAP
  }
  return parts.join('\n    ')
}

const ttf = await decompress(await readFile(join(root, 'src/assets/fonts/leckerli-one.woff2')))
const font = opentype.parse(Uint8Array.from(ttf).buffer)

// Size the wordmark by its ink, not its metrics — Leckerli One's ascenders overshoot its em box.
const probe = font.getPath(WORDMARK, 0, 0, 100).getBoundingBox()
const path = font.getPath(WORDMARK, 0, 0, (100 * WORDMARK_HEIGHT) / (probe.y2 - probe.y1))
const ink = path.getBoundingBox()
const dx = (W - (ink.x2 - ink.x1)) / 2 - ink.x1
const dy = WORDMARK_TOP - ink.y1

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W * SCALE}" height="${H * SCALE}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="${BG}"/>
  ${COLUMNS.map(column).join('\n    ')}
  <path transform="translate(${n(dx)} ${n(dy)})" fill="#ffffff" d="${path.toPathData(2)}"/>
</svg>
`

await mkdir(join(root, 'assets'), { recursive: true })
const svgPath = join(root, 'assets/banner.svg')
const pngPath = join(root, 'assets/banner.png')
await writeFile(svgPath, svg)
rasterize(svgPath, pngPath)

console.log(`wrote assets/banner.svg and assets/banner.png (${W * SCALE}x${H * SCALE})`)
