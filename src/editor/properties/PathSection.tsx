import { isLine } from '../../document/path.ts'
import type { NodeId, PathNode } from '../../document/types.ts'
import { VERTEX_KIND_LABELS, optionsOf } from '../../ui/labels.ts'
import { openAtSegment, pathVertices, reshapePath, setVertexKind, setVertexRadius, vertexKind } from '../pathEdit.ts'
import { type PanelContext, MIXED, common } from './context.ts'
import { CheckField, NumberField, Section, SelectField } from './fields.tsx'

/**
 * パスの閉じ方と頂点。頂点の編集中に頂点を選んでいれば、その頂点の種類と角の丸めを、
 * 選んでいなければ（頂点の編集の外でも）全部の頂点の角の丸めを変える。閉じた形の辺を選んでいれば、その辺で開ける
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
    : paths.filter((node) => !isLine(node)).map((node) => [node, node.points.map((_, i) => i)])
  const vertices = targets.flatMap(([node, indices]) => indices.map((i) => node.points[i]))
  const kinds = picked ? pathVertices(edited!).filter((_, i) => picked.includes(i)).map(vertexKind) : []
  const kind = common(kinds)
  const segment = edited && edit?.segment !== null && edit?.segment !== undefined ? edit.segment : null

  const reshape = (change: (id: NodeId) => Parameters<typeof reshapePath>[2]) =>
    store.apply((base) => targets.reduce((scene, [node]) => reshapePath(scene, node.id, change(node.id)), base))

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
            reshape(() => (list, closed) => setVertexKind(list, picked, closed, next))
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
              targets.reduce((scene, [node, indices]) => reshapePath(scene, node.id, (list) => setVertexRadius(list, indices, radius)), base),
            )
          }
        />
      )}
      {edited && segment !== null && edited.closed && (
        <button
          type="button"
          title="選んだ辺を消して、閉じた形を開いた線にする（Delete でも同じ）"
          onClick={() => {
            store.apply((base) => reshapePath(base, edited.id, (list, closed) => openAtSegment(list, closed, segment)))
            store.editVertices({ id: edited.id, vertices: [], segment: null })
          }}
        >
          この辺で開く
        </button>
      )}
      {edited && !picked && segment === null && (
        <p className="panel-hint">頂点をドラッグで囲むか Shift + クリックで複数選べます。辺を押すと辺を選べます。</p>
      )}
    </Section>
  )
}
