#!/usr/bin/env node
// ブラウザを使わずに、純粋な関数だけの時間を測る（npm run bench が使う）。
//   node cli/bench/pure.ts --nodes 2000 --depth 4 --instances 170 --images 10
// 結果は JSON で標準出力に出す。画面の描き直しを含む時間は bench/run.mjs が Chrome で測る。
import { decodeKdr } from '../../src/document/kdr.ts'
import { layerRows } from '../../src/document/layers.ts'
import type { DesignDocument, Page } from '../../src/document/types.ts'
import { syncComponents } from '../../src/editor/components.ts'
import { encodeKdr } from '../../src/editor/exportKdr.ts'
import { updatePage } from '../../src/editor/operations/document.ts'
import { setFill } from '../../src/editor/operations/paints.ts'
import { translateNodes } from '../../src/editor/operations/transform.ts'
import { createEditorStore } from '../../src/editor/store.ts'
import { inspectPage, summarizePage } from '../../src/viewer/summary.ts'
import { fitTextEstimated } from '../textMeasure.ts'
import { makeBenchDocument, parseOptions } from './makeKdr.ts'

export type Timing = { median: number; p90: number; runs: number }

/** fn を warmup 回まわしてから runs 回測る（ミリ秒） */
export async function time(fn: () => unknown, runs = 30, warmup = 5): Promise<Timing> {
  for (let i = 0; i < warmup; i++) await fn()
  const samples: number[] = []
  for (let i = 0; i < runs; i++) {
    const start = performance.now()
    await fn()
    samples.push(performance.now() - start)
  }
  samples.sort((a, b) => a - b)
  const pick = (ratio: number) => Number(samples[Math.min(samples.length - 1, Math.floor(samples.length * ratio))].toFixed(3))
  return { median: pick(0.5), p90: pick(0.9), runs }
}

export async function runPureBench(document: DesignDocument, meta: ReturnType<typeof makeBenchDocument>['meta']) {
  const page = document.pages[0]
  const onPage = (recipe: (page: Page) => Page) => (doc: DesignDocument) => updatePage(doc, page.id, recipe)
  const dragTargetId = page.rootIds[0]
  // 毎回別のドキュメントにする（同じ参照だと、合っていたドキュメントの覚え書きで同期が飛ばされる）
  let step = 0
  const moved = () => onPage((scene) => translateNodes(scene, [dragTargetId], ++step % 2 === 0 ? 1 : -1, 0))(document)
  let flip = false
  const recolored = () => {
    flip = !flip
    return onPage((scene) => setFill(scene, [meta.mainRectId], flip ? '#fde68a' : '#f8fafc'))(document)
  }
  const bytes = new Uint8Array(await (await encodeKdr(document)).arrayBuffer())
  const store = createEditorStore(document, fitTextEstimated)
  let x = 0

  return {
    // kdr のバイト列からメモリ上の形まで（展開・JSON の解析・検証）
    decodeKdr: await time(() => decodeKdr(new Blob([bytes])), 10, 2),
    // 合っているドキュメントの同期（同じ参照なので、覚え書きで飛ばす）
    syncComponentsNoop: await time(() => syncComponents(document, fitTextEstimated)),
    // 元に関係ない変更（長方形を 1 つ動かした）のあとの同期。長方形を動かす時間を含む
    syncComponentsUnrelated: await time(() => syncComponents(moved(), fitTextEstimated)),
    // 元の色を変えたあとの同期（全インスタンスの rebuild）
    syncComponentsMainChanged: await time(() => syncComponents(recolored(), fitTextEstimated), 10, 2),
    // ストアに変更を 1 つ通す時間（上書きを覚える・並べ直し・同期をまとめた settle を含む）
    storeApplyUnrelated: await time(() => {
      x = 1 - x
      store.apply(() => translateNodes(store.getState().page, [dragTargetId], x === 1 ? 1 : -1, 0))
    }),
    // ドラッグ中の 1 回分（preview）
    storePreviewMove: await time(() => {
      x++
      store.preview((base) => translateNodes(base, [dragTargetId], x, 0))
    }),
    // レイヤー一覧の行（フレームは開き、インスタンスは閉じた状態）
    layerRows: await time(() => layerRows(page, { toggled: new Set(), held: new Set() })),
    // viewer の一覧（色・文字・影）の集計と、パネルに出す形にするまで
    summarizePage: await time(() => summarizePage(page)),
    inspectPage: await time(() => inspectPage(page)),
  }
}

if (import.meta.main) {
  const { options } = parseOptions(process.argv.slice(2))
  const { document, meta } = makeBenchDocument(options)
  console.log(JSON.stringify({ meta, timings: await runPureBench(document, meta) }, null, 2))
}
