#!/usr/bin/env node
// kdr を開くときのメモリを測る（npm run bench が、1 回ごとに新しいプロセスで呼ぶ）。
//   node --expose-gc cli/bench/memory.ts big.kdr
// ファイルのバイト列を読み終えた時点を基準に、decodeKdr の途中の最大の RSS（maxRSS の増分）と、
// 読み終えて GC したあとに残る量（JS のヒープ + ArrayBuffer などの外のメモリ）を MB で出す。
// ブラウザと同じ decodeKdr（展開・解析・検証）を Node で動かしたもの。画像を描くための展開（ImageBitmap）は含まない。
import { readFileSync } from 'node:fs'
import { decodeKdr } from '../../src/document/kdr.ts'

const MB = 1024 * 1024
const gc = (globalThis as { gc?: () => void }).gc
if (gc === undefined) throw new Error('node --expose-gc で動かしてください')

const path = process.argv[2]
if (path === undefined) throw new Error('kdr のパスを渡してください')

/** 1 回の gc() では、ストリームの後始末などが残ることがあるので、間を空けて何度か回す */
async function collect() {
  for (let i = 0; i < 4; i++) {
    gc!()
    await new Promise((resolve) => setImmediate(resolve))
  }
}

const file = new Blob([readFileSync(path)])
await collect()
const retained = () => {
  const usage = process.memoryUsage()
  return usage.heapUsed + usage.external
}
const baseRss = process.resourceUsage().maxRSS * 1024
const baseRetained = retained()
const start = performance.now()
const document = await decodeKdr(file)
const elapsed = performance.now() - start
const peakRss = process.resourceUsage().maxRSS * 1024
await collect()
const kept = retained()
console.log(
  JSON.stringify({
    ms: Number(elapsed.toFixed(1)),
    peakMB: Number(((peakRss - baseRss) / MB).toFixed(1)),
    retainedMB: Number(((kept - baseRetained) / MB).toFixed(1)),
    assets: Object.keys(document.assets).length,
  }),
)
