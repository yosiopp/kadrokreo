import { describe, expect, it } from 'vitest'
import type { ConicGradient, LinearGradient, RadialGradient } from '../../document/types.ts'
import { paint, rect } from '../../document/testNodes.ts'
import { dragGradient, gradientHandles, gradientPartAt, gradientToEdit, offsetOnAxis } from './gradientHandles.ts'

const stops = [
  { offset: 0, color: '#000000', opacity: 1 },
  { offset: 0.5, color: '#ff0000', opacity: 1 },
  { offset: 1, color: '#ffffff', opacity: 1 },
]
const linear: LinearGradient = { type: 'linear', x1: 0, y1: 0.5, x2: 1, y2: 0.5, stops, opacity: 1, visible: true, blendMode: 'normal' as const }
const radial: RadialGradient = { type: 'radial', cx: 0.5, cy: 0.5, rx: 0.5, ry: 0.5, stops, opacity: 1, visible: true, angle: 0, fx: 0, fy: 0, blendMode: 'normal' as const }
const conic: ConicGradient = { type: 'conic', cx: 0.5, cy: 0.5, angle: 0, stops, opacity: 1, visible: true, blendMode: 'normal' as const }
const size = { width: 200, height: 100 }

describe('グラデーションのハンドル', () => {
  it('直線は枠の中心を通る線の両端と、その上の色の位置', () => {
    expect(gradientHandles(linear, size)).toEqual({
      axis: [{ x: 0, y: 50 }, { x: 200, y: 50 }],
      radiusY: null,
      focus: null,
      stops: [{ x: 0, y: 50 }, { x: 100, y: 50 }, { x: 200, y: 50 }],
    })
  })

  it('円形は中心と横・縦の半径の先。色は中心から横の半径の先に並ぶ', () => {
    const handles = gradientHandles({ ...radial, cx: 0.25, rx: 0.25 }, size)
    expect(handles.axis).toEqual([{ x: 50, y: 50 }, { x: 100, y: 50 }])
    expect(handles.radiusY).toEqual({ x: 50, y: 100 })
    expect(handles.stops[1]).toEqual({ x: 75, y: 50 })
  })

  it('角度は中心と、最初の色の向きの先（枠の短い辺の半分）。つかむと中心を動かし、向きを変える', () => {
    const handles = gradientHandles({ ...conic, angle: 90 }, size)
    expect(handles.axis[0]).toEqual({ x: 100, y: 50 })
    expect(handles.axis[1].x).toBeCloseTo(100)
    expect(handles.axis[1].y).toBeCloseTo(100)
    const near = (target: { x: number; y: number }) => (point: { x: number; y: number }) => Math.hypot(point.x - target.x, point.y - target.y) < 4
    const two = { ...conic, stops: [{ offset: 0.2, color: '#000000', opacity: 1 }, { offset: 0.8, color: '#ffffff', opacity: 1 }] }
    const twoHandles = gradientHandles(two, size)
    expect(gradientPartAt(twoHandles, two, near({ x: 100, y: 50 }))).toEqual({ kind: 'center' })
    expect(gradientPartAt(twoHandles, two, near({ x: 150, y: 50 }))).toEqual({ kind: 'end' })
    expect(dragGradient(conic, { kind: 'center' }, { x: 50, y: 25 }, size, false).gradient).toMatchObject({ cx: 0.25, cy: 0.25 })
    expect(dragGradient(conic, { kind: 'end' }, { x: 100, y: 0 }, size, false).gradient).toMatchObject({ angle: -90 })
    // Shift で 15° 刻み
    expect(dragGradient(conic, { kind: 'end' }, { x: 150, y: 57 }, size, true).gradient).toMatchObject({ angle: 15 })
  })

  it('近くのハンドルは色の位置を先に探す', () => {
    const handles = gradientHandles(linear, size)
    const near = (target: { x: number; y: number }) => (point: { x: number; y: number }) => Math.hypot(point.x - target.x, point.y - target.y) < 4
    expect(gradientPartAt(handles, linear, near({ x: 0, y: 50 }))).toEqual({ kind: 'stop', index: 0 })
    expect(gradientPartAt(handles, linear, near({ x: 101, y: 50 }))).toEqual({ kind: 'stop', index: 1 })
    expect(gradientPartAt(handles, linear, near({ x: 60, y: 50 }))).toBeNull()
    const two = { ...radial, stops: [stops[0], stops[2]] }
    const radialHandles = gradientHandles({ ...two, stops: [{ offset: 0.2, color: '#000000', opacity: 1 }, { offset: 0.8, color: '#ffffff', opacity: 1 }] }, size)
    expect(gradientPartAt(radialHandles, two, near({ x: 100, y: 50 }))).toEqual({ kind: 'center' })
    expect(gradientPartAt(radialHandles, two, near({ x: 200, y: 50 }))).toEqual({ kind: 'radiusX' })
    expect(gradientPartAt(radialHandles, two, near({ x: 100, y: 100 }))).toEqual({ kind: 'radiusY' })
  })

  it('色が並ぶ線の上の位置と、線からの距離', () => {
    const handles = gradientHandles(linear, size)
    expect(offsetOnAxis(handles, { x: 50, y: 60 })).toEqual({ offset: 0.25, distance: 10 })
    expect(offsetOnAxis(handles, { x: -50, y: 50 })).toEqual({ offset: 0, distance: 50 })
  })
})

describe('dragGradient', () => {
  it('直線の始点・終点はそれぞれ自由に置く。Shift はもう一方の端を中心に 15° 刻み', () => {
    expect(dragGradient(linear, { kind: 'end' }, { x: 100, y: 150 }, size, false).gradient).toMatchObject({ x1: 0, y1: 0.5, x2: 0.5, y2: 1.5 })
    expect(dragGradient(linear, { kind: 'start' }, { x: 50, y: 25 }, size, false).gradient).toMatchObject({ x1: 0.25, y1: 0.25, x2: 1, y2: 0.5 })
    // 始点 (0, 50) から 6° ほど下の向きは、Shift で真横（長さは保つ）
    const snapped = dragGradient(linear, { kind: 'end' }, { x: 200, y: 71 }, size, true).gradient
    expect(snapped).toMatchObject({ x1: 0, y1: 0.5, y2: 0.5 })
    expect(snapped.type === 'linear' && snapped.x2).toBeCloseTo(Math.hypot(200, 21) / 200, 3)
    // つぶれた枠では割合にできないので変えない
    expect(dragGradient(linear, { kind: 'end' }, { x: 100, y: 50 }, { width: 0, height: 100 }, false).gradient).toBe(linear)
  })

  it('色の位置は線に沿って動き、追い越すと並べ直して、選んでいる色の番号も付いてくる', () => {
    const moved = dragGradient(linear, { kind: 'stop', index: 0 }, { x: 150, y: 80 }, size, false)
    expect(moved.gradient.stops).toEqual([
      { offset: 0.5, color: '#ff0000', opacity: 1 },
      { offset: 0.75, color: '#000000', opacity: 1 },
      { offset: 1, color: '#ffffff', opacity: 1 },
    ])
    expect(moved.stop).toBe(1)
    // 線の外は端で止める。同じ位置の色は元の順に並ぶ
    expect(dragGradient(linear, { kind: 'stop', index: 1 }, { x: -40, y: 50 }, size, false)).toMatchObject({ stop: 1 })
    expect(dragGradient(linear, { kind: 'stop', index: 2 }, { x: -40, y: 50 }, size, false)).toMatchObject({ stop: 1 })
  })

  it('円形は中心を動かし、半径の先は距離が半径・向きが回す角度になる。Shift で縦横の半径を揃えて円にし、向きを 15° 刻みに', () => {
    // 中心は (100, 50)
    expect(dragGradient(radial, { kind: 'center' }, { x: 50, y: 0 }, size, false).gradient).toMatchObject({ cx: 0.25, cy: 0 })
    expect(dragGradient(radial, { kind: 'radiusX' }, { x: 160, y: 50 }, size, false).gradient).toMatchObject({ rx: 0.3, ry: 0.5, angle: 0 })
    expect(dragGradient(radial, { kind: 'radiusY' }, { x: 100, y: 80 }, size, false).gradient).toMatchObject({ rx: 0.5, ry: 0.3, angle: 0 })
    // 右下 45° へ引くと、楕円が 45° 回る
    expect(dragGradient(radial, { kind: 'radiusX' }, { x: 130, y: 80 }, size, false).gradient).toMatchObject({ angle: 45 })
    // 縦の半径の先を右へ引くと、回す角度は -90°
    expect(dragGradient(radial, { kind: 'radiusY' }, { x: 140, y: 50 }, size, false).gradient).toMatchObject({ ry: 0.4, angle: -90 })
    expect(dragGradient(radial, { kind: 'radiusX' }, { x: 140, y: 52 }, size, true).gradient).toMatchObject({ angle: 0 })
    const circle = dragGradient(radial, { kind: 'radiusX' }, { x: 140, y: 50 }, size, true).gradient
    expect(circle).toMatchObject({ rx: 0.2, ry: 0.4 })
  })

  it('円形の焦点は、ずらしてあればハンドルになり、楕円の中へ動かせる（外なら楕円の上、Shift で近い軸の上）', () => {
    expect(gradientHandles(radial, size).focus).toBeNull()
    const focal = { ...radial, fx: 0.5, fy: -0.5 }
    // 中心 (100, 50)、横の半径 100px・縦の半径 50px
    const handles = gradientHandles(focal, size)
    expect(handles.focus).toEqual({ x: 150, y: 25 })
    expect(gradientPartAt(handles, focal, (point) => Math.hypot(point.x - 150, point.y - 25) < 4)).toEqual({ kind: 'focus' })
    // 中心と重なるときは中心が先（色の印は線の横に離して出すので、ここでは外す）
    const near = { ...gradientHandles({ ...radial, fx: 0.01, fy: 0 }, size), stops: [] }
    expect(gradientPartAt(near, focal, (point) => Math.hypot(point.x - 100, point.y - 50) < 4)).toEqual({ kind: 'center' })
    expect(dragGradient(focal, { kind: 'focus' }, { x: 80, y: 75 }, size, false).gradient).toMatchObject({ fx: -0.2, fy: 0.5 })
    expect(dragGradient(focal, { kind: 'focus' }, { x: 400, y: 50 }, size, false).gradient).toMatchObject({ fx: 1, fy: 0 })
    expect(dragGradient(focal, { kind: 'focus' }, { x: 130, y: 60 }, size, true).gradient).toMatchObject({ fx: 0.3, fy: 0 })
    // 回した楕円では、焦点も回した軸に沿う
    const turned = gradientHandles({ ...radial, angle: 90, fx: 0.5, fy: 0 }, size).focus!
    expect(turned.x).toBeCloseTo(100)
    expect(turned.y).toBeCloseTo(100)
  })

  it('回した円形のハンドルは、回した軸の上', () => {
    const handles = gradientHandles({ ...radial, angle: 90 }, size)
    expect(handles.axis[1].x).toBeCloseTo(100)
    expect(handles.axis[1].y).toBeCloseTo(150)
    expect(handles.radiusY!.x).toBeCloseTo(50)
    expect(handles.radiusY!.y).toBeCloseTo(50)
  })
})

describe('gradientToEdit（ダブルクリックで操作に入る塗り）', () => {
  it('見えている塗りの中で手前のグラデーションを選び、塗りになければ線から探す', () => {
    const solid = paint.fills[0]
    expect(gradientToEdit(rect({ id: 'a', fills: [linear, radial, solid] }))).toEqual({ id: 'a', key: 'fills', index: 1, stop: null })
    expect(gradientToEdit(rect({ id: 'a', fills: [linear, { ...radial, visible: false }] }))).toEqual({ id: 'a', key: 'fills', index: 0, stop: null })
    expect(gradientToEdit(rect({ id: 'a', fills: [solid], strokes: [conic] }))).toEqual({ id: 'a', key: 'strokes', index: 0, stop: null })
    expect(gradientToEdit(rect({ id: 'a', fills: [solid] }))).toBeNull()
  })
})
