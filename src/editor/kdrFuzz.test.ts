import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { renderScene } from '../canvas/render.ts'
import { setCanvasBlurWorks } from '../canvas/blur.ts'
import { measureText } from '../canvas/text.ts'
import { getContentBounds } from '../document/geometry.ts'
import { KDR_VERSION, KdrError, MAX_DEPTH, decodeKdr, kdrFile, parseKdr } from '../document/kdr.ts'
import { tarParts } from '../document/tar.ts'
import { fromBase64, gzipBlob, kdrBlob, tarGz } from '../document/testKdr.ts'
import { testFontBytes } from '../document/testFont.ts'
import type { Asset, DesignDocument } from '../document/types.ts'
import { inspectNode, inspectSelection, nodeCss } from '../viewer/inspect.ts'
import { nodeCode, nodeMarkup } from '../viewer/markup.ts'
import { inspectPage, summarizePage } from '../viewer/summary.ts'
import { syncComponents } from './components.ts'
import { kdrEntries } from './exportKdr.ts'

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
    createConicGradient: (...args: number[]) => {
      finite('createConicGradient', ...args)
      return {
        addColorStop(offset: number, _color: string) {
          finite('addColorStop', offset)
          if (offset < 0 || offset > 1) throw new RangeError('addColorStop: 0〜1 の範囲ではありません')
        },
      }
    },
    createRadialGradient: (...args: number[]) => {
      finite('createRadialGradient', ...args)
      if (args[2] < 0 || args[5] < 0) throw new RangeError('createRadialGradient: 負の半径')
      return {
        addColorStop(offset: number, _color: string) {
          finite('addColorStop', offset)
          if (offset < 0 || offset > 1) throw new RangeError('addColorStop: 0〜1 の範囲ではありません')
        },
      }
    },
    createPattern: () => ({
      setTransform(matrix: { values: number[] }) {
        finite('pattern.setTransform', ...matrix.values)
      },
    }),
    roundRect: (_x: number, _y: number, _w: number, _h: number, radius: number | number[]) => {
      const radii = typeof radius === 'number' ? [radius] : radius
      if (radii.length < 1 || radii.length > 4) throw new RangeError('roundRect: 半径の数')
      if (radii.some((r) => !(r >= 0))) throw new RangeError('roundRect: 負の半径')
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
  // 偽のキャンバスでは filter が効くかを確かめられないので、効くことにする（効かないときの道は canvas/blur.test.ts で確かめる）
  setCanvasBlurWorks(true)
  // 円形のグラデーションを線や文字に使うパターンの変換
  vi.stubGlobal(
    'DOMMatrix',
    class {
      values: number[]
      constructor(values: number[]) {
        this.values = values
      }
    },
  )
})
afterAll(() => {
  vi.unstubAllGlobals()
  setCanvasBlurWorks(undefined)
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
  expect(JSON.stringify(kdrFile(parseKdr(JSON.parse(json), doc.assets)))).toBe(json)
  // tar にまとめられる（画像の名前が tar に入れられる形）
  tarParts(kdrEntries(doc))
  // editor で開くと、インスタンスを元に合わせて作り直してから自動保存する。それも読み直せなければならない
  const synced = syncComponents(doc)
  parseKdr(JSON.parse(JSON.stringify(kdrFile(synced))), synced.assets)
}

/** parseKdr を呼び、KdrError 以外の例外を出さないことと、読めたら使えることを確かめる */
function parseOrReject(value: unknown, assets: unknown = {}): 'ok' | 'error' {
  let doc: DesignDocument
  try {
    doc = parseKdr(value, assets as Record<string, unknown>)
  } catch (error) {
    if (error instanceof KdrError) return 'error'
    throw error
  }
  exercise(doc)
  return 'ok'
}

// ---- ランダムなドキュメント ----

const ID_POOL = ['a', 'b', 'n1', 'constructor', 'toString', 'hasOwnProperty', 'valueOf', '__proto__', 'x'.repeat(64), 'x'.repeat(65), '', 'p1']
const PNG = fromBase64('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==')
const FONT = testFontBytes()

/** JSON で表せる極端な値。NaN / Infinity は JSON にないので、文字列の段階で別に差し込む */
const EXTREMES: unknown[] = [
  0, -0, 1, -1, 0.5, 2, 100, 400, 900, 1e21, 1e308, -1e308, Number.MAX_SAFE_INTEGER, 5e-324, 2 ** 31, -(2 ** 53),
  '', 'x', '#ff0000', '#FFF', '#gggggg', 'rect', 'frame', 'text', 'path', 'image', 'ellipse', 'hug', 'fill', 'fixed',
  'main', 'instance', 'linear', 'radial', 'conic', 'solid', 'drop-shadow', 'inner-shadow', 'absolute', 'vertical', 'space-between', 'arrow', 'a\n'.repeat(50),
  '__proto__', 'constructor', 'toString', true, false, null, [], {}, [1, 2], [[]], { x: 1, y: 2 }, { type: 'solid', color: '#000000', opacity: 1 },
]

function randomNumber(r: Random, min: number, max: number): number {
  if (r.chance(0.05)) return r.pick([1e308, -1e308, 1e21, 5e-324, -0, Number.MAX_SAFE_INTEGER]) as number
  return r.int(min, max)
}

function randomPaint(r: Random) {
  if (r.chance(0.6)) return { type: 'solid', color: r.pick(['#ff0000', '#00ff00', '#123456', '#abcdef']), opacity: 1, visible: r.chance(0.8), ...(r.chance(0.2) ? { blendMode: 'overlay' } : {}) }
  const count = r.int(2, 4)
  const stops = Array.from({ length: count }, (_, i) => ({ offset: i / (count - 1), color: r.pick(['#000000', '#ffffff', '#ff8800']), opacity: 1 }))
  if (r.chance(0.25)) {
    return { type: 'conic', cx: randomNumber(r, -1, 2), cy: randomNumber(r, -1, 2), angle: randomNumber(r, -720, 720), stops }
  }
  if (r.chance(0.5)) {
    return {
      type: 'radial',
      cx: randomNumber(r, -1, 2),
      cy: randomNumber(r, -1, 2),
      rx: randomNumber(r, 0, 2),
      ry: randomNumber(r, 0, 2),
      ...(r.chance(0.5) ? { angle: randomNumber(r, -720, 720) } : {}),
      ...(r.chance(0.3) ? { blendMode: r.pick(['multiply', 'screen', 'difference']) } : {}),
      stops,
    }
  }
  return { type: 'linear', x1: randomNumber(r, -1, 2), y1: randomNumber(r, -1, 2), x2: randomNumber(r, -1, 2), y2: randomNumber(r, -1, 2), stops, opacity: 1 }
}

function randomEffect(r: Random) {
  if (r.chance(0.25)) {
    return { type: r.pick(['layer-blur', 'background-blur']), blur: randomNumber(r, 0, 40), ...(r.chance(0.2) ? { visible: false } : {}) }
  }
  return {
    type: r.pick(['drop-shadow', 'inner-shadow']),
    ...(r.chance(0.2) ? { visible: false } : {}),
    x: randomNumber(r, -20, 20),
    y: randomNumber(r, -20, 20),
    blur: randomNumber(r, 0, 40),
    ...(r.chance(0.4) ? { spread: randomNumber(r, -20, 20) } : {}),
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
  if (r.chance(0.1)) node.blendMode = r.pick(['multiply', 'screen', 'color'])
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
  if (r.chance(0.3)) node.effects = Array.from({ length: r.int(0, 3) }, () => randomEffect(r))
  if (type === 'image' && r.chance(0.3)) {
    node.positionX = r.next()
    node.positionY = r.next()
  }
  if ((type === 'rect' || type === 'frame' || type === 'image') && r.chance(0.3)) {
    node.cornerRadius = r.chance(0.5) ? randomNumber(r, 0, 300) : Array.from({ length: 4 }, () => randomNumber(r, 0, 300))
  }

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
      if (r.chance(0.2)) node.letterSpacing = randomNumber(r, -20, 20)
      if (r.chance(0.2)) node.textDecoration = r.pick(['none', 'underline', 'line-through'])
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
          ? { id, role: 'main', description: '', properties: [], code: null }
          : { id, role: 'instance', ...(r.chance(0.5) ? { overrides: { [r.pick(ID_POOL)]: { text: 'x', visible: false, ...(r.chance(0.5) ? { componentId: r.pick(c.components) } : {}) } } } : {}) }
      }
      const count = r.int(0, 4)
      if (count > 0) node.children = Array.from({ length: count }, () => randomNode(c, depth + 1))
      break
    }
  }
  return node
}

/** ランダムなファイル。file は document.json の中身、assets は tar の assets/ に入る画像 */
function randomFile(r: Random): { file: Record<string, unknown>; assets: Record<string, Asset> } {
  const c: Context = { r, counter: 0, components: [], assets: [] }
  const assets: Record<string, Asset> = {}
  for (let i = 0; i < r.int(0, 2); i++) {
    const id = `img${i}`
    assets[id] = { mime: r.pick(['image/png', 'image/jpeg', 'image/webp', 'image/gif']), bytes: PNG.slice() }
    c.assets.push(id)
  }
  const pages = Array.from({ length: r.int(1, 3) }, (_, i) => ({
    id: r.chance(0.05) ? 'p1' : `page${i}`,
    name: `Page ${i}`,
    children: Array.from({ length: r.int(0, 5) }, () => randomNode(c, 1)),
  }))
  // 埋め込んだ書体（書体名・太さ・斜体の組と、書体のファイル）。乱数を使うと、ほかのテストの種で作られるファイルが変わるので、
  // 作った id の数で決める
  const fonts: Record<string, unknown>[] = []
  if (c.counter % 3 === 1) {
    assets.font0 = { mime: 'font/ttf', bytes: FONT.slice() }
    fonts.push({ assetId: 'font0', family: 'Kdr Test' }, { assetId: 'font0', family: 'Kdr Test', weight: 700, style: 'italic' })
  }
  const document = { name: 'fuzz', pages, ...(fonts.length > 0 ? { fonts } : {}) }
  return { file: { format: 'kadrokreo', version: KDR_VERSION, document }, assets }
}

// ---- 壊し方 ----

type Slot = { parent: Record<string, unknown> | unknown[]; key: string | number }

/** 木の中の場所（親とキー）を全部集める */
function slotsOf(value: unknown, out: Slot[] = [], seen = new Set<unknown>()): Slot[] {
  // バイト列（画像の中身）は中まで辿らず、丸ごと置き換える対象にする
  if (typeof value !== 'object' || value === null || seen.has(value) || ArrayBuffer.isView(value)) return out
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

async function decodeOrReject(blob: Blob, limits: Parameters<typeof decodeKdr>[1] = {}): Promise<'ok' | 'error'> {
  let doc: DesignDocument
  try {
    doc = await decodeKdr(blob, limits)
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
        const { file, assets } = randomFile(r)
        if (parseOrReject(file, assets) === 'ok') ok++
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
      // 画像（の表とバイト列）も壊す対象に入れる
      const both = randomFile(r)
      const cycles = r.chance(0.2)
      for (let i = r.int(1, 4); i > 0; i--) mutate(r, both, cycles)
      try {
        results[parseOrReject(both.file, both.assets)]++
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
      const { file, assets } = randomFile(r)
      let text = JSON.stringify(file)
      for (let i = r.int(1, 3); i > 0; i--) text = mutateText(r, text)
      try {
        await decodeOrReject(await kdrBlob(text, assets))
      } catch (error) {
        throw new Error(`種 ${seed * 104729} で失敗: ${String(error)}`, { cause: error })
      }
    }
  })

  it('gzip でないもの・壊れた gzip・空のファイル・tar でない中身・UTF-8 でない document.json は KdrError になる', async () => {
    const r = makeRandom(42)
    const { file, assets } = randomFile(r)
    const valid = new Uint8Array(await (await kdrBlob(file, assets)).arrayBuffer())
    const inputs: Blob[] = [
      new Blob([]),
      new Blob(['{}']),
      await gzipBlob(new Uint8Array([0xff, 0xfe, 0xfd])),
      await gzipBlob(''),
      await gzipBlob(JSON.stringify(file)),
      await kdrBlob(new Uint8Array([0xff, 0xfe, 0xfd])),
    ]
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
    const bomb = await gzipBlob(new Uint8Array(4 * 1024 * 1024))
    expect(bomb.size).toBeLessThan(64 * 1024)
    await expect(decodeKdr(bomb, { maxBytes: 1024 * 1024 })).rejects.toThrow(KdrError)
    // 見出しは正しく、中身が大きい（document.json・画像）ものも、上限を超えた所で止まる
    const json = await tarGz([{ name: 'document.json', bytes: ' '.repeat(4 * 1024 * 1024) }])
    await expect(decodeKdr(json, { maxBytes: 1024 * 1024 })).rejects.toThrow('大きすぎ')
    await expect(decodeKdr(json, { maxJsonBytes: 1024 * 1024 })).rejects.toThrow('大きすぎ')
  })
})

/** 画像 1 枚（img0）を使うか、何も使わない、小さな正しいファイル */
function simpleFile(withImage: boolean) {
  const children = withImage ? [{ type: 'image', id: 'i', name: 'I', x: 0, y: 0, width: 1, height: 1, assetId: 'img0' }] : []
  return { format: 'kadrokreo', version: KDR_VERSION, document: { name: 'x', pages: [{ id: 'p', name: 'P', children }] } }
}

describe('kdr の tar のファズテスト', () => {
  /** 正しい kdr の tar（gzip する前）のバイト列 */
  async function validTar(r: Random): Promise<Uint8Array> {
    const { file, assets } = randomFile(r)
    const blob = await kdrBlob(file, assets)
    return new Uint8Array(await new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer())
  }

  it('tar のバイトを壊したもの（見出し・中身・詰め物・途中で切る・つなげる）は、KdrError になるか、読めて使える', async () => {
    const results = { ok: 0, error: 0 }
    for (let seed = 1; seed <= 400; seed++) {
      const r = makeRandom(seed * 31337)
      let tar = await validTar(r)
      for (let i = r.int(1, 3); i > 0; i--) {
        switch (r.int(0, 4)) {
          case 0: {
            // 見出しの中の 1 バイト（名前・大きさ・種類・チェックサム・magic のあたり）
            const header = r.int(0, Math.floor(tar.length / 512) - 1) * 512
            tar[header + r.pick([0, 5, 99, 124, 130, 135, 148, 150, 156, 257, 262, 345])] = r.int(0, 255)
            break
          }
          case 1:
            tar[r.int(0, tar.length - 1)] ^= 1 << r.int(0, 7)
            break
          case 2:
            tar = tar.slice(0, r.int(0, tar.length))
            break
          case 3: {
            // 同じものを後ろにつなげる（終わりの印のあとの中身）
            const doubled = new Uint8Array(tar.length * 2)
            doubled.set(tar)
            doubled.set(tar, tar.length)
            tar = doubled
            break
          }
          default:
            // 0 のブロックを足す（詰め物）
            tar = Uint8Array.from([...tar, ...new Uint8Array(512 * r.int(1, 20))])
        }
      }
      try {
        results[await decodeOrReject(await gzipBlob(tar as Uint8Array<ArrayBuffer>))]++
      } catch (error) {
        throw new Error(`種 ${seed * 31337} で失敗: ${String(error)}`, { cause: error })
      }
    }
    // 画像の見出しの大きさや書体名の文字を壊したものも KdrError になるので、読めるものは 400 のうち 15〜20 前後
    // （ノードの作り方を変えると乱数の並びがずれて数が少し動く）
    expect(results.ok).toBeGreaterThan(10)
    expect(results.error).toBeGreaterThan(100)
  })

  it('ランダムな名前と中身の並び（重複・知らない名前・パスの細工・空・巨大な名前）は、KdrError になるか、読めて使える', async () => {
    const NAMES = [
      'document.json', 'document.json', 'assets/img0.png', 'assets/img1.jpg', 'assets/img0.gif', 'assets/img2.webp',
      'assets/img0.PNG', 'assets/img0.svg', 'assets/', 'assets', '../document.json', 'assets/../document.json', '/document.json',
      './document.json', 'assets/a/b.png', 'assets/__proto__.png', 'assets/constructor.png', `assets/${'x'.repeat(64)}.png`,
      `assets/${'x'.repeat(65)}.png`, 'DOCUMENT.JSON', 'document.json/', 'assets\\img0.png', 'assets/font0.ttf', 'assets/font0.ttc',
    ]
    const results = { ok: 0, error: 0 }
    for (let seed = 1; seed <= 300; seed++) {
      const r = makeRandom(seed * 7)
      // 画像を使わないドキュメント（どの画像も捨てられる）なので、名前の扱いだけで結果が決まる
      const file = simpleFile(false)
      const entries = Array.from({ length: r.int(0, 5) }, () => {
        const name = r.pick(NAMES)
        const bytes = name.endsWith('.json')
          ? JSON.stringify(file)
          : r.chance(0.8)
            ? name.endsWith('.ttf') ? FONT.slice() : PNG.slice()
            : new Uint8Array(r.int(0, 2000))
        return { name, bytes }
      })
      try {
        results[await decodeOrReject(await tarGz(entries))]++
      } catch (error) {
        throw new Error(`種 ${seed * 7} で失敗: ${String(error)}`, { cause: error })
      }
    }
    expect(results.ok).toBeGreaterThan(10)
    expect(results.error).toBeGreaterThan(100)
  })

  /** 正しい kdr の tar の最初の見出しを書き換え、チェックサムを合わせ直したもの */
  async function craftedHeader(patch: (header: Uint8Array) => void, fixChecksum = true): Promise<Blob> {
    const { file } = randomFile(makeRandom(6)) // 画像のないファイルになる種（kdrBlob に画像を渡さないため）
    const tar = new Uint8Array(await new Response((await kdrBlob(file)).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer())
    const header = tar.subarray(0, 512)
    patch(header)
    if (fixChecksum) {
      header.fill(0x20, 148, 156)
      const sum = header.reduce((total, byte) => total + byte, 0)
      header.set(new TextEncoder().encode(sum.toString(8).padStart(6, '0') + '\0 '), 148)
    }
    return gzipBlob(tar)
  }
  const write = (header: Uint8Array, offset: number, text: string) => header.set(new TextEncoder().encode(text), offset)

  it('細工した見出し（リンク・ディレクトリ・拡張の見出し・読めない大きさ・巨大な大きさ・壊れたチェックサム）は KdrError になる', async () => {
    expect(await decodeOrReject(await craftedHeader(() => {}))).toBe('ok')
    const patches: ((header: Uint8Array) => void)[] = [
      (h) => write(h, 156, '2'), // シンボリックリンク
      (h) => write(h, 156, '1'), // ハードリンク
      (h) => write(h, 156, '5'), // ディレクトリ
      (h) => write(h, 156, 'x'), // pax の拡張の見出し
      (h) => write(h, 156, 'L'), // GNU の長い名前
      (h) => write(h, 124, '0000000009x\0'), // 8 進でない大きさ
      (h) => write(h, 124, '77777777777\0'), // 8GB の大きさ
      (h) => h.set([0x80, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff], 124), // base-256 の大きさ
      (h) => write(h, 257, 'nottar'), // magic が違う
      (h) => write(h, 345, 'assets'), // prefix で名前を変える（assets/document.json になる）
    ]
    for (const patch of patches) expect(await decodeOrReject(await craftedHeader(patch))).toBe('error')
    expect(await decodeOrReject(await craftedHeader((h) => write(h, 0, 'x'), false))).toBe('error')
  })
})

describe('kdr の読み込みの上限', () => {
  it('画像 1 枚・document.json・全体の上限を超えたものは、中身を読む前に KdrError になる', async () => {
    const file = simpleFile(true)
    const big = await tarGz([{ name: 'document.json', bytes: JSON.stringify(file) }, { name: 'assets/img0.png', bytes: new Uint8Array(300_000) }])
    expect(await decodeOrReject(big)).toBe('ok')
    expect(await decodeOrReject(big, { maxAssetBytes: 100_000 })).toBe('error')
    expect(await decodeOrReject(big, { maxJsonBytes: 10 })).toBe('error')
    expect(await decodeOrReject(big, { maxBytes: 200_000 })).toBe('error')
  })
})

describe('kdr の読み込みの極端な入力', () => {
  /** フレームを depth 段入れ子にしたファイルの JSON。JSON.stringify は再帰するので、文字列を自分で組む */
  function nestedFramesJson(depth: number): string {
    const open = (i: number) => `{"type":"frame","id":"f${i}","name":"F","x":0,"y":0,"width":10,"height":10,"children":[`
    let text = ''
    for (let i = 0; i < depth; i++) text += open(i)
    text += ']}'.repeat(depth)
    return `{"format":"kadrokreo","version":${KDR_VERSION},"document":{"name":"x","pages":[{"id":"p","name":"P","children":[${text}]}]}}`
  }

  it(`フレームの入れ子は ${MAX_DEPTH} 段まで読めて、それより深いと KdrError になる`, () => {
    expect(parseOrReject(JSON.parse(nestedFramesJson(MAX_DEPTH)))).toBe('ok')
    expect(() => parseKdr(JSON.parse(nestedFramesJson(MAX_DEPTH + 1)))).toThrow(KdrError)
  })

  it('10 万段の入れ子でもスタックが溢れず KdrError になる', async () => {
    const text = nestedFramesJson(100_000)
    expect(() => parseKdr(JSON.parse(text))).toThrow(KdrError)
    expect(await decodeOrReject(await kdrBlob(text))).toBe('error')
  })

  it('ノード以外の場所の深い入れ子（名前・オートレイアウト・上書き・未知の項目）も KdrError になるか読み飛ばす', async () => {
    const deep = '['.repeat(200_000) + ']'.repeat(200_000)
    const deepObject = '{"a":'.repeat(100_000) + '1' + '}'.repeat(100_000)
    const node = (patch: string) =>
      `{"format":"kadrokreo","version":${KDR_VERSION},"document":{"name":"x","pages":[{"id":"p","name":"P","children":[{"type":"frame","id":"f","name":"F","x":0,"y":0,"width":10,"height":10,${patch}}]}]}}`
    expect(await decodeOrReject(await kdrBlob(node(`"name2":${deep}`)))).toBe('ok')
    expect(await decodeOrReject(await kdrBlob(node(`"extra":${deepObject}`)))).toBe('ok')
    // 知らない項目は読み飛ばすので、オートレイアウトや上書きの中の深い入れ子は読める
    expect(await decodeOrReject(await kdrBlob(node(`"layout":${deepObject}`)))).toBe('ok')
    expect(await decodeOrReject(await kdrBlob(node(`"component":{"id":"c","role":"instance","overrides":${deepObject}}`)))).toBe('ok')
    // 知っている項目の型が違えば KdrError
    for (const patch of [`"fills":${deep}`, `"layout":{"gap":${deep}}`, `"component":{"id":"c","role":"instance","overrides":{"a":{"text":${deep}}}}`]) {
      expect(await decodeOrReject(await kdrBlob(node(patch)))).toBe('error')
    }
  })

  it('本当に循環する参照（JSON にはできないが、parseKdr には渡せる）でも止まって KdrError になる', () => {
    const frame: Record<string, unknown> = { type: 'frame', id: 'f', name: 'F', x: 0, y: 0, width: 10, height: 10 }
    frame.children = [frame]
    const file = { format: 'kadrokreo', version: KDR_VERSION, document: { name: 'x', pages: [{ id: 'p', name: 'P', children: [frame] }] } }
    expect(() => parseKdr(file)).toThrow(KdrError)

    // id が毎回違っても、入れ子の上限で止まる
    let count = 0
    const looping = new Proxy(frame, { get: (target, key) => (key === 'id' ? `f${count++}` : target[key as string]) })
    frame.children = [looping]
    expect(() => parseKdr(file)).toThrow(KdrError)
  })

  it('巨大な配列（20 万個の子）を読んで描画できる', () => {
    const children = Array.from({ length: 200_000 }, (_, i) => ({ type: 'rect', id: `r${i}`, name: 'R', x: i, y: 0, width: 1, height: 1 }))
    const file = { format: 'kadrokreo', version: KDR_VERSION, document: { name: 'x', pages: [{ id: 'p', name: 'P', children: [{ type: 'frame', id: 'f', name: 'F', x: 0, y: 0, width: 10, height: 10, children }] }] } }
    expect(parseOrReject(file)).toBe('ok')
    // 手元でも数秒かかり、CI のランナーでは既定の 5 秒を超えるので長めにする
  }, 30_000)

  it('行が非常に多いテキスト（30 万行）も大きさを測って描画できる', () => {
    const node = { type: 'text', id: 't', name: 'T', x: 0, y: 0, width: 10, height: 10, text: 'a\n'.repeat(300_000), fontSize: 12, fontFamily: 'sans-serif', sizing: { width: 'hug' } }
    const doc = parseKdr({ format: 'kadrokreo', version: KDR_VERSION, document: { name: 'x', pages: [{ id: 'p', name: 'P', children: [node] }] } })
    const text = doc.pages[0].nodes.t
    if (text.type !== 'text') throw new Error('テキストではない')
    expect(measureText(fakeContext(), text).height).toBeGreaterThan(300_000)
    exercise(doc)
  })

  it('極端に大きい・回ったノードとグラデーションも描画で落ちない', () => {
    const big = 1e308
    const gradient = { type: 'linear', x1: 0, y1: 0, x2: 1, y2: 1, stops: [{ offset: 0, color: '#000000', opacity: 1 }, { offset: 1, color: '#ffffff', opacity: 1 }], opacity: 1 }
    const children = [
      { type: 'rect', id: 'a', name: 'A', x: -big, y: -big, width: big, height: big, rotation: 1e308, fills: [gradient], strokes: [gradient], strokeWidth: big, cornerRadius: big, blendMode: 'multiply', effects: [{ type: 'drop-shadow', x: big, y: -big, blur: big, spread: big, color: '#000000', opacity: 1 }, { type: 'inner-shadow', x: big, y: -big, blur: big, spread: -big, color: '#000000', opacity: 1 }, { type: 'layer-blur', blur: big }, { type: 'background-blur', blur: big }] },
      { type: 'ellipse', id: 'b', name: 'B', x: 0, y: 0, width: big, height: 5e-324, rotation: 33.3, fills: [gradient, { type: 'conic', cx: big, cy: -big, angle: big, stops: gradient.stops }] },
      { type: 'path', id: 'c', name: 'C', x: 0, y: 0, width: big, height: big, points: [{ x: 0, y: 0 }, { x: 1, y: 1 }], endCap: 'arrow', strokes: [gradient], strokeWidth: big },
      { type: 'text', id: 'd', name: 'D', x: 0, y: 0, width: big, height: 10, text: 'hello', fontSize: big, lineHeight: big, fontFamily: 'x', fills: [gradient], effects: [{ type: 'drop-shadow', x: big, y: big, blur: big, spread: big, color: '#000000', opacity: 1 }] },
      { type: 'frame', id: 'e', name: 'E', x: big, y: big, width: big, height: big, opacity: 0.5, rotation: -1e300, fills: [gradient], layout: { gap: big, paddingTop: big }, sizing: { width: 'hug', height: 'hug' }, children: [{ type: 'rect', id: 'f', name: 'F', x: 0, y: 0, width: big, height: big, sizing: { width: 'fill' } }] },
    ]
    expect(parseOrReject({ format: 'kadrokreo', version: KDR_VERSION, document: { name: 'x', pages: [{ id: 'p', name: 'P', children }] } })).toBe('ok')
  })

  it('Object.prototype にある名前の id（constructor・toString など）でも読めて使える', () => {
    const ids = ['constructor', 'toString', 'hasOwnProperty', 'valueOf', 'isPrototypeOf']
    const children = [
      { type: 'frame', id: 'constructor', name: 'Main', x: 0, y: 0, width: 100, height: 100, component: { id: 'toString', role: 'main', description: '', properties: [], code: null }, children: [{ type: 'text', id: 'valueOf', name: 'T', x: 0, y: 0, width: 50, height: 20, text: 'x', fontSize: 12, fontFamily: 'sans-serif' }] },
      { type: 'frame', id: 'hasOwnProperty', name: 'Inst', x: 200, y: 0, width: 100, height: 100, component: { id: 'toString', role: 'instance', overrides: { isPrototypeOf: { text: 'y' } } } },
    ]
    const doc = parseKdr({ format: 'kadrokreo', version: KDR_VERSION, document: { name: 'x', pages: [{ id: 'valueOf', name: 'P', children }] } })
    expect(Object.keys(doc.pages[0].nodes).sort()).toEqual(['constructor', 'hasOwnProperty', 'valueOf'])
    exercise(doc)
    expect(ids).toContain('constructor')
  })

  it('__proto__ を id やキーに使ったファイルは KdrError になる', () => {
    const texts = [
      `{"format":"kadrokreo","version":${KDR_VERSION},"document":{"name":"x","pages":[{"id":"__proto__","name":"P"}]}}`,
      `{"format":"kadrokreo","version":${KDR_VERSION},"document":{"name":"x","pages":[{"id":"p","name":"P","children":[{"type":"frame","id":"f","name":"F","x":0,"y":0,"width":1,"height":1,"component":{"id":"c","role":"instance","overrides":{"__proto__":{"text":"x"}}}}]}]}}`,
    ]
    for (const text of texts) expect(() => parseKdr(JSON.parse(text))).toThrow(KdrError)
    // 画像の id（JSON.parse は __proto__ を自分の項目として作る）
    const file = { format: 'kadrokreo', version: KDR_VERSION, document: { name: 'x', pages: [{ id: 'p', name: 'P' }] } }
    expect(() => parseKdr(file, JSON.parse('{"__proto__":{"mime":"image/png","bytes":null}}'))).toThrow(KdrError)
  })
})
