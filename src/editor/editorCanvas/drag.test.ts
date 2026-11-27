import { describe, expect, it } from 'vitest'
import { getWorldCenter, rotateVector } from '../../document/geometry.ts'
import { createRect } from '../nodes.ts'
import { createDocument } from '../operations/document.ts'
import { insertNode } from '../operations/tree.ts'
import { createEditorStore } from '../store.ts'
import { dragGesture, lineInFrame, moveGesture } from './drag.ts'

const pointer = (world: { x: number; y: number }, modKey = false) => ({ screen: world, client: world, world, shiftKey: false, altKey: false, modKey })

/** 30° 回した 2 つの矩形。b は a の右に、回した向きに沿って 3 だけ離して置く */
function setup() {
  const a = { ...createRect({ x: 0, y: 0, width: 100, height: 50 }), rotation: 30 }
  const center = rotateVector({ x: 103, y: 0 }, 30)
  const b = { ...createRect({ x: center.x, y: center.y, width: 100, height: 50 }), rotation: 30 }
  const store = createEditorStore(createDocument())
  store.apply((doc) => insertNode(insertNode(doc, a), b))
  return { store, a, b }
}

/** a の中心から見た b の中心を、30° の向きの座標で */
function offset(store: ReturnType<typeof setup>['store'], a: string, b: string) {
  const page = store.getState().page
  const ca = getWorldCenter(page, a)
  const cb = getWorldCenter(page, b)
  return rotateVector({ x: cb.x - ca.x, y: cb.y - ca.y }, -30)
}

describe('回した図形の移動の吸着', () => {
  it('同じ向きに回した図形の辺に、その向きに沿って吸着し、傾いたガイドを出す', () => {
    const { store, a, b } = setup()
    const page = store.getState().page
    const gesture = moveGesture(page, { x: 0, y: 0 }, [b.id], { x: 0, y: 0, width: 1, height: 1 })
    expect(gesture.kind === 'move' && gesture.rotation).toBe(30)
    dragGesture(store, gesture, pointer({ x: 0, y: 0 }), 1)
    const moved = offset(store, a.id, b.id)
    // 辺どうしがくっつく（中心の間が幅と同じ 100）。向きと直交する向きはずれない
    expect(moved.x).toBeCloseTo(100, 1)
    expect(moved.y).toBeCloseTo(0, 1)
    if (gesture.kind !== 'move') throw new Error()
    expect(gesture.guides.length).toBeGreaterThan(0)
    expect(gesture.guides.every((guide) => guide.rotation === 30)).toBe(true)
  })

  it('Cmd / Ctrl を押している間は吸着しない', () => {
    const { store, a, b } = setup()
    const gesture = moveGesture(store.getState().page, { x: 0, y: 0 }, [b.id], { x: 0, y: 0, width: 1, height: 1 })
    dragGesture(store, gesture, pointer({ x: 0, y: 0 }, true), 1)
    expect(offset(store, a.id, b.id).x).toBeCloseTo(103, 1)
  })
})

describe('lineInFrame', () => {
  const line = { axis: 'x' as const, position: 100, from: 0, to: 10 }
  it('0° はそのまま（範囲は端なしに）、180° は向きが逆、90° は縦横が入れ替わる', () => {
    expect(lineInFrame(line, 0)).toEqual({ axis: 'x', position: 100, from: -Infinity, to: Infinity })
    expect(lineInFrame(line, 180)).toMatchObject({ axis: 'x', position: -100 })
    expect(lineInFrame(line, 90).axis).toBe('y')
    expect(Math.abs(lineInFrame(line, 90).position)).toBe(100)
    expect(lineInFrame(line, -90).axis).toBe('y')
  })
})
