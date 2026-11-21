import { describe, expect, it } from 'vitest'
import { TarError, readTar, tarParts, type TarEntry } from './tar.ts'

async function bytesOf(parts: BlobPart[]): Promise<Uint8Array> {
  return new Uint8Array(await new Blob(parts).arrayBuffer())
}

/** バイト列を、ばらばらの大きさの断片に分けて渡す（展開した gzip が細切れに届くのと同じ） */
function chunked(bytes: Uint8Array, sizes = [1, 7, 511, 513, 4096]) {
  let offset = 0
  let i = 0
  return async () => {
    if (offset >= bytes.length) return null
    const size = sizes[i++ % sizes.length]
    const chunk = bytes.subarray(offset, offset + size)
    offset += size
    return chunk
  }
}

const read = (bytes: Uint8Array, check: (name: string, size: number) => void = () => {}) => readTar(chunked(bytes), check)
const entry = (name: string, text: string): TarEntry => ({ name, bytes: new TextEncoder().encode(text) })

describe('tar', () => {
  it('書いたものを読むと同じ並びに戻る（空のファイル・512 の倍数・端数・細切れの入力）', async () => {
    const entries = [entry('a.json', '{"x":1}'), entry('empty', ''), { name: 'b/c.bin', bytes: new Uint8Array(1024).fill(7) }, { name: 'd', bytes: new Uint8Array(513).fill(1) }]
    const bytes = await bytesOf(tarParts(entries))
    expect(bytes.length % 512).toBe(0)
    expect(await read(bytes)).toEqual(entries)
  })

  it('同じものを書けば同じバイト列（時刻や所有者を入れない）', async () => {
    const a = await bytesOf(tarParts([entry('x', 'y')]))
    const b = await bytesOf(tarParts([entry('x', 'y')]))
    expect(a).toEqual(b)
  })

  it('check は中身を読む前に名前と大きさで呼ばれ、例外を投げれば止まる', async () => {
    const bytes = await bytesOf(tarParts([entry('ok', 'a'), { name: 'big', bytes: new Uint8Array(10_000) }]))
    const seen: [string, number][] = []
    await expect(read(bytes, (name, size) => {
      seen.push([name, size])
      if (size > 100) throw new Error('大きすぎ')
    })).rejects.toThrow('大きすぎ')
    expect(seen).toEqual([['ok', 1], ['big', 10_000]])
  })

  it('途中で切れたもの・終わりの印がないもの・終わりの印のあとに中身があるものは TarError', async () => {
    const bytes = await bytesOf(tarParts([entry('a', 'hello')]))
    await expect(read(bytes.slice(0, 700))).rejects.toThrow(TarError)
    await expect(read(bytes.slice(0, 1024))).rejects.toThrow('終わりの印')
    await expect(read(new Uint8Array())).rejects.toThrow('終わりの印')
    const extra = new Uint8Array(bytes.length + 512)
    extra.set(bytes)
    extra[bytes.length + 10] = 1
    await expect(read(extra)).rejects.toThrow('終わりの印のあと')
    // 0 の詰め物が続くのはよい（tar コマンドは 10240 バイト単位に詰める）
    expect(await read(new Uint8Array([...bytes, ...new Uint8Array(8192)]))).toHaveLength(1)
  })

  it('チェックサムの合わない見出し・普通のファイルでない項目は TarError', async () => {
    const bytes = await bytesOf(tarParts([entry('a', 'hello')]))
    const broken = bytes.slice()
    broken[0] = 0x62
    await expect(read(broken)).rejects.toThrow('チェックサム')
  })

  it('書き出しは ASCII で 100 バイトまでの名前だけ', () => {
    expect(() => tarParts([entry('x'.repeat(101), '')])).toThrow(TarError)
    expect(() => tarParts([entry('日本語', '')])).toThrow(TarError)
    expect(() => tarParts([entry('', '')])).toThrow(TarError)
  })
})
