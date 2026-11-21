import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readTar, tarParts } from '../src/document/tar.ts'

// kdr の tar（src/document/tar.ts）と tar コマンドの行き来。子プロセスとファイルを使うので、Node の型がある cli/ に置いている
describe('tar コマンドとの行き来', () => {
  const text = (value: string) => new TextEncoder().encode(value)

  it('書いたものは tar コマンドで取り出せ、tar コマンドで作ったもの（ustar）も読める', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kdr-tar-'))
    const written = join(dir, 'a.tar')
    writeFileSync(written, new Uint8Array(await new Blob(tarParts([{ name: 'document.json', bytes: text('こんにちは') }])).arrayBuffer()))
    expect(execFileSync('tar', ['-xOf', written, 'document.json'], { encoding: 'utf8' })).toBe('こんにちは')

    writeFileSync(join(dir, 'hello.txt'), 'hello')
    const made = join(dir, 'b.tar')
    execFileSync('tar', ['--format', 'ustar', '-cf', made, '-C', dir, 'hello.txt'])
    const bytes: Uint8Array = readFileSync(made)
    let done = false
    const entries = await readTar(async () => {
      if (done) return null
      done = true
      return bytes
    }, () => {})
    expect(entries).toEqual([{ name: 'hello.txt', bytes: text('hello') }])
  })
})
