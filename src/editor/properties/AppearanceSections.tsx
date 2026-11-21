import { isInstance } from '../../document/component.ts'
import { normalizeAngle } from '../../document/geometry.ts'
import { IMAGE_MIME_TYPES } from '../../document/kdr.ts'
import { paintColor } from '../../document/paint.ts'
import type { Effect, Paint } from '../../document/types.ts'
import { OpenFileButton } from '../../ui/OpenFile.tsx'
import { CAP_LABELS, FIT_LABELS, optionsOf } from '../../ui/labels.ts'
import {
  patchGradients,
  patchShadows,
  setFill,
  setGradientEnabled,
  setShadow,
  setStroke,
  withStopColor,
} from '../operations/paints.ts'
import { type PanelContext, linesIn, shapesIn, textsIn, common, mapValue } from './context.ts'
import { CheckField, ColorField, NumberField, Section, SelectField } from './fields.tsx'

const DEFAULT_SHADOW: Effect = { type: 'drop-shadow', x: 0, y: 4, blur: 12, color: '#000000', opacity: 0.25 }

/** いちばん上の塗りの代表の色。塗りがなければ null（パネルは、いちばん上の塗りだけを編集する） */
function topColor(paints: readonly Paint[]): string | null {
  const top = paints.at(-1)
  return top ? paintColor(top) : null
}

type Props = {
  ctx: PanelContext
  /** 選んでいる画像を、選んだファイルの画像に差し替える */
  onReplaceImage: (file: File) => void
}

/** 塗り・画像・線・端の形・パス・角丸・影 */
export function AppearanceSections({ ctx, onReplaceImage }: Props) {
  const { store, selection, nodes, apply, inner, hasInstance, overridden } = ctx
  // インスタンスとその中身（写し）の見た目は元に合わせて作り直されるので、変えられるのは上書きできる項目
  // （塗り・線の色。文言はキャンバスで、表示はレイヤー一覧で変える）だけ
  const limited = hasInstance || inner
  const plain = inner ? [] : nodes.filter((node) => !isInstance(node))
  const shapes = shapesIn(nodes)
  const texts = textsIn(nodes)
  const lines = linesIn(nodes)
  const paths = nodes.filter((node) => node.type === 'path')
  const images = nodes.filter((node) => node.type === 'image')
  // 端の形を付けられるもの。閉じたパスには端がない
  const capped = paths.filter((node) => !node.closed)
  const rounded = plain.filter((node) => node.type === 'rect' || node.type === 'frame' || node.type === 'image')
  const filled = [...shapes, ...texts]
  const stroked = [...shapes, ...lines]
  const onlyShapes = shapes.length === nodes.length

  const gradients = shapes.flatMap((node) => {
    const top = node.fills.at(-1)
    return top?.type === 'linear' ? [top] : []
  })
  const gradientEnabled = common(shapes.map((node) => node.fills.at(-1)?.type === 'linear'))
  const shadows = shapes.flatMap((node) => node.effects.slice(0, 1))
  const shadowEnabled = common(shapes.map((node) => node.effects.length > 0))

  return (
    <>
      {filled.length === nodes.length && (
        <Section title="塗り" overridden={overridden.has('fills')}>
          <ColorField
            label="塗り"
            value={common(filled.map((n) => topColor(n.fills)))}
            // テキストは塗りを消せない
            nullable={onlyShapes}
            fallback="#d9d9d9"
            onPreview={(fill) => store.preview((base) => setFill(base, selection, fill))}
            onCommit={store.commitPreview}
            onSet={(fill) => store.apply((base) => setFill(base, selection, fill))}
          />
          {onlyShapes && shapes.every((node) => node.fills.length > 0) && (
            <CheckField
              label="グラデーション"
              value={gradientEnabled}
              onChange={(checked) => store.apply((base) => setGradientEnabled(base, selection, checked))}
            />
          )}
          {gradients.length > 0 && (
            <>
              <span className="section-title">終わりの色</span>
              <ColorField
                label="グラデーションの終わり"
                value={common(gradients.map((gradient) => gradient.stops.at(-1)!.color))}
                nullable={false}
                fallback="#ffffff"
                onPreview={(color) =>
                  store.preview((base) => patchGradients(base, selection, (g) => withStopColor(g, -1, color)))
                }
                onCommit={store.commitPreview}
                onSet={(color) =>
                  store.apply((base) =>
                    patchGradients(base, selection, (g) => withStopColor(g, -1, color ?? '#ffffff')),
                  )
                }
              />
              <NumberField
                label="角度"
                value={common(gradients.map((gradient) => gradient.angle))}
                onCommit={(angle) =>
                  store.apply((base) =>
                    patchGradients(base, selection, (g) => ({ ...g, angle: normalizeAngle(angle) })),
                  )
                }
              />
            </>
          )}
        </Section>
      )}

      {images.length === nodes.length && (
        <Section title="画像" overridden={overridden.has('assetId')}>
          {!inner && (
            <SelectField
              label="収め方"
              value={common(images.map((node) => node.fit))}
              options={optionsOf(FIT_LABELS)}
              onChange={(fit) => apply({ fit })}
            />
          )}
          <OpenFileButton accept={IMAGE_MIME_TYPES.join(',')} onFiles={(files) => onReplaceImage(files[0])}>
            画像を差し替え
          </OpenFileButton>
        </Section>
      )}

      {stroked.length === nodes.length && (
        <Section title="線" overridden={overridden.has('strokes')}>
          <ColorField
            label="線"
            value={common(stroked.map((n) => topColor(n.strokes)))}
            // 直線は線を消せない
            nullable={lines.length === 0}
            fallback="#000000"
            onPreview={(stroke) => store.preview((base) => setStroke(base, selection, stroke))}
            onCommit={store.commitPreview}
            onSet={(stroke) => store.apply((base) => setStroke(base, selection, stroke))}
          />
          {!limited && (
            <NumberField
              label="太さ"
              value={common(stroked.map((n) => n.strokeWidth))}
              min={0}
              onCommit={(strokeWidth) => apply({ strokeWidth })}
            />
          )}
        </Section>
      )}

      {!inner && capped.length > 0 && capped.length === nodes.length && (
        <Section title="端の形">
          <SelectField
            label="始点"
            options={optionsOf(CAP_LABELS)}
            value={common(capped.map((n) => n.startCap))}
            onChange={(startCap) => apply({ startCap })}
          />
          <SelectField
            label="終点"
            options={optionsOf(CAP_LABELS)}
            value={common(capped.map((n) => n.endCap))}
            onChange={(endCap) => apply({ endCap })}
          />
        </Section>
      )}

      {!inner && paths.length === nodes.length && (
        <Section title="パス">
          <CheckField
            label="最後の頂点を最初の頂点につなぐ"
            value={common(paths.map((node) => node.closed))}
            onChange={(checked) => apply({ closed: checked })}
          />
        </Section>
      )}

      {rounded.length === nodes.length && (
        <Section title="角丸">
          <NumberField
            label="半径"
            value={common(rounded.map((n) => n.cornerRadius))}
            min={0}
            onCommit={(cornerRadius) => apply({ cornerRadius })}
          />
        </Section>
      )}

      {onlyShapes && !limited && (
        <Section title="影">
          <CheckField
            label="影を付ける"
            value={shadowEnabled}
            onChange={(checked) => store.apply((base) => setShadow(base, selection, checked ? DEFAULT_SHADOW : null))}
          />
          {shadows.length > 0 && (
            <>
              <div className="field-grid">
                <NumberField
                  label="横"
                  value={common(shadows.map((shadow) => shadow.x))}
                  onCommit={(x) => store.apply((base) => patchShadows(base, selection, { x }))}
                />
                <NumberField
                  label="縦"
                  value={common(shadows.map((shadow) => shadow.y))}
                  onCommit={(y) => store.apply((base) => patchShadows(base, selection, { y }))}
                />
                <NumberField
                  label="ぼかし"
                  value={common(shadows.map((shadow) => shadow.blur))}
                  min={0}
                  onCommit={(blur) => store.apply((base) => patchShadows(base, selection, { blur }))}
                />
                <NumberField
                  label="濃さ"
                  value={mapValue(common(shadows.map((shadow) => shadow.opacity)), (opacity) =>
                    Math.round(opacity * 100),
                  )}
                  min={0}
                  max={100}
                  onCommit={(percent) =>
                    store.apply((base) => patchShadows(base, selection, { opacity: percent / 100 }))
                  }
                />
              </div>
              <ColorField
                label="影"
                value={common(shadows.map((shadow) => shadow.color))}
                nullable={false}
                fallback={DEFAULT_SHADOW.color}
                onPreview={(color) => store.preview((base) => patchShadows(base, selection, { color }))}
                onCommit={store.commitPreview}
                onSet={(color) =>
                  store.apply((base) => patchShadows(base, selection, { color: color ?? DEFAULT_SHADOW.color }))
                }
              />
            </>
          )}
        </Section>
      )}
    </>
  )
}
