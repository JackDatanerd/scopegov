import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import { sanitizePdfText, sanitizeForPdf, PDF_REPLACEMENT_CHAR } from '@/lib/pdf/fonts'
import {
  NOTO_SANS_REGULAR_B64, NOTO_SANS_BOLD_B64, NOTO_SANS_ITALIC_B64, NOTO_SANS_BOLD_ITALIC_B64,
} from '@/lib/pdf/fonts/noto-sans-data'

const require = createRequire(import.meta.url)

describe('sanitizePdfText', () => {
  it('keeps everything the embedded font can draw', () => {
    const ok = 'Michał Żółć — Việt Nam · Čeština · Ştefan Ţurcanu · Проект «Москва» · Ελληνικά · ₦5,000 · “quotes” … © ™'
    expect(sanitizePdfText(ok)).toBe(ok)
  })
  it('replaces what it cannot draw with an explicit marker, one per code point', () => {
    expect(sanitizePdfText('东京')).toBe(PDF_REPLACEMENT_CHAR.repeat(2))
    expect(sanitizePdfText('a → b')).toBe(`a ${PDF_REPLACEMENT_CHAR} b`)
    expect(sanitizePdfText('ok 😀')).toBe(`ok ${PDF_REPLACEMENT_CHAR}`) // one astral code point, one marker
  })
  it('keeps newlines and tabs', () => {
    expect(sanitizePdfText('a\n\tb')).toBe('a\n\tb')
  })
})

describe('sanitizeForPdf', () => {
  it('deep-maps objects and arrays but leaves data URIs and non-strings alone', () => {
    const sig = 'data:image/png;base64,AAAA东京' // never touched, whatever it contains
    const out = sanitizeForPdf({ name: 'Zoë 东', n: 5, ok: true, nil: null, sig, list: [{ t: '日本' }, 'Łódź'] })
    expect(out).toEqual({
      name: `Zoë ${PDF_REPLACEMENT_CHAR}`, n: 5, ok: true, nil: null, sig,
      list: [{ t: PDF_REPLACEMENT_CHAR.repeat(2) }, 'Łódź'],
    })
  })
})

describe('embedded font vs sanitizer (drift guard)', () => {
  // Every character the sanitizer lets through must have a glyph in all four
  // faces, otherwise it would render as silent mojibake again.
  const sample =
    'ABCxyz0123456789 !"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~ ' +
    'ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖ×ØÙÚÛÜÝÞßàáâãäåæçèéêëìíîïðñòóôõö÷øùúûüýþÿ' +
    'ĀāĂăĄąĆćČčĎďĐđĒēĘęĚěĞğĨĩĪīİıŁłŃńŇňŌōŐőŒœŘřŚśŞşŠšŢţŤťŨũŪūŮůŰűŲųŹźŻżŽž' +
    'ẠạẢảẤấẦầẨẩẬậẮắẰằẲẳẶặẸẹẺẻẼẽẾếỀềỂểỆệỈỉỊịỌọỎỏỐốỒồỔổỘộỚớỜờỞởỢợỤụỦủỨứỪừỬửỰựỲỳỴỵỶỷỸỹ' +
    'АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдежзийклмнопрстуфхцчшщъыьэюяЁёІіЇїЄє' +
    'ΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩαβγδεζηθικλμνξοπρστυφχψωάέήίόύώ' +
    '₦₵€£¥₹₽₪₫ ‘’“”„‚‹›«»…•–—‰′″ ©®™°±²³µ¶·¼½¾ ≠≤≥−'
  const faces: Array<[string, string]> = [
    ['regular', NOTO_SANS_REGULAR_B64], ['bold', NOTO_SANS_BOLD_B64],
    ['italic', NOTO_SANS_ITALIC_B64], ['bold-italic', NOTO_SANS_BOLD_ITALIC_B64],
  ]
  for (const [name, b64] of faces) {
    it(`${name} face has a glyph for every character the sanitizer allows`, () => {
      const fontkit = require('fontkit')
      const font = fontkit.create(Buffer.from(b64, 'base64'))
      const passed = sanitizePdfText(sample)
      const missing = Array.from(new Set(Array.from(passed).filter(ch => ch.trim() !== '' && !font.hasGlyphForCodePoint(ch.codePointAt(0)!))))
      expect(missing.join('')).toBe('')
      // and the replacement marker itself must be drawable
      expect(font.hasGlyphForCodePoint(PDF_REPLACEMENT_CHAR.codePointAt(0)!)).toBe(true)
    })
  }
})
