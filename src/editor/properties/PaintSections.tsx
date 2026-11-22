import { normalizeAngle } from '../../document/geometry.ts'
import { linearAngle } from '../../document/paint.ts'
import type { Effect, Gradient, NodeId, Paint, SceneNode } from '../../document/types.ts'
import { EFFECT_TYPE_LABELS, PAINT_TYPE_LABELS, optionsOf } from '../../ui/labels.ts'
import { EyeIcon } from '../icons.tsx'
import {
  MAX_PAINTS,
  MAX_STOPS,
  type PaintKey,
  convertPaint,
  movePaint,
  patchEffectAt,
  patchGradientAt,
  patchPaintAt,
  updateEffects,
  updatePaints,
  withStopAdded,
  withStopColor,
  withStopOffset,
  withLinearAngle,
  withStopRemoved,
} from '../operations/paints.ts'
import type { EditorStore } from '../store.ts'
import type { GradientEdit } from '../editorCanvas/gradientHandles.ts'
import { type Mixed, MIXED, common, mapValue } from './context.ts'
import { CheckField, ColorField, NumberField, Section, SelectField } from './fields.tsx'

// 塗り・線・影（落ち影・内側の影）を複数重ねる欄。行ごとに目のボタンで表示を切り替えられる。選んでいるノードで数と種類が揃っていれば、番目ごとに並べて、
// 番目ごとの値は揃っていなければ「混在」で出す（色を選ぶと、全部のその番目に当たる）。
// 数や種類が揃っていなければ、まとめて置き換えるボタンだけを出す

const DEFAULT_SHADOW: Effect = { type: 'drop-shadow', x: 0, y: 4, blur: 12, color: '#000000', opacity: 0.25, visible: true }

/** 割合（0〜1）を % の欄の値に */
const toPercent = (value: number | Mixed) => mapValue(value, (v) => Math.round(v * 1000) / 10)

type PaintListProps = {
  store: EditorStore
  selection: NodeId[]
  /** key の塗りを持つ、選んでいるノード */
  nodes: SceneNode[]
  paintKey: PaintKey
  /** 節の見出しで、欄の名前の元（「塗り」「線」） */
  title: string
  /** 足すときの色 */
  fallback: string
  /** 空にできない（テキストの塗り・直線の線） */
  required: boolean
  overridden?: boolean
  /** キャンバスで動かしているグラデーション */
  gradientEdit: GradientEdit | null
  /** 線の太さなど、節の下に足す欄 */
  children?: React.ReactNode
}

/** 塗り（または線）の配列を編集する節。上に見えるもの（配列の最後）から並べる */
export function PaintListSection({
  store,
  selection,
  nodes,
  paintKey,
  title,
  fallback,
  required,
  overridden,
  gradientEdit,
  children,
}: PaintListProps) {
  const lists = nodes.map((node) => (node as unknown as Record<PaintKey, Paint[]>)[paintKey])
  const count = common(lists.map((list) => list.length))
  // 番目ごとの種類が揃っているか
  const aligned =
    count !== MIXED && Array.from({ length: count }, (_, i) => common(lists.map((list) => list[i].type))).every((t) => t !== MIXED)
  const update = (change: (paints: readonly Paint[]) => Paint[] | null) =>
    store.apply((base) => updatePaints(base, selection, paintKey, change))
  const solidPaint: Paint = { type: 'solid', color: fallback, opacity: 1, visible: true }
  const canAdd = lists.every((list) => list.length < MAX_PAINTS)

  const addButton = (
    <button
      type="button"
      className="icon-button"
      aria-label={`${title}を足す`}
      title={aligned ? `${title}を上に重ねる` : `${title}を 1 つにまとめて置き換える`}
      disabled={aligned && !canAdd}
      onClick={() => update((paints) => (aligned ? [...paints, solidPaint] : [solidPaint]))}
    >
      +
    </button>
  )

  return (
    <Section title={title} overridden={overridden} action={addButton}>
      {!aligned ? (
        <p className="section-note">選んだものの{title}が違います。+ で 1 つにまとめて置き換えます。</p>
      ) : count === 0 ? (
        // 何もないときは、有効にするチェックで 1 つ足せる
        <ColorField
          label={title}
          value={null}
          nullable
          fallback={fallback}
          onPreview={() => {}}
          onCommit={() => {}}
          onSet={(color) => color !== null && update(() => [{ type: 'solid', color, opacity: 1, visible: true }])}
        />
      ) : (
        Array.from({ length: count }, (_, k) => count - 1 - k).map((index) => (
          <PaintRow
            key={index}
            store={store}
            selection={selection}
            paintKey={paintKey}
            paints={lists.map((list) => list[index])}
            nodes={nodes}
            index={index}
            count={count}
            label={index === count - 1 ? title : `${title} ${count - index}`}
            removable={!required || count > 1}
            gradientEdit={
              gradientEdit && gradientEdit.key === paintKey && gradientEdit.index === index && selection.length === 1 ? gradientEdit : null
            }
            onUpdate={update}
          />
        ))
      )}
      {children}
    </Section>
  )
}

type PaintRowProps = {
  store: EditorStore
  selection: NodeId[]
  paintKey: PaintKey
  /** 選んでいるノードの、この番目の塗り（種類は揃っている） */
  paints: Paint[]
  /** paints と同じ順の、選んでいるノード（直線の向きは枠の大きさで決まる） */
  nodes: SceneNode[]
  /** 配列の番号（先頭が一番下） */
  index: number
  count: number
  label: string
  removable: boolean
  /** この行のグラデーションをキャンバスで動かしているなら、その状態 */
  gradientEdit: GradientEdit | null
  onUpdate: (change: (paints: readonly Paint[]) => Paint[] | null) => void
}

function PaintRow({ store, selection, paintKey, paints, nodes, index, count, label, removable, gradientEdit, onUpdate }: PaintRowProps) {
  const type = paints[0].type
  const patch = (change: (paint: Paint) => Paint) => store.apply((base) => patchPaintAt(base, selection, paintKey, index, change))
  const preview = (change: (paint: Paint) => Paint) => store.preview((base) => patchPaintAt(base, selection, paintKey, index, change))
  const patchGradient = (change: (gradient: Gradient, node: SceneNode) => Gradient) =>
    store.apply((base) => patchGradientAt(base, selection, paintKey, index, change))
  const previewGradient = (change: (gradient: Gradient) => Gradient) =>
    store.preview((base) => patchGradientAt(base, selection, paintKey, index, change))
  const gradients = paints.filter((paint): paint is Gradient => paint.type !== 'solid')
  const stopCount = common(gradients.map((gradient) => gradient.stops.length))

  return (
    <div className="paint-row">
      <div className="paint-row-head">
        <SelectField
          label={`${label}の種類`}
          value={type}
          options={optionsOf(PAINT_TYPE_LABELS)}
          onChange={(next) => patch((paint) => convertPaint(paint, next))}
        />
        <VisibilityButton
          label={label}
          visible={common(paints.map((paint) => paint.visible))}
          onChange={(visible) => patch((paint) => ({ ...paint, visible }))}
        />
        {count > 1 && (
          <>
            <button
              type="button"
              className="icon-button"
              aria-label={`${label}を上へ`}
              title="1 つ上に重ねる"
              disabled={index === count - 1}
              onClick={() => onUpdate((list) => movePaint(list, index, index + 1))}
            >
              ↑
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label={`${label}を下へ`}
              title="1 つ下に重ねる"
              disabled={index === 0}
              onClick={() => onUpdate((list) => movePaint(list, index, index - 1))}
            >
              ↓
            </button>
          </>
        )}
        {removable && (
          <button
            type="button"
            className="icon-button"
            aria-label={`${label}を外す`}
            title="外す"
            onClick={() => onUpdate((list) => list.toSpliced(index, 1))}
          >
            −
          </button>
        )}
      </div>

      {type === 'solid' && (
        <ColorField
          label={label}
          value={common(paints.map((paint) => (paint.type === 'solid' ? paint.color : '')))}
          nullable={false}
          fallback="#000000"
          onPreview={(color) => preview((paint) => ({ type: 'solid', color, opacity: paint.opacity, visible: paint.visible }))}
          onCommit={store.commitPreview}
          onSet={(color) => color !== null && patch((paint) => ({ type: 'solid', color, opacity: paint.opacity, visible: paint.visible }))}
        />
      )}

      <NumberField
        label="不透明度 %"
        value={toPercent(common(paints.map((paint) => paint.opacity)))}
        min={0}
        max={100}
        onCommit={(percent) => patch((paint) => ({ ...paint, opacity: percent / 100 }))}
      />

      {type !== 'solid' && selection.length === 1 && (
        <div className="variant-actions">
          <button
            type="button"
            aria-pressed={gradientEdit !== null}
            title="キャンバスで始点・終点（円形は中心と半径、角度は中心と向き）と色の位置をつかんで動かす。線の上のダブルクリックで色を足し、Delete で選んだ色を消す"
            onClick={() =>
              store.editGradient(gradientEdit ? null : { id: selection[0], key: paintKey, index, stop: null })
            }
          >
            {gradientEdit ? 'キャンバスでの編集を終える' : 'キャンバスで動かす'}
          </button>
        </div>
      )}

      {type === 'linear' && (
        <>
          <NumberField
            label="角度"
            value={common(paints.map((paint, i) => (paint.type === 'linear' ? linearAngle(paint, nodes[i]) : 0)))}
            onCommit={(angle) => patchGradient((g, node) => withLinearAngle(g, node, angle))}
          />
          <div className="field-grid">
            {(
              [
                ['x1', '始点 横 %'],
                ['y1', '始点 縦 %'],
                ['x2', '終点 横 %'],
                ['y2', '終点 縦 %'],
              ] as const
            ).map(([key, name]) => (
              <NumberField
                key={key}
                label={name}
                value={toPercent(common(gradients.map((gradient) => (gradient.type === 'linear' ? gradient[key] : 0))))}
                onCommit={(percent) => patchGradient((g) => (g.type === 'linear' ? { ...g, [key]: percent / 100 } : g))}
              />
            ))}
          </div>
        </>
      )}

      {type === 'conic' && (
        <div className="field-grid">
          {(
            [
              ['cx', '中心 横 %'],
              ['cy', '中心 縦 %'],
            ] as const
          ).map(([key, name]) => (
            <NumberField
              key={key}
              label={name}
              value={toPercent(common(gradients.map((gradient) => (gradient.type === 'conic' ? gradient[key] : 0))))}
              onCommit={(percent) => patchGradient((g) => (g.type === 'conic' ? { ...g, [key]: percent / 100 } : g))}
            />
          ))}
          <NumberField
            label="始まりの角度"
            value={common(gradients.map((gradient) => (gradient.type === 'conic' ? gradient.angle : 0)))}
            onCommit={(angle) => patchGradient((g) => (g.type === 'conic' ? { ...g, angle: normalizeAngle(angle) } : g))}
          />
        </div>
      )}

      {type === 'radial' && (
        <div className="field-grid">
          {(
            [
              ['cx', '中心 横 %'],
              ['cy', '中心 縦 %'],
              ['rx', '半径 横 %'],
              ['ry', '半径 縦 %'],
            ] as const
          ).map(([key, name]) => (
            <NumberField
              key={key}
              label={name}
              value={toPercent(common(gradients.map((gradient) => (gradient.type === 'radial' ? gradient[key] : 0))))}
              min={key === 'rx' || key === 'ry' ? 0 : -Infinity}
              onCommit={(percent) => patchGradient((g) => (g.type === 'radial' ? { ...g, [key]: percent / 100 } : g))}
            />
          ))}
        </div>
      )}

      {type !== 'solid' &&
        (stopCount === MIXED ? (
          <p className="section-note">選んだもので色の数が違います。</p>
        ) : (
          <>
            {gradients[0].stops.map((_, j) => (
              <div key={j} className={gradientEdit?.stop === j ? 'stop-row selected' : 'stop-row'}>
                <ColorField
                  label={`${label}の${j + 1} 番目`}
                  value={common(gradients.map((gradient) => gradient.stops[j].color))}
                  nullable={false}
                  fallback="#ffffff"
                  onPreview={(color) => previewGradient((g) => withStopColor(g, j, color))}
                  onCommit={store.commitPreview}
                  onSet={(color) => color !== null && patchGradient((g) => withStopColor(g, j, color))}
                />
                <NumberField
                  label="位置 %"
                  value={toPercent(common(gradients.map((gradient) => gradient.stops[j].offset)))}
                  min={0}
                  max={100}
                  onCommit={(percent) => patchGradient((g) => withStopOffset(g, j, percent / 100))}
                />
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`${label}の${j + 1} 番目の色を消す`}
                  title={stopCount > 2 ? 'この色を消す' : '2 色より減らせません'}
                  disabled={stopCount <= 2}
                  onClick={() => patchGradient((g) => withStopRemoved(g, j))}
                >
                  ×
                </button>
              </div>
            ))}
            <div className="variant-actions">
              <button
                type="button"
                disabled={stopCount >= MAX_STOPS}
                onClick={() => patchGradient((g) => withStopAdded(g))}
              >
                {label}に色を足す
              </button>
            </div>
          </>
        ))}
    </div>
  )
}

type EffectListProps = {
  store: EditorStore
  selection: NodeId[]
  /** 効果を持つ、選んでいるノード */
  nodes: (SceneNode & { effects: Effect[] })[]
}

/** 影を重ねる節。先頭の影から並べる */
export function EffectListSection({ store, selection, nodes }: EffectListProps) {
  const lists = nodes.map((node) => node.effects)
  const count = common(lists.map((list) => list.length))
  const enabled = common(lists.map((list) => list.length > 0))
  const update = (change: (effects: readonly Effect[]) => Effect[] | null) =>
    store.apply((base) => updateEffects(base, selection, change))

  return (
    <Section title="影">
      <CheckField
        label="影を付ける"
        value={enabled}
        onChange={(checked) => update((effects) => (checked ? (effects.length > 0 ? null : [DEFAULT_SHADOW]) : []))}
      />
      {count === MIXED && enabled !== false && (
        <p className="section-note">選んだもので影の数が違います。</p>
      )}
      {count !== MIXED &&
        Array.from({ length: count }, (_, index) => {
          const shadows = lists.map((list) => list[index])
          const label = index === 0 ? '影' : `影 ${index + 1}`
          const patch = (values: Partial<Effect>) => store.apply((base) => patchEffectAt(base, selection, index, values))
          const kind = common(shadows.map((shadow) => shadow.type))
          return (
            <div key={index} className="paint-row">
              <div className="paint-row-head">
                <SelectField
                  label={`${label}の種類`}
                  value={kind}
                  options={optionsOf(EFFECT_TYPE_LABELS)}
                  onChange={(type) => patch({ type })}
                />
                <VisibilityButton
                  label={label}
                  visible={common(shadows.map((shadow) => shadow.visible))}
                  onChange={(visible) => patch({ visible })}
                />
                {count > 1 && (
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`${label}を外す`}
                    title="外す"
                    onClick={() => update((effects) => effects.toSpliced(index, 1))}
                  >
                    −
                  </button>
                )}
              </div>
              <div className="field-grid">
                <NumberField label="横" value={common(shadows.map((shadow) => shadow.x))} onCommit={(x) => patch({ x })} />
                <NumberField label="縦" value={common(shadows.map((shadow) => shadow.y))} onCommit={(y) => patch({ y })} />
                <NumberField
                  label="ぼかし"
                  value={common(shadows.map((shadow) => shadow.blur))}
                  min={0}
                  onCommit={(blur) => patch({ blur })}
                />
                <NumberField
                  label="濃さ"
                  value={mapValue(common(shadows.map((shadow) => shadow.opacity)), (opacity) => Math.round(opacity * 100))}
                  min={0}
                  max={100}
                  onCommit={(percent) => patch({ opacity: percent / 100 })}
                />
              </div>
              <ColorField
                label={label}
                value={common(shadows.map((shadow) => shadow.color))}
                nullable={false}
                fallback={DEFAULT_SHADOW.color}
                onPreview={(color) => store.preview((base) => patchEffectAt(base, selection, index, { color }))}
                onCommit={store.commitPreview}
                onSet={(color) => color !== null && patch({ color })}
              />
            </div>
          )
        })}
      {count !== MIXED && count > 0 && (
        <div className="variant-actions">
          <button
            type="button"
            disabled={count >= MAX_PAINTS}
            onClick={() => update((effects) => [...effects, DEFAULT_SHADOW])}
          >
            影を足す
          </button>
        </div>
      )}
    </Section>
  )
}

/**
 * 塗り・線・影の表示を切り替える目のボタン（既存のデザインツールの目のアイコン）。隠しても消さずに残る。
 * 選んだもので揃っていなければ（混在）、押すと全部を表示にする
 */
function VisibilityButton({ label, visible, onChange }: { label: string; visible: boolean | Mixed; onChange: (visible: boolean) => void }) {
  const shown = visible === true
  return (
    <button
      type="button"
      className="icon-button"
      aria-label={shown ? `${label}を隠す` : `${label}を表示する`}
      aria-pressed={!shown}
      title={shown ? '隠す（消さずに残す）' : '表示する'}
      onClick={() => onChange(!shown)}
    >
      <EyeIcon off={!shown} />
    </button>
  )
}
