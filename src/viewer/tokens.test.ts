import { describe, expect, it } from 'vitest'
import type { VariableCollection } from '../document/types.ts'
import { variablesCss } from './tokens.ts'

const theme: VariableCollection = {
  id: 'c1',
  name: 'Theme',
  modes: [
    { id: 'l', name: 'Light' },
    { id: 'd', name: 'Dark Mode' },
  ],
  variables: [
    { id: 'p', name: 'color/primary', type: 'color', values: { l: '#5b4cf5', d: '#a99fff' } },
    { id: 'k', name: 'color/link', type: 'color', values: { l: { alias: 'p' }, d: { alias: 'p' } } },
    { id: 's', name: 'space/md', type: 'number', values: { l: 16, d: 16 } },
    { id: 'f', name: 'font/body', type: 'string', values: { l: 'A "B" </style>', d: 'line\nbreak' } },
    { id: 'b', name: 'flag', type: 'boolean', values: { l: true, d: false } },
  ],
}

describe('variablesCss', () => {
  it('最初のモードを :root、ほかを data 属性に書き、別名は var() にする', () => {
    expect(variablesCss([theme], ['k'])).toBe(
      ':root {\n  --color-primary: #5b4cf5;\n  --color-link: var(--color-primary);\n}\n\n' +
        '[data-theme="dark-mode"] {\n  --color-primary: #a99fff;\n  --color-link: var(--color-primary);\n}',
    )
  })

  it('真偽の変数は書かず、文字はエスケープした CSS の文字列にする', () => {
    const css = variablesCss([theme])
    expect(css).toContain('--space-md: 16;')
    expect(css).toContain('--font-body: "A \\22 B\\22  \\3c /style>";')
    expect(css).toContain('--font-body: "line\\a break";')
    expect(css).not.toContain('flag')
    expect(variablesCss([theme], [])).toBe('')
    expect(variablesCss([theme], ['nope'])).toBe('')
  })
})
