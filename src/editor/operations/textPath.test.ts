import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { testFontBytes } from '../../document/testFont.ts'
import { ellipse, frame, path, rect, sceneOf, text } from '../../document/testNodes.ts'
import { setOutlineFonts } from '../../document/textOutline.ts'
import type { PathNode, TextNode } from '../../document/types.ts'
import { outlineTexts } from './outline.ts'
import { attachTextToPath, detachTextFromPath, setTextPathOffset, textPathTargets } from './textPath.ts'

const line = (patch: Partial<PathNode> = {}) => path({ id: 'g', x: 100, y: 50, width: 100, height: 0, points: [{ x: 0, y: 0 }, { x: 1, y: 0 }], closed: false, ...patch })

describe('textPathTargets', () => {
  it('テキスト 1 つと図形 1 つを選んでいるときだけ', () => {
    const scene = sceneOf(text({ id: 't' }), line(), rect({ id: 'r' }), frame({ id: 'f' }))
    expect(textPathTargets(scene, ['g', 't'])).toEqual({ text: 't', guide: 'g' })
    expect(textPathTargets(scene, ['t', 'r'])).toEqual({ text: 't', guide: 'r' })
    expect(textPathTargets(scene, ['t'])).toBeNull()
    expect(textPathTargets(scene, ['t', 'f'])).toBeNull()
    expect(textPathTargets(scene, ['t', 'g', 'r'])).toBeNull()
  })
})

describe('attachTextToPath', () => {
  it('図形の線を写し、テキストの枠を線を囲む矩形にする（図形は残す）', () => {
    const scene = sceneOf(text({ id: 't', rotation: 30, flipX: true }), line())
    const next = attachTextToPath(scene, 't', 'g')
    const node = next.nodes.t as TextNode
    expect(node).toMatchObject({ x: 100, y: 50, width: 100, height: 1, rotation: 0, flipX: false, sizing: { width: 'fixed', height: 'hug' } })
    expect(node.textPath).toEqual({ points: [{ x: 0, y: 0 }, { x: 1, y: 0 }], closed: false, startOffset: 0 })
    expect(next.nodes.g).toBe(scene.nodes.g)
  })

  it('回した図形は、テキストの親の座標系に写して形に焼き込む', () => {
    const parent = frame({ id: 'p', x: 10, y: 10, width: 500, height: 500, children: ['t'] })
    const scene = sceneOf(parent, text({ id: 't', parentId: 'p' }), line({ rotation: 90 }))
    const node = attachTextToPath(scene, 't', 'g').nodes.t as TextNode
    // 枠の中心（150, 50）のまわりに 90° 回した縦の線: ページで (150, 0)〜(150, 100)、親の座標で (140, -10)〜(140, 90)
    expect([node.x, node.y, node.width, node.height]).toEqual([140, -10, 1, 100])
    expect(node.textPath?.points).toEqual([{ x: 0, y: 0 }, { x: 0, y: 1 }])
  })

  it('楕円は閉じた線になる', () => {
    const scene = sceneOf(text({ id: 't' }), ellipse({ id: 'e', x: 0, y: 0, width: 100, height: 50 }))
    const node = attachTextToPath(scene, 't', 'e').nodes.t as TextNode
    expect(node.textPath?.closed).toBe(true)
    expect([node.x, node.y, node.width, node.height]).toEqual([0, 0, 100, 50])
  })

  it('沿わせられなければ同じ参照を返す', () => {
    const scene = sceneOf(text({ id: 't' }), frame({ id: 'f' }))
    expect(attachTextToPath(scene, 't', 'f')).toBe(scene)
    expect(attachTextToPath(scene, 'f', 't')).toBe(scene)
  })
})

describe('detachTextFromPath・setTextPathOffset', () => {
  it('始まりの位置を 0〜1 に収めて変え、外すと幅は中身に合わせる', () => {
    const scene = attachTextToPath(sceneOf(text({ id: 't' }), line()), 't', 'g')
    const moved = setTextPathOffset(scene, ['t'], 1.5)
    expect((moved.nodes.t as TextNode).textPath?.startOffset).toBe(1)
    expect(setTextPathOffset(moved, ['t'], 2)).toBe(moved)
    const detached = detachTextFromPath(moved, ['t'])
    expect(detached.nodes.t).toMatchObject({ textPath: null, sizing: { width: 'hug' } })
    expect(detachTextFromPath(detached, ['t'])).toBe(detached)
  })
})

describe('線に沿うテキストの文字の形', () => {
  const FONT_ID = 'f'.repeat(64)
  beforeEach(() => setOutlineFonts([{ assetId: FONT_ID, family: 'Kdr Test', weight: 400, style: 'normal' }], { [FONT_ID]: { mime: 'font/ttf', bytes: testFontBytes() } }))
  afterEach(() => setOutlineFonts([], {}))

  it('アウトライン化すると、文字を線の向きに回した形になる', () => {
    // 上から下への縦の線。字（送り幅 60、四角は横 5〜55・基線から上 70）は 90° 回って、線の右側に並ぶ
    const node = text({
      id: 't', fontFamily: 'Kdr Test', text: 'AA', fontSize: 100, x: 10, y: 20, width: 1, height: 200,
      textPath: { points: [{ x: 0, y: 0 }, { x: 0, y: 1 }], closed: false, startOffset: 0 },
    })
    const result = outlineTexts(sceneOf(node), ['t'])
    const outlined = result.scene.nodes.t as PathNode
    expect([outlined.x, outlined.y, outlined.width, outlined.height].map(Math.round)).toEqual([10, 25, 70, 110])
  })
})
