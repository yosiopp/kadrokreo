import { LOGO_ACCENT_PATH, LOGO_HEIGHT, LOGO_INK_PATH, LOGO_TRANSFORM, LOGO_WIDTH } from './logoPaths.ts'

/** ヘッダーに出す kadrokreo のワードマーク。インクは文字色、反転した k は --logo-accent で塗る。 */
export function Logo({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox={`0 0 ${LOGO_WIDTH} ${LOGO_HEIGHT}`}
      role="img"
      aria-label="kadrokreo"
    >
      <g transform={LOGO_TRANSFORM}>
        <path fill="currentColor" d={LOGO_INK_PATH} />
        <path fill="var(--logo-accent)" d={LOGO_ACCENT_PATH} />
      </g>
    </svg>
  )
}
