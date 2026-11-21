import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { renderScene } from '../canvas/render.ts'
import { measureText } from '../canvas/text.ts'
import { getContentBounds } from '../document/geometry.ts'
import { KDR_VERSION, KdrError, MAX_DEPTH, decodeKdr, kdrFile, parseKdr } from '../document/kdr.ts'
import type { DesignDocument } from '../document/types.ts'
import { inspectNode, inspectSelection, nodeCss } from '../viewer/inspect.ts'
import { nodeCode, nodeMarkup } from '../viewer/markup.ts'
import { inspectPage, summarizePage } from '../viewer/summary.ts'
import { syncComponents } from './components.ts'

// kdr の読み込みのファズテスト。viewer は外から受け取った kdr を開くので、どんな入力でも
// 「KdrError になる」か「正しく読めて、描画・インスペクト・書き出し直しまで落ちない」かのどちらかになることを確かめる。
// 乱数は種を固定した自前のもの（mulberry32）なので、落ちたら同じ種で再現できる。

/** 種を固定した乱数。0 以上 1 未満を返す */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Random = ReturnType<typeof makeRandom>

function makeRandom(seed: number) {
  const next = mulberry32(seed)
  const int = (min: number, max: number) => min + Math.floor(next() * (max - min + 1))
  const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)]
  const chance = (p: number) => next() < p
  return { next, int, pick, chance }
}

// ---- 偽の Canvas ----
// 本物の Canvas が例外を投げる呼び方（WebIDL の double に Infinity / NaN、負の半径）では同じように投げる。
// それ以外の呼び出しは何もしない

function finite(name: string, ...values: number[]) {
  if (values.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
    throw new TypeError(`${name}: 有限の数ではありません`)
  }
}

function fakeMatrix(a = 1, b = 0, c = 0, d = 1, e = 0, f = 0) {
  return {
    a, b, c, d, e, f,
    inverse() {
      const det = a * d - b * c
      return fakeMatrix(d / det, -b / det, -c / det, a / det, 0, 0)
    },
  }
}

function fakeContext(): CanvasRenderingContext2D {
  const state: Record<string | symbol, unknown> = { canvas: { width: 800, height: 600 }, font: '10px sans-serif' }
  const methods: Record<string, (...args: never[]) => unknown> = {
    measureText: (text: string) => ({
      width: text.length * 7,
      fontBoundingBoxAscent: 8,
      fontBoundingBoxDescent: 2,
      actualBoundingBoxAscent: 8,
      actualBoundingBoxDescent: 2,
    }),
    getTransform: () => fakeMatrix(),
    createLinearGradient: (...args: number[]) => {
      finite('createLinearGradient', ...args)
      return {
        addColorStop(offset: number, _color: string) {
          finite('addColorStop', offset)
          if (offset < 0 || offset > 1) throw new RangeError('addColorStop: 0〜1 の範囲ではありません')
        },
      }
    },
    roundRect: (_x: number, _y: number, _w: number, _h: number, radius: number) => {
      if (radius < 0) throw new RangeError('roundRect: 負の半径')
    },
    ellipse: (_x: number, _y: number, rx: number, ry: number) => {
      if (rx < 0 || ry < 0) throw new RangeError('ellipse: 負の半径')
    },
    arc: (_x: number, _y: number, r: number) => {
      if (r < 0) throw new RangeError('arc: 負の半径')
    },
  }
  return new Proxy(state, {
    get(target, key) {
      if (typeof key === 'string' && Object.hasOwn(methods, key)) return methods[key]
      if (Object.hasOwn(target, key)) return target[key]
      return () => {}
    },
    set(target, key, value) {
      target[key] = value
      return true
    },
  }) as unknown as CanvasRenderingContext2D
}

beforeAll(() => {
  // 半透明のフレームを合成するキャンバスを作るのに使う
  vi.stubGlobal('document', { createElement: () => ({ getContext: () => fakeContext() }) })
})
afterAll(() => {
  vi.unstubAllGlobals()
})

// ---- 読めたドキュメントを使ってみる ----

/** 読めたドキュメントを、viewer と editor が触る範囲で一通り使う。どれも例外を投げてはいけない */
function exercise(doc: DesignDocument) {
  for (const page of doc.pages) {
    const ctx = fakeContext()
    for (const viewport of [{ x: 0, y: 0, zoom: 1 }, { x: -1e6, y: -1e6, zoom: 1e-4 }]) {
      renderScene(ctx, page, doc.assets, viewport, { width: 800, height: 600 }, 2, { labelColor: '#000000' })
    }
    getContentBounds(page)
    summarizePage(page)
    inspectPage(page)
    // 全部のノードを調べると大きな入力で遅くなるので、先頭の何個かだけ
    for (const id of Object.keys(page.nodes).slice(0, 20)) {
      inspectNode(doc, page, id)
      inspectSelection(page, [id])
      nodeCss(page, id)
      for (const format of ['html', 'react', 'css-modules', 'tailwind'] as const) nodeCode(page, id, { format })
    }
    for (const id of page.rootIds.slice(0, 5)) nodeMarkup(page, id, { assets: doc.assets, images: 'embed' })
    if (page.rootIds.length > 1) inspectSelection(page, page.rootIds.slice(0, 20))
  }

  // 書き出して読み直すと同じものになる（-0 は JSON で 0 になるので、書き出した JSON どうしで比べる）
  const json = JSON.stringify(kdrFile(doc))
  expect(JSON.stringify(kdrFile(parseKdr(JSON.parse(json))))).toBe(json)
  // editor で開くと、インスタンスを元に合わせて作り直してから自動保存する。それも読み直せなければならない
  const synced = syncComponents(doc)
  parseKdr(JSON.parse(JSON.stringify(kdrFile(synced))))
}

/** parseKdr を呼び、KdrError 以外の例外を出さないことと、読めたら使えることを確かめる */
function parseOrReject(value: unknown): 'ok' | 'error' {
  let doc: DesignDocument
  try {
    doc = parseKdr(value)
  } catch (error) {
    if (error instanceof KdrError) return 'error'
    throw error
  }
  exercise(doc)
  return 'ok'
}

// ---- ランダムなドキュメント ----

const ID_POOL = ['a', 'b', 'n1', 'constructor', 'toString', 'hasOwnProperty', 'valueOf', '__proto__', 'x'.repeat(64), 'x'.repeat(65), '', 'p1']
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

/** JSON で表せる極端な値。NaN / Infinity は JSON にないので、文字列の段階で別に差し込む */
const EXTREMES: unknown[] = [
  0, -0, 1, -1, 0.5, 2, 100, 400, 900, 1e21, 1e308, -1e308, Number.MAX_SAFE_INTEGER, 5e-324, 2 ** 31, -(2 ** 53),
  '', 'x', '#ff0000', '#FFF', '#gggggg', 'rect', 'frame', 'text', 'path', 'image', 'ellipse', 'hug', 'fill', 'fixed',
  'main', 'instance', 'linear', 'solid', 'drop-shadow', 'absolute', 'vertical', 'space-between', 'arrow', 'a\n'.repeat(50),
  '__proto__', 'constructor', 'toString', true, false, null, [], {}, [1, 2], [[]], { x: 1, y: 2 }, { type: 'solid', color: '#000000' },
]

function randomNumber(r: Random, min: number, max: number): number {
  if (r.chance(0.05)) return r.pick([1e308, -1e308, 1e21, 5e-324, -0, Number.MAX_SAFE_INTEGER]) as number
  return r.int(min, max)
}

function randomPaint(r: Random) {
  if (r.chance(0.6)) return { type: 'solid', color: r.pick(['#ff0000', '#00ff00', '#123456', '#abcdef']) }
  const count = r.int(2, 4)
  const stops = Array.from({ length: count }, (_, i) => ({ offset: i / (count - 1), color: r.pick(['#000000', '#ffffff', '#ff8800']) }))
  return { type: 'linear', angle: randomNumber(r, -720, 720), stops }
}

function randomEffect(r: Random) {
  return {
    type: 'drop-shadow',
    x: randomNumber(r, -20, 20),
    y: randomNumber(r, -20, 20),
    blur: randomNumber(r, 0, 40),
    color: '#000000',
    opacity: r.next(),
  }
}

type Context = { r: Random; counter: number; components: string[]; assets: string[] }

function randomId(c: Context): string {
  return c.r.chance(0.05) ? c.r.pick(ID_POOL) : `n${c.counter++}`
}

function randomNode(c: Context, depth: number): Record<string, unknown> {
  const { r } = c
  const type = depth < 6 && r.chance(0.35) ? 'frame' : r.pick(['rect', 'ellipse', 'path', 'text', 'image'])
  const node: Record<string, unknown> = {
    type,
    id: randomId(c),
    name: r.pick(['Box', '', 'レイヤー', 'a'.repeat(200)]),
    x: randomNumber(r, -1000, 1000),
    y: randomNumber(r, -1000, 1000),
    width: randomNumber(r, 0, 500),
    height: randomNumber(r, 0, 500),
  }
  if (r.chance(0.3)) node.rotation = randomNumber(r, -720, 720)
  if (r.chance(0.2)) node.opacity = r.pick([0, 0.5, 1, r.next()])
  if (r.chance(0.1)) node.visible = false
  if (r.chance(0.1)) node.locked = true
  if (r.chance(0.2)) node.minWidth = randomNumber(r, 0, 100)
  if (r.chance(0.2)) node.maxHeight = randomNumber(r, 0, 100)
  if (r.chance(0.2)) node.layoutPositioning = 'absolute'
  if (r.chance(0.2)) {
    const choices = ['start', 'end', 'stretch', 'center', 'scale']
    node.constraints = { horizontal: r.pick(choices), vertical: r.pick(choices) }
  }
  if (type !== 'image' && r.chance(0.6)) node.fills = Array.from({ length: r.int(0, 3) }, () => randomPaint(r))
  if (type !== 'image' && type !== 'text' && r.chance(0.4)) {
    node.strokes = Array.from({ length: r.int(0, 2) }, () => randomPaint(r))
    node.strokeWidth = randomNumber(r, 0, 20)
  }
  if (type !== 'image' && type !== 'text' && r.chance(0.3)) node.effects = Array.from({ length: r.int(0, 3) }, () => randomEffect(r))
  if ((type === 'rect' || type === 'frame' || type === 'image') && r.chance(0.3)) node.cornerRadius = randomNumber(r, 0, 300)

  switch (type) {
    case 'path':
      node.points = Array.from({ length: r.int(2, 6) }, () => {
        const point: Record<string, unknown> = { x: r.next(), y: r.next() }
        // 曲線の制御点（頂点からのずれ）。ときどき極端な値
        if (r.chance(0.4)) point.in = { x: randomNumber(r, -2, 2), y: randomNumber(r, -2, 2) }
        if (r.chance(0.4)) point.out = { x: randomNumber(r, -2, 2), y: randomNumber(r, -2, 2) }
        return point
      })
      if (r.chance(0.3)) node.closed = true
      if (r.chance(0.3)) node.endCap = 'arrow'
      if (r.chance(0.2)) node.startCap = 'arrow'
      break
    case 'text':
      node.text = r.pick(['', 'こんにちは', 'Hello world '.repeat(20), 'a\nb\nc', ' '.repeat(30)])
      node.fontSize = randomNumber(r, 1, 96)
      node.fontFamily = r.pick(['sans-serif', 'Inter', '"; }', ''])
      if (r.chance(0.3)) node.sizing = { width: r.pick(['hug', 'fixed', 'fill']) }
      if (r.chance(0.2)) node.fontWeight = r.pick([100, 400, 700, 900])
      if (r.chance(0.2)) node.textAlign = r.pick(['left', 'center', 'right'])
      if (r.chance(0.2)) node.lineHeight = randomNumber(r, 0, 3)
      break
    case 'image':
      node.assetId = c.assets.length > 0 && r.chance(0.9) ? r.pick(c.assets) : 'missing'
      if (r.chance(0.3)) node.fit = r.pick(['stretch', 'cover', 'contain'])
      break
    case 'frame': {
      if (r.chance(0.4)) {
        node.layout = {
          direction: r.pick(['horizontal', 'vertical']),
          gap: randomNumber(r, -10, 30),
          paddingTop: randomNumber(r, 0, 20),
          align: r.pick(['start', 'center', 'end']),
          justify: r.pick(['start', 'center', 'end', 'space-between']),
          wrap: r.chance(0.3),
          crossGap: randomNumber(r, 0, 20),
          ...(r.chance(0.3) ? { alignContent: r.pick(['auto', 'space-between']) } : {}),
        }
        if (r.chance(0.5)) node.sizing = { width: r.pick(['hug', 'fixed', 'fill']), height: r.pick(['hug', 'fixed', 'fill']) }
      }
      if (r.chance(0.2)) node.clipContent = false
      if (r.chance(0.3)) {
        const id = r.chance(0.5) && c.components.length > 0 ? r.pick(c.components) : `c${c.counter++}`
        c.components.push(id)
        node.component = r.chance(0.5)
          ? { id, role: 'main' }
          : { id, role: 'instance', ...(r.chance(0.5) ? { overrides: { [r.pick(ID_POOL)]: { text: 'x', visible: false, ...(r.chance(0.5) ? { componentId: r.pick(c.components) } : {}) } } } : {}) }
      }
      const count = r.int(0, 4)
      if (count > 0) node.children = Array.from({ length: count }, () => randomNode(c, depth + 1))
      break
    }
  }
  return node
}

function randomFile(r: Random): Record<string, unknown> {
  const c: Context = { r, counter: 0, components: [], assets: [] }
  const assets: Record<string, unknown> = {}
  for (let i = 0; i < r.int(0, 2); i++) {
    const id = `img${i}`
    assets[id] = { mime: 'image/png', data: PNG }
    c.assets.push(id)
  }
  const pages = Array.from({ length: r.int(1, 3) }, (_, i) => ({
    id: r.chance(0.05) ? 'p1' : `page${i}`,
    name: `Page ${i}`,
    children: Array.from({ length: r.int(0, 5) }, () => randomNode(c, 1)),
  }))
  return { format: 'kadrokreo', version: KDR_VERSION, document: { name: 'fuzz', pages, assets } }
}

// ---- 壊し方 ----

type Slot = { parent: Record<string, unknown> | unknown[]; key: string | number }

/** 木の中の場所（親とキー）を全部集める */
function slotsOf(value: unknown, out: Slot[] = [], seen = new Set<unknown>()): Slot[] {
  if (typeof value !== 'object' || value === null || seen.has(value)) return out
  seen.add(value)
  const entries: [string | number, unknown][] = Array.isArray(value) ? value.map((item, i) => [i, item]) : Object.entries(value)
  for (const [key, item] of entries) {
    out.push({ parent: value as Slot['parent'], key })
    slotsOf(item, out, seen)
  }
  return out
}

function get(slot: Slot): unknown {
  return (slot.parent as Record<string | number, unknown>)[slot.key]
}

function set(slot: Slot, value: unknown) {
  ;(slot.parent as Record<string | number, unknown>)[slot.key] = value
}

/** 木の値を 1 つ壊す。cycles なら本当に循環する参照も作る（JSON にはできない） */
function mutate(r: Random, file: unknown, cycles: boolean) {
  const slots = slotsOf(file)
  if (slots.length === 0) return
  const slot = r.pick(slots)
  switch (r.int(0, 7)) {
    case 0:
    case 1:
      set(slot, structuredClone(r.pick(EXTREMES)))
      break
    case 2:
      if (Array.isArray(slot.parent)) slot.parent.splice(slot.key as number, 1)
      else delete slot.parent[slot.key as string]
      break
    case 3: {
      // 別の場所の値を写す（同じ id のノードが 2 つ、型の違う項目などができる）
      const other = get(r.pick(slots))
      set(slot, cycles && r.chance(0.5) ? other : structuredClone(other))
      break
    }
    case 4: {
      // 配列なら要素を増やす
      const value = get(slot)
      if (Array.isArray(value) && value.length > 0) value.push(structuredClone(r.pick(value)))
      break
    }
    case 5: {
      // 数値を数値のまま極端にする
      const value = get(slot)
      if (typeof value === 'number') set(slot, r.pick([value * 1e300, -value, value + 0.5, 1e308, 5e-324, NaN, Infinity]))
      break
    }
    case 6:
      if (cycles) {
        // 祖先（ファイル全体）を中に入れる
        set(slot, file)
      } else {
        set(slot, { children: [get(slot)] })
      }
      break
    case 7: {
      // 知らない項目を足す
      const value = get(slot)
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        ;(value as Record<string, unknown>)[r.pick(['extra', '__proto__', 'constructor', 'children', 'parentId'])] = r.pick(EXTREMES)
      }
      break
    }
  }
}

/** JSON の文字列を壊す。数値を NaN や 1e999 に置き換える、文字を消す・足す、途中で切る */
function mutateText(r: Random, text: string): string {
  switch (r.int(0, 4)) {
    case 0: {
      const numbers = [...text.matchAll(/-?\d+(\.\d+)?(e[+-]?\d+)?/g)]
      if (numbers.length === 0) return text
      const found = r.pick(numbers)
      const replacement = r.pick(['1e999', '-1e999', '1e-999', 'NaN', 'Infinity', '00', '1.', '9'.repeat(400)])
      return text.slice(0, found.index) + replacement + text.slice(found.index! + found[0].length)
    }
    case 1: {
      const at = r.int(0, text.length)
      return text.slice(0, at) + text.slice(at + r.int(1, 5))
    }
    case 2: {
      const at = r.int(0, text.length)
      return text.slice(0, at) + r.pick(['{', '}', '[', ']', ',', '"', ':', '\\', '\u0000', '\ud800']) + text.slice(at)
    }
    case 3:
      return text.slice(0, r.int(0, text.length))
    default: {
      // 重複したキー（JSON.parse は後のものを採る）
      return text.replace(/"id":"([^"]*)"/, (whole) => `${whole},"id":${r.pick(['"a"', '1', 'null', '"__proto__"'])}`)
    }
  }
}

async function gzip(data: string | Uint8Array): Promise<Blob> {
  return new Response(new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'))).blob()
}

async function decodeOrReject(blob: Blob, maxBytes?: number): Promise<'ok' | 'error'> {
  let doc: DesignDocument
  try {
    doc = await decodeKdr(blob, maxBytes === undefined ? {} : { maxBytes })
  } catch (error) {
    if (error instanceof KdrError) return 'error'
    throw error
  }
  exercise(doc)
  return 'ok'
}

// ---- テスト ----

describe('kdr の読み込みのファズテスト', () => {
  it('ランダムに作ったファイルは読めて、描画・インスペクト・書き出し直しができる', () => {
    let ok = 0
    for (let seed = 1; seed <= 300; seed++) {
      const r = makeRandom(seed)
      try {
        if (parseOrReject(randomFile(r)) === 'ok') ok++
      } catch (error) {
        throw new Error(`種 ${seed} で失敗: ${String(error)}`, { cause: error })
      }
    }
    // 生成する値には読めないもの（id の重複、おかしな id など）も少し混ぜているので、全部は読めない
    expect(ok).toBeGreaterThan(100)
  })

  it('木を壊したファイル（型の違う項目・極端な値・重複・循環する参照）は、KdrError になるか、読めて使える', () => {
    const results = { ok: 0, error: 0 }
    for (let seed = 1; seed <= 1500; seed++) {
      const r = makeRandom(seed * 7919)
      const file = randomFile(r)
      const cycles = r.chance(0.2)
      for (let i = r.int(1, 4); i > 0; i--) mutate(r, file, cycles)
      try {
        results[parseOrReject(file)]++
      } catch (error) {
        throw new Error(`種 ${seed * 7919} で失敗: ${String(error)}`, { cause: error })
      }
    }
    expect(results.ok).toBeGreaterThan(50)
    expect(results.error).toBeGreaterThan(50)
  })

  it('文字列を壊した JSON（NaN・1e999・切れた JSON・重複したキー）は、KdrError になるか、読めて使える', async () => {
    for (let seed = 1; seed <= 400; seed++) {
      const r = makeRandom(seed * 104729)
      let text = JSON.stringify(randomFile(r))
      for (let i = r.int(1, 3); i > 0; i--) text = mutateText(r, text)
      try {
        await decodeOrReject(await gzip(text))
      } catch (error) {
        throw new Error(`種 ${seed * 104729} で失敗: ${String(error)}`, { cause: error })
      }
    }
  })

  it('gzip でないもの・壊れた gzip・空のファイル・UTF-8 でない中身は KdrError になる', async () => {
    const r = makeRandom(42)
    const valid = new Uint8Array(await (await gzip(JSON.stringify(randomFile(r)))).arrayBuffer())
    const inputs: Blob[] = [new Blob([]), new Blob(['{}']), await gzip(new Uint8Array([0xff, 0xfe, 0xfd])), await gzip('')]
    for (let i = 0; i < 50; i++) {
      const bytes = Uint8Array.from({ length: r.int(1, 200) }, () => r.int(0, 255))
      inputs.push(new Blob([bytes]))
      const broken = valid.slice(0, r.int(0, valid.length - 1))
      if (broken.length > 0) broken[r.int(0, broken.length - 1)] ^= 0xff
      inputs.push(new Blob([broken]))
    }
    for (const input of inputs) expect(await decodeOrReject(input)).toBe('error')
  })

  it('展開すると上限を超えるファイルは、展開の途中で KdrError になる', async () => {
    const bomb = await gzip(new Uint8Array(4 * 1024 * 1024))
    expect(bomb.size).toBeLessThan(64 * 1024)
    await expect(decodeKdr(bomb, { maxBytes: 1024 * 1024 })).rejects.toThrow(KdrError)
  })
})

describe('kdr の読み込みの極端な入力', () => {
  /** フレームを depth 段入れ子にしたファイルの JSON。JSON.stringify は再帰するので、文字列を自分で組む */
  function nestedFramesJson(depth: number): string {
    const open = (i: number) => `{"type":"frame","id":"f${i}","name":"F","x":0,"y":0,"width":10,"height":10,"children":[`
    let text = ''
    for (let i = 0; i < depth; i++) text += open(i)
    text += ']}'.repeat(depth)
    return `{"format":"kadrokreo","version":${KDR_VERSION},"document":{"name":"x","assets":{},"pages":[{"id":"p","name":"P","children":[${text}]}]}}`
  }

  it(`フレームの入れ子は ${MAX_DEPTH} 段まで読めて、それより深いと KdrError になる`, () => {
    expect(parseOrReject(JSON.parse(nestedFramesJson(MAX_DEPTH)))).toBe('ok')
    expect(() => parseKdr(JSON.parse(nestedFramesJson(MAX_DEPTH + 1)))).toThrow(KdrError)
  })

  it('10 万段の入れ子でもスタックが溢れず KdrError になる', async () => {
    const text = nestedFramesJson(100_000)
    expect(() => parseKdr(JSON.parse(text))).toThrow(KdrError)
    expect(await decodeOrReject(await gzip(text))).toBe('error')
  })

  it('ノード以外の場所の深い入れ子（名前・オートレイアウト・上書き・未知の項目）も KdrError になるか読み飛ばす', async () => {
    const deep = '['.repeat(200_000) + ']'.repeat(200_000)
    const deepObject = '{"a":'.repeat(100_000) + '1' + '}'.repeat(100_000)
    const node = (patch: string) =>
      `{"format":"kadrokreo","version":${KDR_VERSION},"document":{"name":"x","assets":{},"pages":[{"id":"p","name":"P","children":[{"type":"frame","id":"f","name":"F","x":0,"y":0,"width":10,"height":10,${patch}}]}]}}`
    expect(await decodeOrReject(await gzip(node(`"name2":${deep}`)))).toBe('ok')
    expect(await decodeOrReject(await gzip(node(`"extra":${deepObject}`)))).toBe('ok')
    // 知らない項目は読み飛ばすので、オートレイアウトや上書きの中の深い入れ子は読める
    expect(await decodeOrReject(await gzip(node(`"layout":${deepObject}`)))).toBe('ok')
    expect(await decodeOrReject(await gzip(node(`"component":{"id":"c","role":"instance","overrides":${deepObject}}`)))).toBe('ok')
    // 知っている項目の型が違えば KdrError
    for (const patch of [`"fills":${deep}`, `"layout":{"gap":${deep}}`, `"component":{"id":"c","role":"instance","overrides":{"a":{"text":${deep}}}}`]) {
      expect(await decodeOrReject(await gzip(node(patch)))).toBe('error')
    }
  })

  it('本当に循環する参照（JSON にはできないが、parseKdr には渡せる）でも止まって KdrError になる', () => {
    const frame: Record<string, unknown> = { type: 'frame', id: 'f', name: 'F', x: 0, y: 0, width: 10, height: 10 }
    frame.children = [frame]
    const file = { format: 'kadrokreo', version: KDR_VERSION, document: { name: 'x', assets: {}, pages: [{ id: 'p', name: 'P', children: [frame] }] } }
    expect(() => parseKdr(file)).toThrow(KdrError)

    // id が毎回違っても、入れ子の上限で止まる
    let count = 0
    const looping = new Proxy(frame, { get: (target, key) => (key === 'id' ? `f${count++}` : target[key as string]) })
    frame.children = [looping]
    expect(() => parseKdr(file)).toThrow(KdrError)
  })

  it('巨大な配列（20 万個の子）を読んで描画できる', () => {
    const children = Array.from({ length: 200_000 }, (_, i) => ({ type: 'rect', id: `r${i}`, name: 'R', x: i, y: 0, width: 1, height: 1 }))
    const file = { format: 'kadrokreo', version: KDR_VERSION, document: { name: 'x', assets: {}, pages: [{ id: 'p', name: 'P', children: [{ type: 'frame', id: 'f', name: 'F', x: 0, y: 0, width: 10, height: 10, children }] }] } }
    expect(parseOrReject(file)).toBe('ok')
  })

  it('行が非常に多いテキスト（30 万行）も大きさを測って描画できる', () => {
    const node = { type: 'text', id: 't', name: 'T', x: 0, y: 0, width: 10, height: 10, text: 'a\n'.repeat(300_000), fontSize: 12, fontFamily: 'sans-serif', sizing: { width: 'hug' } }
    const doc = parseKdr({ format: 'kadrokreo', version: KDR_VERSION, document: { name: 'x', assets: {}, pages: [{ id: 'p', name: 'P', children: [node] }] } })
    const text = doc.pages[0].nodes.t
    if (text.type !== 'text') throw new Error('テキストではない')
    expect(measureText(fakeContext(), text).height).toBeGreaterThan(300_000)
    exercise(doc)
  })

  it('極端に大きい・回ったノードとグラデーションも描画で落ちない', () => {
    const big = 1e308
    const gradient = { type: 'linear', angle: 45, stops: [{ offset: 0, color: '#000000' }, { offset: 1, color: '#ffffff' }] }
    const children = [
      { type: 'rect', id: 'a', name: 'A', x: -big, y: -big, width: big, height: big, rotation: 1e308, fills: [gradient], strokes: [gradient], strokeWidth: big, cornerRadius: big, effects: [{ type: 'drop-shadow', x: big, y: -big, blur: big, color: '#000000', opacity: 1 }] },
      { type: 'ellipse', id: 'b', name: 'B', x: 0, y: 0, width: big, height: 5e-324, rotation: 33.3, fills: [gradient] },
      { type: 'path', id: 'c', name: 'C', x: 0, y: 0, width: big, height: big, points: [{ x: 0, y: 0 }, { x: 1, y: 1 }], endCap: 'arrow', strokes: [gradient], strokeWidth: big },
      { type: 'text', id: 'd', name: 'D', x: 0, y: 0, width: big, height: 10, text: 'hello', fontSize: big, lineHeight: big, fontFamily: 'x', fills: [gradient] },
      { type: 'frame', id: 'e', name: 'E', x: big, y: big, width: big, height: big, opacity: 0.5, rotation: -1e300, fills: [gradient], layout: { gap: big, paddingTop: big }, sizing: { width: 'hug', height: 'hug' }, children: [{ type: 'rect', id: 'f', name: 'F', x: 0, y: 0, width: big, height: big, sizing: { width: 'fill' } }] },
    ]
    expect(parseOrReject({ format: 'kadrokreo', version: KDR_VERSION, document: { name: 'x', assets: {}, pages: [{ id: 'p', name: 'P', children }] } })).toBe('ok')
  })

  it('Object.prototype にある名前の id（constructor・toString など）でも読めて使える', () => {
    const ids = ['constructor', 'toString', 'hasOwnProperty', 'valueOf', 'isPrototypeOf']
    const children = [
      { type: 'frame', id: 'constructor', name: 'Main', x: 0, y: 0, width: 100, height: 100, component: { id: 'toString', role: 'main' }, children: [{ type: 'text', id: 'valueOf', name: 'T', x: 0, y: 0, width: 50, height: 20, text: 'x', fontSize: 12, fontFamily: 'sans-serif' }] },
      { type: 'frame', id: 'hasOwnProperty', name: 'Inst', x: 200, y: 0, width: 100, height: 100, component: { id: 'toString', role: 'instance', overrides: { isPrototypeOf: { text: 'y' } } } },
    ]
    const doc = parseKdr({ format: 'kadrokreo', version: KDR_VERSION, document: { name: 'x', assets: {}, pages: [{ id: 'valueOf', name: 'P', children }] } })
    expect(Object.keys(doc.pages[0].nodes).sort()).toEqual(['constructor', 'hasOwnProperty', 'valueOf'])
    exercise(doc)
    expect(ids).toContain('constructor')
  })

  it('__proto__ を id やキーに使ったファイルは KdrError になる', () => {
    const texts = [
      `{"format":"kadrokreo","version":${KDR_VERSION},"document":{"name":"x","assets":{"__proto__":{"mime":"image/png","data":"${PNG}"}},"pages":[{"id":"p","name":"P"}]}}`,
      `{"format":"kadrokreo","version":${KDR_VERSION},"document":{"name":"x","assets":{},"pages":[{"id":"__proto__","name":"P"}]}}`,
      `{"format":"kadrokreo","version":${KDR_VERSION},"document":{"name":"x","assets":{},"pages":[{"id":"p","name":"P","children":[{"type":"frame","id":"f","name":"F","x":0,"y":0,"width":1,"height":1,"component":{"id":"c","role":"instance","overrides":{"__proto__":{"text":"x"}}}}]}]}}`,
    ]
    for (const text of texts) expect(() => parseKdr(JSON.parse(text))).toThrow(KdrError)
  })
})
