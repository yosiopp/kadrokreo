import { describe, expect, it } from 'vitest'
import { type XmlTag, lineCounter, readXml } from './xml.ts'

function events(source: string, options: { positions?: boolean; strict?: boolean } = {}) {
  const out: unknown[] = []
  readXml(
    source,
    {
      open: (tag: XmlTag) => out.push(['open', tag.name, tag.attributes, tag.selfClosing]),
      close: (name) => out.push(['close', name]),
      text: (value) => out.push(['text', value]),
    },
    { fail: (message, offset) => new Error(`${offset}: ${message}`), ...options },
  )
  return out
}

describe('readXml', () => {
  it('要素・属性・文字・CDATA を読み、コメント・処理命令・宣言は飛ばす', () => {
    expect(events(`<?xml version="1.0"?><!-- c --><a x="1" y='2'><b/>t &amp; &#x41;<![CDATA[<raw&amp;>]]></a>`)).toEqual([
      ['open', 'a', { x: '1', y: '2' }, false],
      ['open', 'b', {}, true],
      ['text', 't & A'],
      ['text', '<raw&amp;>'],
      ['close', 'a'],
    ])
  })

  it('属性の値の実体を展開し、知らない実体はそのまま残す', () => {
    expect(events('<a t="&lt;&quot;&nope;"/>')).toEqual([['open', 'a', { t: '<"&nope;' }, true]])
  })

  it('閉じていないものは、位置を付けたエラーにする', () => {
    expect(() => events('<a><!-- x')).toThrow('3: コメントが閉じていません')
    expect(() => events('<a x=1>')).toThrow('属性が読めません: <a>')
    expect(() => events('<a x="1"')).toThrow('属性が読めません: <a>')
  })

  it('strict なら、同じ名前の属性をエラーにする（指定しなければ後のものが勝つ）', () => {
    expect(events('<a x="1" x="2"/>')).toEqual([['open', 'a', { x: '2' }, true]])
    expect(() => events('<a x="1" x="2"/>', { strict: true })).toThrow('属性が重複しています: x')
  })

  it('positions なら、要素と属性の位置を渡す', () => {
    const tags: XmlTag[] = []
    const source = '<a>\n  <b x="1"\n     y="2"/>\n</a>'
    readXml(source, { open: (tag) => tags.push(tag), close: () => {}, text: () => {} }, { fail: (message) => new Error(message), positions: true })
    const lineOf = lineCounter(source)
    expect(lineOf(tags[1].offset)).toBe(2)
    expect(lineOf(tags[1].attributeOffsets!.x)).toBe(2)
    expect(lineOf(tags[1].attributeOffsets!.y)).toBe(3)
  })
})

describe('lineCounter', () => {
  it('文字の位置を 1 から数えた行番号にする', () => {
    const lineOf = lineCounter('ab\ncd\n\nef')
    expect([0, 2, 3, 5, 6, 7, 9].map(lineOf)).toEqual([1, 1, 2, 2, 3, 4, 4])
    expect(lineCounter('')(0)).toBe(1)
  })
})
