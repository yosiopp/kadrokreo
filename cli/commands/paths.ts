import type { NodeId } from '../../src/document/types.ts'
import type { BooleanOp } from '../../src/document/pathBoolean.ts'
import { BOOLEAN_LABELS, MAX_PATH_POINTS, applyMask, booleanPaths, joinPaths, splitPaths } from '../../src/editor/operations/paths.ts'
import { createBooleanNode, fitBooleanNodes, flattenBooleanNodes } from '../../src/editor/operations/booleanNodes.ts'
import { updateNode } from '../../src/editor/operations/tree.ts'
import { outlineStrokes } from '../../src/editor/operations/outline.ts'
import type { MaskType } from '../../src/document/types.ts'
import { UsageError } from '../args.ts'
import { type Command, checkStep, flag, option } from './common.ts'

// パスの結合・分割、マスクとして使う、ブーリアン演算、線の輪郭化

const MASK_TYPES: readonly MaskType[] = ['vector', 'alpha', 'luminance']

export const mask: Command = {
  name: 'mask',
  kind: 'edit',
  usage: 'mask ノード… [--name 名前] [--type vector|alpha|luminance]',
  summary:
    'マスクとして使う（矩形・楕円・パス・テキスト・画像・フレーム）。1 つならそれをマスクにし（同じ親の中で手前のものが、次のマスクまでその形で切り取られる。テキストは文字の形、画像・フレームは枠の形）、いくつもならフレームにまとめて最も背面のものをマスクにする（フレームは「@」で指せる。--name はその名前）。どれもマスクなら、やめる。--type はマスクの種類（vector は形だけ、alpha は塗りの不透明度、luminance は塗りの明るさで透かす。フレームは子の絵も見る。既定は vector）。set ノード isMask=true maskType=luminance でも変えられる',
  run({ session }, step) {
    checkStep(step, { options: ['name', 'type'] })
    const type = option(step, 'type')
    if (type !== undefined && !MASK_TYPES.includes(type as MaskType)) throw new UsageError(`mask: --type は ${MASK_TYPES.join(' / ')} のどれかです`)
    const ids = session.resolveAll(step.positionals)
    let result: NodeId | null = null
    let changed = false
    session.apply((page) => {
      const next = applyMask(page, ids, option(step, 'name') ?? 'Mask group', type as MaskType | undefined)
      changed = next.scene !== page
      result = next.id
      return next.scene
    })
    if (!changed) throw new UsageError('mask: 最も背面のものはマスクにできません（ブーリアン演算のノード）')
    session.last = result === null ? [] : [result]
  },
}

export const join: Command = {
  name: 'join',
  kind: 'edit',
  usage: 'join ノード…',
  summary: '矩形・楕円・パスを 1 つのパスの輪郭にまとめる（最も背面のものの名前・塗り・線を引き継ぎ、残りは消す。まとめたパスは「@」で指せる）',
  run({ session }, step) {
    checkStep(step, {})
    const ids = session.resolveAll(step.positionals)
    const joined = session.applyWith((page) => joinPaths(page, ids))?.id ?? null
    if (joined === null) throw new UsageError('join: 矩形・楕円・パスを 2 つ以上指定してください')
    session.last = [joined]
  },
}

export const split: Command = {
  name: 'split',
  kind: 'edit',
  usage: 'split パス…',
  summary: '輪郭が 2 つ以上あるパスを、輪郭ごとのパスに分ける（分けたパスは「@」で指せる）',
  run({ session }, step) {
    checkStep(step, {})
    const ids = session.resolveAll(step.positionals)
    const parts = session.applyWith((page) => splitPaths(page, ids))?.ids ?? []
    if (parts.length === 0) throw new UsageError('split: 輪郭が 2 つ以上あるパスを指定してください')
    session.last = parts
  },
}

const BOOLEAN_OPS: readonly BooleanOp[] = ['union', 'subtract', 'intersect', 'exclude']

export const boolean: Command = {
  name: 'boolean',
  kind: 'edit',
  usage: 'boolean union|subtract|intersect|exclude ノード… [--keep [--strokes]]',
  flags: ['keep', 'strokes'],
  summary:
    'ブーリアン演算（合体・差し引き・交差・除外）。差し引きは最も背面のものから残りを引く。既定では矩形・楕円・パスの塗りの形にかけ、結果を最も背面のものの名前・塗り・線を引き継いだ 1 つのパス（fillRule=evenodd）にして残りは消す。' +
    '--keep なら元の図形（テキスト以外）を子に残すブーリアン演算のノード（booleanOperation を持つフレーム）にまとめ、子を変えると結果も変わる（演算は set ノード booleanOperation=… で変えられる）。--strokes を付けると、元の図形の線の外形も演算に含める（set ノード booleanIncludeStrokes=true でも変えられる）。結果は「@」で指せる',
  run({ session }, step) {
    checkStep(step, { options: ['keep', 'strokes'] })
    const [op, ...names] = step.positionals
    if (!BOOLEAN_OPS.includes(op as BooleanOp)) throw new UsageError(`boolean: 演算は ${BOOLEAN_OPS.join(' / ')} のどれかです`)
    const ids = session.resolveAll(names)
    const keep = flag(step, 'keep')
    const strokes = flag(step, 'strokes')
    if (strokes && !keep) throw new UsageError('boolean: --strokes は --keep と一緒に指定してください')
    let result: NodeId | null = null
    let error: 'empty' | 'too-many' | undefined
    session.apply((page) => {
      const next = keep ? createBooleanNode(page, ids, op as BooleanOp) : booleanPaths(page, ids, op as BooleanOp)
      result = next.id
      error = 'error' in next ? (next.error as typeof error) : undefined
      return strokes && next.id !== null ? fitBooleanNodes(updateNode(next.scene, next.id, { booleanIncludeStrokes: true })) : next.scene
    })
    const label = BOOLEAN_LABELS[op as BooleanOp]
    if (error === 'empty') throw new UsageError(`boolean: ${label}の結果が空になります`)
    if (error === 'too-many') throw new UsageError(`boolean: ${label}の結果の頂点が ${MAX_PATH_POINTS} を超えます`)
    if (result === null) throw new UsageError(keep ? 'boolean: テキスト以外のものを 2 つ以上指定してください' : 'boolean: 矩形・楕円・パスを 2 つ以上指定してください')
    session.last = [result]
  },
}

export const flatten: Command = {
  name: 'flatten',
  kind: 'edit',
  usage: 'flatten ノード…',
  summary: 'ブーリアン演算のノードを、結果の形のパス（fillRule=evenodd）に焼き込み、元の図形（子）を消す（焼き込んだパスは「@」で指せる）',
  run({ session }, step) {
    checkStep(step, {})
    const ids = session.resolveAll(step.positionals)
    const { ids: flat = [], error } = session.applyWith((page) => flattenBooleanNodes(page, ids)) ?? {}
    if (error === 'empty') throw new UsageError('flatten: 結果が空のブーリアン演算は平らにできません')
    if (error === 'too-many') throw new UsageError(`flatten: 結果の頂点が ${MAX_PATH_POINTS} を超えます`)
    if (flat.length === 0) throw new UsageError('flatten: ブーリアン演算のノードを指定してください')
    session.last = flat
  },
}

export const outlineStroke: Command = {
  name: 'outline-stroke',
  kind: 'edit',
  usage: 'outline-stroke ノード…',
  summary:
    '線の輪郭化。線のある矩形・楕円・パス・ブーリアン演算のノードの線を、線の塗りで塗るパス（線なし）にする。塗りのある図形は線を外して残し、そのすぐ手前に「名前 の線」のパスを置く。塗りのない図形は同じ id のまま置き換える（できたパスは「@」で指せる）',
  run({ session }, step) {
    checkStep(step, {})
    const ids = session.resolveAll(step.positionals)
    const { ids: outlines = [], error } = session.applyWith((page) => outlineStrokes(page, ids)) ?? {}
    if (error === 'too-many') throw new UsageError(`outline-stroke: 線の形の頂点が ${MAX_PATH_POINTS} を超えます`)
    if (outlines.length === 0) throw new UsageError('outline-stroke: 線のある矩形・楕円・パスを指定してください')
    session.last = outlines
  },
}
