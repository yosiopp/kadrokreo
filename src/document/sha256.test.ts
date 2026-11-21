import { describe, expect, it } from 'vitest'
import { sha256Hex } from './sha256.ts'

describe('sha256Hex', () => {
  it('決まった値（FIPS 180-4 の例）', () => {
    expect(sha256Hex(new Uint8Array())).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(sha256Hex(new TextEncoder().encode('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(sha256Hex(new TextEncoder().encode('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    )
  })

  it('ブロックの境目（55・56・63・64・65 バイトなど）や大きな入力でも Web Crypto と同じ', async () => {
    const reference = async (bytes: Uint8Array<ArrayBuffer>) =>
      [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((byte) => byte.toString(16).padStart(2, '0')).join('')
    for (const length of [1, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000, 70_000]) {
      const bytes = Uint8Array.from({ length }, (_, i) => (i * 31 + 7) & 255)
      expect(sha256Hex(bytes)).toBe(await reference(bytes))
    }
    // 別の Uint8Array の一部（byteOffset が 0 でない）でも、見えている範囲だけを計算する
    const whole = Uint8Array.from({ length: 300 }, (_, i) => i & 255)
    const part = whole.subarray(10, 210)
    expect(sha256Hex(part)).toBe(await reference(part.slice()))
  })
})
