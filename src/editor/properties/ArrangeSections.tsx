import { isLine } from '../../document/path.ts'
import { followsConstraints, sizeLimited } from '../../document/autoLayout.ts'
import { normalizeAngle } from '../../document/geometry.ts'
import { AlignIcon } from '../icons.tsx'
import { setLayoutFill, setLayoutPositioning } from '../layout.ts'
import { fitTextNodes } from '../measure.ts'
import { type Alignment, alignNodes, distributeNodes } from '../operations/arrange.ts'
import { setSize } from '../operations/transform.ts'
import { patchNodes } from '../operations/tree.ts'
import { type PanelContext, textsIn, common, mapValue } from './context.ts'
import { CheckField, NumberField, Section, SelectField } from './fields.tsx'
import { CONSTRAINT_LABELS, optionsOf } from '../../ui/labels.ts'
import type { Constraint } from '../../document/types.ts'

const ALIGNMENTS: { alignment: Alignment; label: string }[] = [
  { alignment: 'left', label: '左揃え' },
  { alignment: 'center', label: '左右中央揃え' },
  { alignment: 'right', label: '右揃え' },
  { alignment: 'top', label: '上揃え' },
  { alignment: 'middle', label: '上下中央揃え' },
  { alignment: 'bottom', label: '下揃え' },
]

/** 大きさの下限・上限の欄 */
const LIMIT_FIELDS = [
  ['minWidth', '最小 W', 'width'],
  ['maxWidth', '最大 W', 'width'],
  ['minHeight', '最小 H', 'height'],
  ['maxHeight', '最大 H', 'height'],
] as const

/** 整列・位置とサイズ・並び・親いっぱいに伸ばす・大きさの下限と上限・不透明度。インスタンスの中身では出さない */
export function ArrangeSections({ ctx }: { ctx: PanelContext }) {
  const { store, page, selection, nodes, apply, hasInstance } = ctx
  // 大きさを数値で決める。テキストは折り返しに、自動で並べるフレームはその向きが固定になる
  const resize = (size: { width?: number; height?: number }) =>
    store.apply((base) => fitTextNodes(setSize(base, selection, size), selection))

  // 自動で並べるフレームの子だけを選んでいれば、親いっぱいに伸ばす指定ができる
  const inLayout = nodes.every((node) => {
    const parent = node.parentId === null ? null : page.nodes[node.parentId]
    return parent?.type === 'frame' && parent.layout !== null
  })
  // 大きさの下限・上限は、大きさを自動で決める向き（親いっぱい・中身に合わせる）でだけ効くので、その向きの欄だけ出す
  const limitAxes = {
    width: nodes.every((node) => sizeLimited(page, node).width),
    height: nodes.every((node) => sizeLimited(page, node).height),
  }
  // 親の辺への追従は、並べないフレームの子と、並びから外した子だけが持つ
  const constrained = nodes.every((node) => followsConstraints(node.parentId === null ? undefined : page.nodes[node.parentId], node))
  const setConstraint = (axis: 'horizontal' | 'vertical', value: Constraint) =>
    store.apply((base) =>
      patchNodes(base, selection, (node) => ({ constraints: { ...node.constraints, [axis]: value } })),
    )
  const hasText = textsIn(nodes).length > 0
  // 直線は水平・垂直にできるよう、幅や高さが 0 でもよい
  const minSize = nodes.some(isLine) ? 0 : 1
  // 1 つだけのときは親フレームに揃えるので、ページ直下では揃える先がない
  const canAlign = nodes.length > 1 || nodes[0].parentId !== null

  return (
    <>
      <Section title="整列">
        <div className="button-row">
          {ALIGNMENTS.map(({ alignment, label }) => (
            <button
              key={alignment}
              type="button"
              className="icon-button"
              title={label}
              aria-label={label}
              disabled={!canAlign}
              onClick={() => store.apply((base) => alignNodes(base, selection, alignment))}
            >
              <AlignIcon kind={alignment} />
            </button>
          ))}
          {(['x', 'y'] as const).map((axis) => {
            const label = axis === 'x' ? '左右に等間隔' : '上下に等間隔'
            return (
              <button
                key={axis}
                type="button"
                className="icon-button"
                title={label}
                aria-label={label}
                disabled={nodes.length < 3}
                onClick={() => store.apply((base) => distributeNodes(base, selection, axis))}
              >
                <AlignIcon kind={axis === 'x' ? 'distribute-x' : 'distribute-y'} />
              </button>
            )
          })}
        </div>
      </Section>

      <Section title="位置とサイズ">
        <div className="field-grid">
          <NumberField label="X" value={common(nodes.map((n) => n.x))} onCommit={(x) => apply({ x })} />
          <NumberField label="Y" value={common(nodes.map((n) => n.y))} onCommit={(y) => apply({ y })} />
          <NumberField
            label="W"
            value={common(nodes.map((n) => n.width))}
            min={minSize}
            // インスタンスの大きさは元と同じ
            disabled={hasInstance}
            // テキストは幅を決めると、その幅で折り返すようになる
            onCommit={(width) => resize({ width })}
          />
          <NumberField
            label="H"
            value={common(nodes.map((n) => n.height))}
            min={minSize}
            // テキストの高さは中身で決まる
            disabled={hasText || hasInstance}
            onCommit={(height) => resize({ height })}
          />
          <NumberField
            label="回転"
            value={common(nodes.map((n) => n.rotation))}
            onCommit={(rotation) => apply({ rotation: normalizeAngle(rotation) })}
          />
        </div>
      </Section>

      {inLayout && (
        <Section title="並び">
          <CheckField
            label="並びから外す（位置を自由に決める）"
            value={common(nodes.map((n) => n.layoutPositioning === 'absolute'))}
            onChange={(checked) =>
              store.apply((base) => setLayoutPositioning(base, selection, checked ? 'absolute' : 'auto'))
            }
          />
          {nodes.every((n) => n.layoutPositioning === 'auto') && (
            <p className="section-note">並べる向きの矢印キーで、順番を入れ替えられます。</p>
          )}
        </Section>
      )}

      {constrained && (
        <Section title="親の辺に固定">
          <div className="field-grid">
            {(['horizontal', 'vertical'] as const).map((axis) => (
              <SelectField
                key={axis}
                label={axis === 'horizontal' ? '横' : '縦'}
                value={common(nodes.map((n) => n.constraints[axis]))}
                options={optionsOf(CONSTRAINT_LABELS[axis])}
                onChange={(value: Constraint) => setConstraint(axis, value)}
              />
            ))}
          </div>
          <p className="section-note">親の大きさを変えたとき、選んだ辺からの距離を保ちます。</p>
        </Section>
      )}

      {inLayout && nodes.every((n) => n.layoutPositioning === 'auto') && (
        <Section title="親いっぱいに伸ばす">
          <div className="button-row">
            <CheckField
              label="幅"
              value={common(nodes.map((n) => n.sizing.width === 'fill'))}
              onChange={(checked) => store.apply((base) => setLayoutFill(base, selection, 'width', checked))}
            />
            {!hasText && (
              <CheckField
                label="高さ"
                value={common(nodes.map((n) => n.sizing.height === 'fill'))}
                onChange={(checked) => store.apply((base) => setLayoutFill(base, selection, 'height', checked))}
              />
            )}
          </div>
          <p className="section-note">
            並べる向きなら余った場所を分け合い、直交する向きなら余白の内側いっぱいに広がります。
          </p>
        </Section>
      )}

      {!hasInstance && (limitAxes.width || limitAxes.height) && (
        <Section title="大きさの下限・上限">
          <div className="field-grid">
            {LIMIT_FIELDS.filter(([, , axis]) => limitAxes[axis]).map(([key, label]) => (
              <NumberField
                key={key}
                label={label}
                value={common(nodes.map((n) => n[key]))}
                min={0}
                onCommit={(value) => apply({ [key]: value })}
                onClear={() => apply({ [key]: null })}
              />
            ))}
          </div>
          <p className="section-note">空欄にすると、決めない状態に戻ります。</p>
        </Section>
      )}

      <Section title="不透明度">
        <NumberField
          label="%"
          value={mapValue(common(nodes.map((n) => n.opacity)), (opacity) => Math.round(opacity * 100))}
          min={0}
          max={100}
          onCommit={(percent) => apply({ opacity: percent / 100 })}
        />
      </Section>
    </>
  )
}
