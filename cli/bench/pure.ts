#!/usr/bin/env node
// ブラウザを使わずに、純粋な関数だけの時間を測る（npm run bench が使う）。
//   node cli/bench/pure.ts --nodes 2000 --depth 4 --instances 170 --images 10
// 結果は JSON で標準出力に出す。画面の描き直しを含む時間は bench/run.mjs が Chrome で測る。
import { decodeKdr, parseKdr, readKdrArchive } from '../../src/document/kdr.ts'
import { layerRows } from '../../src/document/layers.ts'
import type { DesignDocument, Page } from '../../src/document/types.ts'
import { syncComponents } from '../../src/editor/components.ts'
import { encodeKdr } from '../../src/editor/exportKdr.ts'
import { updatePage } from '../../src/editor/operations/document.ts'
import { setFill } from '../../src/editor/operations/paints.ts'
import { translateNodes } from '../../src/editor/operations/transform.ts'
import { createEditorStore } from '../../src/editor/store.ts'
import { createBooleanNode } from '../../src/editor/operations/booleanNodes.ts'
import { path, sceneOf } from '../../src/document/testNodes.ts'
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

/** 頂点の多いぎざぎざの円（直線だけのパス）。2,000 頂点 2 つの合体で数十 ms かかる */
function jagged(id: string, x: number, n = 2000) {
  return path({
    id,
    name: id,
    x,
    width: 216,
    height: 216,
    closed: true,
    fills: [{ type: 'solid', color: '#64748b', opacity: 1, visible: true, blendMode: 'normal' }],
    strokes: [],
    points: Array.from({ length: n }, (_, i) => {
      const a = (i / n) * Math.PI * 2
      const r = i % 2 ? 108 : 100
      return { x: (108 + r * Math.cos(a)) / 216, y: (108 + r * Math.sin(a)) / 216 }
    }),
  })
}

/** 頂点の多い形 2 つのドキュメント。boolean なら合体の演算のノードにまとめる */
function jaggedDocument(boolean: boolean): DesignDocument {
  const scene = sceneOf(jagged('a', 0), jagged('b', 80))
  const page = boolean ? createBooleanNode(scene, ['a', 'b'], 'union').scene : scene
  return { name: 'boolean', pages: [{ ...page, id: 'p', name: 'P' }], assets: {}, fonts: [] }
}

/** ブーリアン演算のノードの子のドラッグ（ストアの preview 1 回）と、離したとき（preview と確定）。比べるために演算のない同じ形も */
export async function runBooleanBench() {
  const booleanStore = createEditorStore(jaggedDocument(true))
  const plainStore = createEditorStore(jaggedDocument(false))
  const releaseStore = createEditorStore(jaggedDocument(true))
  let x = 0
  const step = () => (++x % 2 === 0 ? 3 : -3)
  const dx = { boolean: 0, plain: 0 }
  return {
    storePreviewPlainShape: await time(() => {
      dx.plain += step()
      plainStore.preview((base) => translateNodes(base, ['b'], dx.plain, 0))
    }),
    storePreviewBooleanChild: await time(() => {
      dx.boolean += step()
      booleanStore.preview((base) => translateNodes(base, ['b'], dx.boolean, 0))
    }),
    storeReleaseBooleanChild: await time(() => {
      releaseStore.preview((base) => translateNodes(base, ['b'], step(), 0))
      releaseStore.commitPreview()
    }, 10, 2),
  }
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
  const archive = await readKdrArchive(new Blob([bytes]))
  const store = createEditorStore(document, fitTextEstimated)
  const recolorStore = createEditorStore(document, fitTextEstimated)
  let x = 0
  let recolor = false

  return {
    // kdr のバイト列からメモリ上の形まで（展開・JSON の解析・検証）
    decodeKdr: await time(() => decodeKdr(new Blob([bytes])), 10, 2),
    // そのうち、展開して JSON にしたものの検証と組み直し
    parseKdr: await time(() => parseKdr(archive.document, archive.assets)),
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
    // 元の色を変える 1 回（上書きを覚える・並べ直し・同期をまとめた settle を含む）
    storeApplyMainChanged: await time(() => {
      recolor = !recolor
      recolorStore.apply(() => setFill(recolorStore.getState().page, [meta.mainRectId], recolor ? '#fde68a' : '#f8fafc'))
    }, 10, 2),
    // レイヤー一覧の行（フレームは開き、インスタンスは閉じた状態）
    layerRows: await time(() => layerRows(page, { toggled: new Set(), held: new Set() })),
    // viewer の一覧（色・文字・影）の集計と、パネルに出す形にするまで
    summarizePage: await time(() => summarizePage(page)),
    inspectPage: await time(() => inspectPage(page)),
    ...(await runBooleanBench()),
  }
}

if (import.meta.main) {
  const { options } = parseOptions(process.argv.slice(2))
  const { document, meta } = makeBenchDocument(options)
  console.log(JSON.stringify({ meta, timings: await runPureBench(document, meta) }, null, 2))
}
