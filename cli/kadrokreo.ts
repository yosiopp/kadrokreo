#!/usr/bin/env node
// kadrokreo のコマンドライン。Node 24 以降で、TypeScript のまま実行する（型を取り除くだけで動く書き方にしてある）。
//   ./cli/kadrokreo.ts --help
// package.json の bin で kdr（短い名前）と kadrokreo の 2 つの名前を付けている。npm link すると、どちらでも呼べる
import { readFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { KDR_MAX_BYTES } from '../src/document/kdr.ts'
import { run } from './run.ts'

/** 圧縮された kdr でも、展開後の上限より大きいものは読まない */
const MAX_INPUT_BYTES = KDR_MAX_BYTES

async function readLimited(path: string): Promise<Uint8Array<ArrayBuffer>> {
  const data = await readFile(path)
  if (data.byteLength > MAX_INPUT_BYTES) throw new Error(`${path}: ファイルが大きすぎます`)
  return new Uint8Array(data)
}

/** 標準入力も、ファイルと同じ大きさまでしか読まない（kdr もマークアップも） */
async function readStdinLimited(): Promise<Uint8Array<ArrayBuffer>> {
  const chunks: Uint8Array[] = []
  let total = 0
  for await (const chunk of process.stdin as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength
    if (total > MAX_INPUT_BYTES) throw new Error('標準入力が大きすぎます')
    chunks.push(chunk)
  }
  const data = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    data.set(chunk, at)
    at += chunk.byteLength
  }
  return data
}

const argv = process.argv.slice(2)
// kdr mcp は常駐して、標準入出力で MCP の要求を受ける（cli/mcp.ts）。引数は取らない
if (argv[0] === 'mcp' && argv.length === 1) {
  const { serve } = await import('./mcp.ts')
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
  await serve({ readFile: readLimited, writeFile: (path, data) => writeFile(path, data) }, version)
} else {
  process.exitCode = await run(argv, {
    readFile: readLimited,
    writeFile: (path, data) => writeFile(path, data),
    readStdin: readStdinLimited,
    stdinIsTTY: process.stdin.isTTY === true,
    stdoutIsTTY: process.stdout.isTTY === true,
    stdout: (data) => {
      process.stdout.write(data)
    },
    stderr: (text) => {
      process.stderr.write(text)
    },
  })
}
