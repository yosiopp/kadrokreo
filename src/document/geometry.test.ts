import { describe, expect, it } from 'vitest'
import {
  type Point,
  applyMatrix,
  getAbsoluteBounds,
  getCorners,
  getWorldCenter,
  getWorldMatrix,
  getWorldRotation,
  invert,
  multiply,
  nodeMatrix,
  normalizeAngle,
  poseInParent,
  toLocal,
  toNodeSpace,
} from './geometry.ts'
import type { Scene, SceneNode } from './types.ts'

function box(id: string, parentId: string | null, x: number, y: number, rotation: number, children: string[] = []) {
  return {
    id,
    name: id,
    parentId,
    x,
    y,
    width: 100,
    height: 50,
    rotation,
    visible: true,
    locked: false,
    opacity: 1,
    blendMode: 'normal',
    type: 'frame',
    sizing: { width: 'fixed', height: 'fixed' },
    layoutPositioning: 'auto',
    constraints: { horizontal: 'start', vertical: 'start' },
    minWidth: null,
    maxWidth: null,
    minHeight: null,
    maxHeight: null,
    fills: [],
    strokes: [],
    strokeWidth: 1,
    strokeDashes: [],
    strokeDashOffset: 0,
    strokeJoin: 'miter',
    effects: [],
    children,
    clipContent: false,
    passThrough: false,
    cornerRadius: 0,
    layout: null,
    component: null,
    setDescription: '',
    booleanOperation: null,
    booleanIncludeStrokes: false,
    layoutGrids: [],
    isMask: false,
    maskType: 'vector',
  } as SceneNode
}

/** 90° 回した親の中に、さらに 90° 回した子がいる */
const scene: Scene = {
  nodes: {
    parent: box('parent', null, 200, 100, 90, ['child']),
    child: box('child', 'parent', 10, 20, 90),
    plain: box('plain', null, 0, 0, 0),
  },
  rootIds: ['parent', 'plain'],
}

function expectPoint(actual: Point, expected: Point) {
  expect(actual.x).toBeCloseTo(expected.x)
  expect(actual.y).toBeCloseTo(expected.y)
}

describe('nodeMatrix', () => {
  it('回っていなければ平行移動だけ', () => {
    expect(nodeMatrix({ x: 10, y: 20, width: 100, height: 50, rotation: 0 })).toEqual([1, 0, 0, 1, 10, 20])
  })

  it('枠の中心を軸に時計回りに回す', () => {
    const m = nodeMatrix({ x: 0, y: 0, width: 100, height: 50, rotation: 90 })
    expectPoint(applyMatrix(m, { x: 50, y: 25 }), { x: 50, y: 25 })
    // 左上は、中心から見て右上へ回る
    expectPoint(applyMatrix(m, { x: 0, y: 0 }), { x: 75, y: -25 })
  })

  it('逆行列で元に戻る', () => {
    const m = nodeMatrix({ x: 30, y: -10, width: 80, height: 40, rotation: 33 })
    expectPoint(applyMatrix(multiply(invert(m), m), { x: 7, y: 9 }), { x: 7, y: 9 })
  })
})

describe('ページ上での位置と向き', () => {
  it('祖先の回転を足し合わせる', () => {
    expect(getWorldRotation(scene, 'child')).toBe(180)
    expect(getWorldRotation(scene, 'plain')).toBe(0)
    expect(getWorldRotation(scene, null)).toBe(0)
  })

  it('回っていないノードの囲む矩形は枠そのもの', () => {
    expect(getAbsoluteBounds(scene, 'plain')).toEqual({ x: 0, y: 0, width: 100, height: 50 })
  })

  it('90° 回すと、囲む矩形は縦横が入れ替わる', () => {
    const bounds = getAbsoluteBounds(scene, 'parent')
    expect(bounds.x).toBeCloseTo(225)
    expect(bounds.y).toBeCloseTo(75)
    expect(bounds.width).toBeCloseTo(50)
    expect(bounds.height).toBeCloseTo(100)
    expectPoint(getWorldCenter(scene, 'parent'), { x: 250, y: 125 })
    expectPoint(getCorners(scene, 'parent')[0], { x: 275, y: 75 })
  })

  it('ページ座標と親の中の座標を行き来できる', () => {
    const world = applyMatrix(getWorldMatrix(scene, 'parent'), { x: 10, y: 20 })
    expectPoint(toLocal(scene, 'parent', world), { x: 10, y: 20 })
    expect(toLocal(scene, null, world)).toBe(world)
  })

  it('親の座標系の点をノードの座標系に直す', () => {
    const parent = scene.nodes.parent
    // 親の中心は、回しても中心のまま
    expectPoint(toNodeSpace(parent, { x: 250, y: 125 }), { x: 50, y: 25 })
    // ページ上で右上にある角は、回す前の左上
    expectPoint(toNodeSpace(parent, { x: 275, y: 75 }), { x: 0, y: 0 })
  })
})

describe('poseInParent', () => {
  it('親を付け替えても、ページ上での中心と向きが変わらない位置を返す', () => {
    const center = getWorldCenter(scene, 'child')
    const rotation = getWorldRotation(scene, 'child')

    const atRoot = poseInParent(scene, null, center, rotation, scene.nodes.child)
    expect(atRoot.rotation).toBe(180)
    expectPoint({ x: atRoot.x + 50, y: atRoot.y + 25 }, center)

    const back = poseInParent(scene, 'parent', center, rotation, scene.nodes.child)
    expect(back).toMatchObject({ x: 10, y: 20, rotation: 90 })
  })
})

describe('normalizeAngle', () => {
  it('-180 より大きく 180 以下に収める', () => {
    expect(normalizeAngle(0)).toBe(0)
    expect(normalizeAngle(270)).toBe(-90)
    expect(normalizeAngle(-270)).toBe(90)
    expect(normalizeAngle(540)).toBe(180)
    expect(normalizeAngle(-180)).toBe(180)
    expect(normalizeAngle(725)).toBe(5)
  })
})
