#!/usr/bin/env node
// kadrokreo のコマンドライン。Node 24 以降で、TypeScript のまま実行する（型を取り除くだけで動く書き方にしてある）。
//   ./cli/kadrokreo.ts --help
// package.json の bin で kdr（短い名前）と kadrokreo の 2 つの名前を付けている。npm link すると、どちらでも呼べる
import { readFile, writeFile } from 'node:fs/promises'
import { buffer } from 'node:stream/consumers'
import { KDR_MAX_BYTES } from '../src/document/kdr.ts'
import { run } from './run.ts'

/** 圧縮された kdr でも、展開後の上限より大きいものは読まない */
const MAX_INPUT_BYTES = KDR_MAX_BYTES

async function readLimited(path: string): Promise<Uint8Array<ArrayBuffer>> {
  const data = await readFile(path)
  if (data.byteLength > MAX_INPUT_BYTES) throw new Error(`${path}: ファイルが大きすぎます`)
  return new Uint8Array(data)
}

const code = await run(process.argv.slice(2), {
  readFile: readLimited,
  writeFile: (path, data) => writeFile(path, data),
  readStdin: async () => new Uint8Array(await buffer(process.stdin)),
  stdinIsTTY: process.stdin.isTTY === true,
  stdoutIsTTY: process.stdout.isTTY === true,
  stdout: (data) => {
    process.stdout.write(data)
  },
  stderr: (text) => {
    process.stderr.write(text)
  },
})
process.exitCode = code
