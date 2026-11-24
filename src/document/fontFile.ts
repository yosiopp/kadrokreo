// 書体ファイル（TrueType / OpenType / WOFF / WOFF2）の種類の見分けと、書体名・太さ・斜体の読み取り。
// kdr に埋め込む書体（document.fonts）の名前と太さは、ファイルの name / OS/2 の表から決める
// （ブラウザの FontFace と CLI の Canvas が同じ書体を同じ名前・太さで使えるように、利用者の打ち込みには頼らない）。

import type { EmbeddedFont } from './types.ts'

/** 埋め込める書体の種類と、kdr の中のファイルの拡張子 */
export const FONT_EXTENSIONS: Record<string, string> = {
  'font/ttf': 'ttf',
  'font/otf': 'otf',
  'font/woff': 'woff',
  'font/woff2': 'woff2',
}
export const FONT_MIME_TYPES: readonly string[] = Object.keys(FONT_EXTENSIONS)

/** 書体として埋め込める名前の長さの上限（テキストの書体名の上限と同じ） */
export const MAX_EMBEDDED_FAMILY_LENGTH = 200
/**
 * 埋め込む書体の名前に使えない文字。テキストの書体名で使えない文字に加えて、
 * 書体名の並び（カンマ区切り）と引用符の区切りになる `,` `"` `'` も使えない（ノードの書体名に引用符で囲んで書くため）
 */
export const EMBEDDED_FAMILY_FORBIDDEN = /[\u0000-\u001f\u007f;{}<>\\,"']/

/** CSS の総称名。同じ名前の書体は引用符で囲まないと総称名の意味になる */
export const GENERIC_FAMILIES: ReadonlySet<string> = new Set([
  'serif',
  'sans-serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
  'ui-serif',
  'ui-sans-serif',
  'ui-monospace',
  'ui-rounded',
  'math',
  'emoji',
  'fangsong',
])

/** 先頭のバイト列から書体ファイルの種類（MIME）を見分ける。書体でなければ null（TrueType Collection も扱わない） */
export function fontMime(bytes: Uint8Array): string | null {
  if (bytes.length < 12) return null
  const tag = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3])
  if (tag === '\u0000\u0001\u0000\u0000' || tag === 'true') return 'font/ttf'
  if (tag === 'OTTO') return 'font/otf'
  if (tag === 'wOFF') return 'font/woff'
  if (tag === 'wOF2') return 'font/woff2'
  return null
}

/**
 * テキストの書体名（fontFamily）に書く値。英字で始まる語を空白で並べただけの名前はそのまま、
 * それ以外（数字で始まる語・記号・ASCII の外の文字・総称名と同じ名前）は引用符で囲む（Canvas の font に書けるように）
 */
export function fontFamilyValue(family: string): string {
  const plain = /^[A-Za-z_][A-Za-z0-9_-]*( [A-Za-z_][A-Za-z0-9_-]*)*$/.test(family)
  return plain && !GENERIC_FAMILIES.has(family.toLowerCase()) ? family : `"${family}"`
}

/** 書体名の並び（`"A B", sans-serif`）の先頭の名前（引用符を外したもの） */
export function firstFamily(value: string): string {
  const first = value.split(',')[0].trim()
  const quote = first[0]
  return first.length >= 2 && (quote === '"' || quote === "'") && first.at(-1) === quote ? first.slice(1, -1) : first
}

/** テキストの書体名が、埋め込んだ書体のどれかを指しているか（先頭の名前で比べる） */
export function embeddedFamilyOf(fonts: readonly EmbeddedFont[], fontFamily: string): string | null {
  const name = firstFamily(fontFamily)
  return fonts.some((font) => font.family === name) ? name : null
}

/** 書体名を、埋め込む書体の名前として使える形に整える（使えない文字を除き、前後の空白を取り、長さを抑える）。空なら null */
export function cleanFamilyName(name: string): string | null {
  const cleaned = [...name]
    .filter((char) => !EMBEDDED_FAMILY_FORBIDDEN.test(char))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_EMBEDDED_FAMILY_LENGTH)
    .trim()
  return cleaned === '' ? null : cleaned
}

export type FontFileInfo = { mime: string; family: string | null; weight: number; style: 'normal' | 'italic' }

/**
 * 書体ファイルの種類・書体名（name の表の 16 か 1）・太さ（OS/2 の usWeightClass を 100 刻みに丸めたもの）・斜体を読む。
 * WOFF は表を展開して読む（非同期）。WOFF2 は表の展開に Brotli が要るので読まない（null）。書体として読めなければ null
 */
export async function readFontFileInfo(bytes: Uint8Array): Promise<FontFileInfo | null> {
  const mime = fontMime(bytes)
  if (mime === null || mime === 'font/woff2') return null
  try {
    const tables = mime === 'font/woff' ? await woffTables(bytes) : sfntTables(bytes)
    if (tables === null) return null
    return { mime, ...fontInfoOf(tables) }
  } catch {
    // 表が途中で切れている・壊れている
    return null
  }
}

type Tables = { name?: Uint8Array; os2?: Uint8Array; head?: Uint8Array }

const WANTED: Record<string, keyof Tables> = { name: 'name', 'OS/2': 'os2', head: 'head' }

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

function tagAt(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3])
}

/** TrueType / OpenType の表の一覧から、要る表を切り出す */
function sfntTables(bytes: Uint8Array): Tables | null {
  const data = view(bytes)
  const count = data.getUint16(4)
  const tables: Tables = {}
  for (let i = 0; i < count; i++) {
    const record = 12 + i * 16
    const key = WANTED[tagAt(bytes, record)]
    if (key === undefined) continue
    const offset = data.getUint32(record + 8)
    const length = data.getUint32(record + 12)
    if (offset + length > bytes.length) return null
    tables[key] = bytes.subarray(offset, offset + length)
  }
  return tables
}

/** WOFF の表の一覧から、要る表を切り出す（圧縮された表は zlib で展開する） */
async function woffTables(bytes: Uint8Array): Promise<Tables | null> {
  const data = view(bytes)
  const count = data.getUint16(12)
  const tables: Tables = {}
  for (let i = 0; i < count; i++) {
    const record = 44 + i * 20
    const key = WANTED[tagAt(bytes, record)]
    if (key === undefined) continue
    const offset = data.getUint32(record + 4)
    const compressed = data.getUint32(record + 8)
    const length = data.getUint32(record + 12)
    if (offset + compressed > bytes.length || length > 1024 * 1024) return null
    const raw = bytes.slice(offset, offset + compressed)
    tables[key] = compressed < length ? await inflate(raw) : raw
  }
  return tables
}

async function inflate(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

function fontInfoOf(tables: Tables): Omit<FontFileInfo, 'mime'> {
  const family = tables.name ? (familyName(tables.name, 16) ?? familyName(tables.name, 1)) : null
  let weight = 400
  let italic = false
  if (tables.os2 && tables.os2.length >= 64) {
    const os2 = view(tables.os2)
    weight = roundWeight(os2.getUint16(4))
    // fsSelection の ITALIC（bit 0）か OBLIQUE（bit 9）
    italic = (os2.getUint16(62) & 0x201) !== 0
  } else if (tables.head && tables.head.length >= 46) {
    // macStyle の Italic（bit 1）
    italic = (view(tables.head).getUint16(44) & 0x2) !== 0
  }
  return { family: family === null ? null : cleanFamilyName(family), weight, style: italic ? 'italic' : 'normal' }
}

/** usWeightClass（1〜1000）を 100〜900 の 100 刻みにする。古い書体の 1〜9 の値は 100 倍とみなす */
function roundWeight(value: number): number {
  const weight = value >= 1 && value <= 9 ? value * 100 : value
  return Math.min(900, Math.max(100, Math.round(weight / 100) * 100))
}

/** name の表から、nameID の名前を読む。Windows（UTF-16BE）の英語を先に、なければ Windows のほかの言語、Mac（Roman）の順に探す */
function familyName(table: Uint8Array, nameId: number): string | null {
  const data = view(table)
  const count = data.getUint16(2)
  const storage = data.getUint16(4)
  let best: { score: number; text: string } | null = null
  for (let i = 0; i < count; i++) {
    const record = 6 + i * 12
    if (record + 12 > table.length) break
    const platform = data.getUint16(record)
    const encoding = data.getUint16(record + 2)
    const language = data.getUint16(record + 4)
    if (data.getUint16(record + 6) !== nameId) continue
    const length = data.getUint16(record + 8)
    const start = storage + data.getUint16(record + 10)
    if (start + length > table.length) continue
    const raw = table.subarray(start, start + length)
    let score: number
    let text: string
    if (platform === 3 && (encoding === 1 || encoding === 10)) {
      score = language === 0x409 ? 3 : 2
      text = new TextDecoder('utf-16be').decode(raw)
    } else if (platform === 0) {
      score = 2
      text = new TextDecoder('utf-16be').decode(raw)
    } else if (platform === 1 && encoding === 0) {
      score = 1
      text = String.fromCharCode(...raw)
    } else {
      continue
    }
    if (text.trim() !== '' && (best === null || score > best.score)) best = { score, text }
  }
  return best?.text ?? null
}
