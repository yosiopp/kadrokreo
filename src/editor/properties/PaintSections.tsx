import { normalizeAngle } from '../../document/geometry.ts'
import type { Effect, Gradient, NodeId, Paint, SceneNode } from '../../document/types.ts'
import { PAINT_TYPE_LABELS, optionsOf } from '../../ui/labels.ts'
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
  withStopRemoved,
} from '../operations/paints.ts'
import type { EditorStore } from '../store.ts'
import { type Mixed, MIXED, common, mapValue } from './context.ts'
import { CheckField, ColorField, NumberField, Section, SelectField } from './fields.tsx'

// 塗り・線・影を複数重ねる欄。選んでいるノードで数と種類が揃っていれば、番目ごとに並べて、
// 番目ごとの値は揃っていなければ「混在」で出す（色を選ぶと、全部のその番目に当たる）。
// 数や種類が揃っていなければ、まとめて置き換えるボタンだけを出す

const DEFAULT_SHADOW: Effect = { type: 'drop-shadow', x: 0, y: 4, blur: 12, color: '#000000', opacity: 0.25 }

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
  /** 線の太さなど、節の下に足す欄 */
  children?: React.ReactNode
}

/** 塗り（または線）の配列を編集する節。上に見えるもの（配列の最後）から並べる */
export function PaintListSection({ store, selection, nodes, paintKey, title, fallback, required, overridden, children }: PaintListProps) {
  const lists = nodes.map((node) => (node as unknown as Record<PaintKey, Paint[]>)[paintKey])
  const count = common(lists.map((list) => list.length))
  // 番目ごとの種類が揃っているか
  const aligned =
    count !== MIXED && Array.from({ length: count }, (_, i) => common(lists.map((list) => list[i].type))).every((t) => t !== MIXED)
  const update = (change: (paints: readonly Paint[]) => Paint[] | null) =>
    store.apply((base) => updatePaints(base, selection, paintKey, change))
  const solidPaint: Paint = { type: 'solid', color: fallback }
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
          onSet={(color) => color !== null && update(() => [{ type: 'solid', color }])}
        />
      ) : (
        Array.from({ length: count }, (_, k) => count - 1 - k).map((index) => (
          <PaintRow
            key={index}
            store={store}
            selection={selection}
            paintKey={paintKey}
            paints={lists.map((list) => list[index])}
            index={index}
            count={count}
            label={index === count - 1 ? title : `${title} ${count - index}`}
            removable={!required || count > 1}
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
  /** 配列の番号（先頭が一番下） */
  index: number
  count: number
  label: string
  removable: boolean
  onUpdate: (change: (paints: readonly Paint[]) => Paint[] | null) => void
}

function PaintRow({ store, selection, paintKey, paints, index, count, label, removable, onUpdate }: PaintRowProps) {
  const type = paints[0].type
  const patch = (change: (paint: Paint) => Paint) => store.apply((base) => patchPaintAt(base, selection, paintKey, index, change))
  const preview = (change: (paint: Paint) => Paint) => store.preview((base) => patchPaintAt(base, selection, paintKey, index, change))
  const patchGradient = (change: (gradient: Gradient) => Gradient) =>
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
          onPreview={(color) => preview(() => ({ type: 'solid', color }))}
          onCommit={store.commitPreview}
          onSet={(color) => color !== null && patch(() => ({ type: 'solid', color }))}
        />
      )}

      {type === 'linear' && (
        <NumberField
          label="角度"
          value={common(gradients.map((gradient) => (gradient.type === 'linear' ? gradient.angle : 0)))}
          onCommit={(angle) => patchGradient((g) => (g.type === 'linear' ? { ...g, angle: normalizeAngle(angle) } : g))}
        />
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
              <div key={j} className="stop-row">
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
          const patch = (values: Partial<Omit<Effect, 'type'>>) =>
            store.apply((base) => patchEffectAt(base, selection, index, values))
          return (
            <div key={index} className="paint-row">
              {count > 1 && (
                <div className="paint-row-head">
                  <span className="section-title">{label}</span>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`${label}を外す`}
                    title="外す"
                    onClick={() => update((effects) => effects.toSpliced(index, 1))}
                  >
                    −
                  </button>
                </div>
              )}
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
