import { describe, expect, it } from 'vitest'
import { buildSelector, findQuote } from '../../src/shared/textQuote'

const TEXT =
  'The quick brown fox jumps over the lazy dog. ' +
  'A second sentence mentions the fox again. ' +
  'And a third sentence closes the paragraph.'

describe('buildSelector', () => {
  it('captures exact quote with surrounding context', () => {
    const start = TEXT.indexOf('jumps')
    const sel = buildSelector(TEXT, start, start + 'jumps over'.length)!
    expect(sel.exact).toBe('jumps over')
    expect(sel.prefix.endsWith('brown fox ')).toBe(true)
    expect(sel.suffix.startsWith(' the lazy dog')).toBe(true)
  })

  it('clamps context at text boundaries', () => {
    const sel = buildSelector(TEXT, 0, 3)!
    expect(sel).toEqual({ exact: 'The', prefix: '', suffix: TEXT.slice(3, 35) })
    const end = buildSelector(TEXT, TEXT.length - 10, TEXT.length)!
    expect(end.suffix).toBe('')
  })

  it('trims whitespace-padded selections and rejects whitespace-only ones', () => {
    const start = TEXT.indexOf(' quick ')
    const sel = buildSelector(TEXT, start, start + ' quick '.length)!
    expect(sel.exact).toBe('quick')
    expect(buildSelector(TEXT, 3, 4)).toBeNull()
  })
})

describe('findQuote', () => {
  it('finds a unique quote at its original offsets', () => {
    const start = TEXT.indexOf('lazy dog')
    const sel = buildSelector(TEXT, start, start + 'lazy dog'.length)!
    expect(findQuote(TEXT, sel)).toEqual({ start, end: start + 'lazy dog'.length })
  })

  it('disambiguates repeated quotes by context', () => {
    const second = TEXT.indexOf('fox', TEXT.indexOf('fox') + 1)
    const sel = buildSelector(TEXT, second, second + 3)!
    expect(findQuote(TEXT, sel)).toEqual({ start: second, end: second + 3 })
  })

  it('falls back to the earliest occurrence when context matches nothing', () => {
    const first = TEXT.indexOf('fox')
    const match = findQuote(TEXT, { exact: 'fox', prefix: 'zzz', suffix: 'zzz' })
    expect(match).toEqual({ start: first, end: first + 3 })
  })

  it('matches across whitespace differences (line breaks vs spaces)', () => {
    const sel = { exact: 'jumps\nover the', prefix: 'brown  fox\n', suffix: ' lazy' }
    const start = TEXT.indexOf('jumps over the')
    expect(findQuote(TEXT, sel)).toEqual({ start, end: start + 'jumps over the'.length })
  })

  it('maps offsets back correctly when the haystack has collapsed whitespace', () => {
    const hay = 'alpha   beta\n\ngamma delta'
    const match = findQuote(hay, { exact: 'beta gamma', prefix: 'alpha ', suffix: ' delta' })!
    expect(hay.slice(match.start, match.end)).toBe('beta\n\ngamma')
  })

  it('does not match a quote broken by hyphenation (degrade case, spec §4)', () => {
    const hay = 'This is an inter-\nnational agreement between parties.'
    expect(findQuote(hay, { exact: 'international', prefix: 'is an ', suffix: ' agreement' })).toBeNull()
  })

  it('returns null for absent or empty quotes', () => {
    expect(findQuote(TEXT, { exact: 'unicorn', prefix: '', suffix: '' })).toBeNull()
    expect(findQuote(TEXT, { exact: '   ', prefix: '', suffix: '' })).toBeNull()
    expect(findQuote('', { exact: 'fox', prefix: '', suffix: '' })).toBeNull()
  })

  it('round-trips build → find for every occurrence of an ambiguous word', () => {
    for (const word of ['sentence', 'the']) {
      for (let i = TEXT.indexOf(word); i >= 0; i = TEXT.indexOf(word, i + 1)) {
        const sel = buildSelector(TEXT, i, i + word.length)!
        expect(findQuote(TEXT, sel)).toEqual({ start: i, end: i + word.length })
      }
    }
  })
})
