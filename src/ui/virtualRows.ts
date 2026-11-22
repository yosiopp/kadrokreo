import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react'

// レイヤー一覧の行を、画面に見えている分（と前後の少し）だけ作る（仮想スクロール）。
// 一覧はパネル（その上にページやコンポーネントの欄がある）ごとスクロールするので、
// 一覧の外側でスクロールしている要素の、見えている範囲と重なる行を出す。行の高さは CSS の .layer-row と同じ固定値。

/** 行の高さ（px）。index.css の .layer-row の height と揃える */
export const ROW_HEIGHT = 28
/** 見えている範囲の前後に余分に作る行の数。速くスクロールしても空白が見えにくいように */
const OVERSCAN = 20
/** 測る前（最初の描画）に作る行の数。たいていの画面を埋める */
const INITIAL_ROWS = 80

export type RowRange = { start: number; end: number }

/**
 * 一覧の先頭からの位置で top〜bottom（px）が見えているとき、作る行の範囲 [start, end)。
 * 見えている範囲が一覧と重ならなくても、空にはしない（前後の余分は残す）
 */
export function visibleRows(top: number, bottom: number, count: number, rowHeight = ROW_HEIGHT, overscan = OVERSCAN): RowRange {
  const first = Math.floor(Math.max(0, top) / rowHeight)
  const last = Math.ceil(Math.max(0, bottom) / rowHeight)
  const start = Math.max(0, Math.min(count, first) - overscan)
  const end = Math.min(count, Math.max(start, last) + overscan)
  return { start, end }
}

function scrollParent(element: HTMLElement): HTMLElement | null {
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const { overflowY } = getComputedStyle(parent)
    if (overflowY === 'auto' || overflowY === 'scroll') return parent
  }
  return null
}

/**
 * list（一覧の要素）の中の count 行のうち、作る範囲。スクロール・大きさの変化・描き直しのたびに測り直す。
 * 行を作らない分は、一覧の上下の余白（paddingTop / paddingBottom に足す値）で高さを保つ
 */
export function useVirtualRows(list: RefObject<HTMLElement | null>, count: number) {
  const [range, setRange] = useState<RowRange>({ start: 0, end: INITIAL_ROWS })
  const countRef = useRef(count)

  // スクロールのたびに呼ぶので、関数は作り直さない（行の数は countRef から読む）
  const [measure] = useState(() => () => {
    const element = list.current
    if (!element) return
    const parent = scrollParent(element)
    const listTop = element.getBoundingClientRect().top
    const view = parent ? parent.getBoundingClientRect() : { top: 0, bottom: window.innerHeight }
    const next = visibleRows(view.top - listTop, view.bottom - listTop, countRef.current)
    setRange((current) => (current.start === next.start && current.end === next.end ? current : next))
  })

  // 行の数や上の欄の高さが変わると、見えている行も変わる。描くたびに測る（描く前に直すので、ちらつかない）
  useLayoutEffect(() => {
    countRef.current = count
    measure()
  })

  useEffect(() => {
    const element = list.current
    if (!element) return
    const target: HTMLElement | Window = scrollParent(element) ?? window
    target.addEventListener('scroll', measure, { passive: true })
    window.addEventListener('resize', measure)
    const observer = new ResizeObserver(measure)
    if (target instanceof HTMLElement) observer.observe(target)
    return () => {
      target.removeEventListener('scroll', measure)
      window.removeEventListener('resize', measure)
      observer.disconnect()
    }
  }, [list, measure])

  const start = Math.min(range.start, count)
  const end = Math.min(range.end, count)
  return { start, end, before: start * ROW_HEIGHT, after: (count - end) * ROW_HEIGHT }
}
