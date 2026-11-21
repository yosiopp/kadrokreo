// kdr の中身をまとめる tar（POSIX ustar）の読み書き。依存を増やさないよう自前で書いている。
// 扱うのは普通のファイルだけ（ディレクトリ・リンク・pax や GNU の拡張の見出しは受け付けない）。
// 書き出しは決まった値（時刻 0、所有者 0、mode 644）にして、同じドキュメントなら同じバイト列になるようにする。

const BLOCK = 512

export type TarEntry = { name: string; bytes: Uint8Array<ArrayBuffer> }

export class TarError extends Error {
  override name = 'TarError'
}

/** 書き出し: entries を tar のバイト列の断片にする（そのまま Blob にできる）。名前は ASCII で 100 バイトまで */
export function tarParts(entries: readonly TarEntry[]): Uint8Array<ArrayBuffer>[] {
  const parts: Uint8Array<ArrayBuffer>[] = []
  for (const entry of entries) {
    parts.push(header(entry.name, entry.bytes.length), entry.bytes)
    const padding = (BLOCK - (entry.bytes.length % BLOCK)) % BLOCK
    if (padding > 0) parts.push(new Uint8Array(padding))
  }
  // 終わりの印（0 のブロック 2 つ）
  parts.push(new Uint8Array(BLOCK * 2))
  return parts
}

function header(name: string, size: number): Uint8Array<ArrayBuffer> {
  if (!/^[\x21-\x7e]{1,100}$/.test(name)) throw new TarError(`tar に入れられない名前です: ${name}`)
  const block = new Uint8Array(BLOCK)
  const put = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) block[offset + i] = text.charCodeAt(i)
  }
  put(0, name)
  put(100, '0000644\0')
  put(108, '0000000\0')
  put(116, '0000000\0')
  put(124, size.toString(8).padStart(11, '0') + '\0')
  put(136, '00000000000\0')
  put(156, '0')
  put(257, 'ustar\x0000')
  // 見出しの合計（チェックサムの欄は空白 8 つとして数える）
  put(148, '        ')
  const sum = block.reduce((total, byte) => total + byte, 0)
  put(148, sum.toString(8).padStart(6, '0') + '\0 ')
  return block
}

/**
 * 読み込み: next() が返すバイト列（展開した tar）を順に読み、普通のファイルを全部返す。
 * check(name, size) は中身を読む前に呼ばれ、受け付けない名前や大きさなら例外を投げる（中身を読まずに止められる）。
 * 終わりの印のあとは 0 だけでなければならない（書き換えた跡や、別のものをつないだファイルを弾く）。
 */
export async function readTar(
  next: () => Promise<Uint8Array | null>,
  check: (name: string, size: number) => void,
): Promise<TarEntry[]> {
  const input = new ChunkReader(next)
  const entries: TarEntry[] = []
  for (;;) {
    const block = await input.read(BLOCK)
    if (block === null) throw new TarError('tar の終わりの印がありません（途中で切れています）')
    if (block.every((byte) => byte === 0)) break
    const { name, size } = parseHeader(block)
    check(name, size)
    const bytes = await input.read(size)
    if (bytes === null) throw new TarError(`${name}: 中身が途中で切れています`)
    const padding = (BLOCK - (size % BLOCK)) % BLOCK
    if (padding > 0 && (await input.read(padding)) === null) throw new TarError(`${name}: 中身が途中で切れています`)
    entries.push({ name, bytes })
  }
  // 終わりの印の残り（とブロックの詰め物）は 0 だけ
  for (;;) {
    const chunk = await input.rest()
    if (chunk === null) break
    if (!chunk.every((byte) => byte === 0)) throw new TarError('tar の終わりの印のあとに中身があります')
  }
  return entries
}

function parseHeader(block: Uint8Array): { name: string; size: number } {
  const text = (offset: number, length: number) => {
    let end = offset
    while (end < offset + length && block[end] !== 0) end++
    return String.fromCharCode(...block.subarray(offset, end))
  }
  const stored = octal(block.subarray(148, 156), 'チェックサム')
  let sum = 0
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : block[i]
  if (stored !== sum) throw new TarError('tar の見出しが壊れています（チェックサムが合いません）')

  const magic = text(257, 6)
  if (magic !== 'ustar' && magic !== 'ustar ') throw new TarError('tar（ustar）の見出しではありません')
  const typeflag = block[156]
  const prefix = magic === 'ustar' ? text(345, 155) : ''
  const name = prefix === '' ? text(0, 100) : `${prefix}/${text(0, 100)}`
  // 0 と NUL が普通のファイル。ディレクトリ・リンク・拡張の見出しなどは扱わない
  if (typeflag !== 0x30 && typeflag !== 0) throw new TarError(`普通のファイルでない項目があります: ${name}`)
  return { name, size: octal(block.subarray(124, 136), `${name} の大きさ`) }
}

/** 8 進の数字の欄（前の空白・0、後ろの NUL・空白を許す）。base-256 の大きな数は扱わない */
function octal(field: Uint8Array, label: string): number {
  const text = String.fromCharCode(...field).replace(/[\0 ]+$/, '').replace(/^ +/, '')
  if (!/^[0-7]{1,12}$/.test(text)) throw new TarError(`tar の見出しの ${label} が読めません`)
  return parseInt(text, 8)
}

/** 細切れに届くバイト列から、決まった長さずつ取り出す */
class ChunkReader {
  private chunks: Uint8Array[] = []
  private buffered = 0
  private done = false
  private readonly next: () => Promise<Uint8Array | null>

  constructor(next: () => Promise<Uint8Array | null>) {
    this.next = next
  }

  private async pull(): Promise<boolean> {
    if (this.done) return false
    const chunk = await this.next()
    if (chunk === null) {
      this.done = true
      return false
    }
    if (chunk.length > 0) {
      this.chunks.push(chunk)
      this.buffered += chunk.length
    }
    return true
  }

  /** ちょうど length バイト。届く前に終わったら null */
  async read(length: number): Promise<Uint8Array<ArrayBuffer> | null> {
    while (this.buffered < length) {
      if (!(await this.pull())) return null
    }
    const out = new Uint8Array(length)
    let filled = 0
    while (filled < length) {
      const chunk = this.chunks[0]
      const take = Math.min(chunk.length, length - filled)
      out.set(chunk.subarray(0, take), filled)
      filled += take
      if (take === chunk.length) this.chunks.shift()
      else this.chunks[0] = chunk.subarray(take)
    }
    this.buffered -= length
    return out
  }

  /** 残りを届いた順に。もうなければ null */
  async rest(): Promise<Uint8Array | null> {
    if (this.chunks.length === 0 && !(await this.pull())) return null
    const chunk = this.chunks.shift()
    if (chunk === undefined) return this.rest()
    this.buffered -= chunk.length
    return chunk
  }
}
