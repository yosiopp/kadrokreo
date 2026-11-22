import { isLine, pathContours } from '../../document/path.ts'
import type { PathNode } from '../../document/types.ts'
import { VERTEX_KIND_LABELS, optionsOf } from '../../ui/labels.ts'
import {
  editByContour,
  flatVertices,
  locateVertex,
  openAtSegment,
  reshapeContours,
  setVertexKind,
  setVertexRadius,
  vertexKind,
  withFlatVertices,
} from '../pathEdit.ts'
import { type PanelContext, MIXED, common } from './context.ts'
import { CheckField, NumberField, Section, SelectField } from './fields.tsx'

/**
 * パスの閉じ方と頂点。頂点の編集中に頂点を選んでいれば、その頂点の種類と角の丸めを、
 * 選んでいなければ（頂点の編集の外でも）全部の頂点の角の丸めを変える。閉じた形の辺を選んでいれば、その辺で開ける。
 * 頂点と辺の番号は、全部の輪郭（穴など）をつないだ通し番号（pathEdit.ts）
 */
export function PathSection({ ctx }: { ctx: PanelContext }) {
  const { store, state, nodes, apply, inner } = ctx
  const paths = nodes.filter((node) => node.type === 'path')
  if (inner || paths.length !== nodes.length) return null
  const edit = state.vertexEdit
  const edited = edit && paths.length === 1 && paths[0].id === edit.id ? paths[0] : null
  const picked = edited && edit && edit.vertices.length > 0 ? edit.vertices : null
  // 角の丸めを変える頂点。直線は丸める角がない
  const targets: [PathNode, number[]][] = picked
    ? [[edited!, picked]]
    : paths.filter((node) => !isLine(node)).map((node) => [node, flatVertices(pathContours(node)).map((_, i) => i)])
  const vertices = targets.flatMap(([node, indices]) => {
    const all = flatVertices(pathContours(node))
    return indices.flatMap((i) => all[i] ?? [])
  })
  const kinds = vertices.map(vertexKind)
  const kind = common(kinds)
  const contours = edited ? pathContours(edited) : []
  const segment = edited && edit?.segment !== null && edit?.segment !== undefined ? edit.segment : null
  // 選んだ辺の輪郭が閉じていれば、その辺で開ける
  const segmentContour = segment !== null ? locateVertex(contours, segment) : null
  const segmentClosed = segmentContour !== null && contours[segmentContour.contour].closed
  const pickedContours = [...new Set((picked ?? []).flatMap((i) => locateVertex(contours, i)?.contour ?? []))].toSorted((a, b) => a - b)

  return (
    <Section title="パス">
      <CheckField
        label="最後の頂点を最初の頂点につなぐ"
        value={common(paths.map((node) => node.closed))}
        onChange={(checked) => apply({ closed: checked })}
      />
      {picked && (
        <SelectField
          label="頂点の種類"
          options={optionsOf(VERTEX_KIND_LABELS)}
          // 折れた曲線（制御点が一直線でない）は、角となめらかのどちらでもない
          value={kind === 'curve' ? MIXED : kind}
          onChange={(next) => {
            if (next === 'curve') return
            store.apply((base) =>
              reshapeContours(base, edited!.id, (all) =>
                editByContour(all, picked, (list, closed, local) => setVertexKind(list, local, closed, next)),
              ),
            )
          }}
        />
      )}
      {vertices.length > 0 && (
        <NumberField
          label={picked ? '角の丸め' : '頂点の角の丸め'}
          value={common(vertices.map((point) => point.radius ?? 0))}
          min={0}
          onCommit={(radius) =>
            store.apply((base) =>
              targets.reduce(
                (scene, [node, indices]) =>
                  reshapeContours(scene, node.id, (all) => withFlatVertices(all, setVertexRadius(flatVertices(all), indices, radius))),
                base,
              ),
            )
          }
        />
      )}
      {edited && segment !== null && segmentClosed && (
        <button
          type="button"
          title="選んだ辺を消して、閉じた形を開いた線にする（Delete でも同じ）"
          onClick={() => {
            store.apply((base) =>
              reshapeContours(base, edited.id, (all) =>
                editByContour(all, [segment], (list, closed, [local]) => openAtSegment(list, closed, local)),
              ),
            )
            store.editVertices({ id: edited.id, vertices: [], segment: null })
          }}
        >
          この辺で開く
        </button>
      )}
      {edited && contours.length > 1 && (picked || segmentContour) && (
        <p className="panel-hint">
          {picked
            ? `輪郭 ${pickedContours.map((i) => i + 1).join('・')} / ${contours.length} の頂点を選んでいます。輪郭の頂点を全部選んで Delete を押すと、その輪郭ごと消せます。`
            : `輪郭 ${segmentContour!.contour + 1} / ${contours.length} の辺を選んでいます。`}
        </p>
      )}
      {edited && !picked && segment === null && (
        <p className="panel-hint">
          頂点をドラッグで囲むか Shift + クリックで複数選べます。辺を押すと辺を選べます。
          {contours.length > 1 && ` 穴などの輪郭（${contours.length - 1} つ）の頂点も同じように編集できます。`}
        </p>
      )}
    </Section>
  )
}
