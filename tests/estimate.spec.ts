import { describe, expect, it } from 'vitest'
import { estimateTokens, truncateText } from '../src/estimate.ts'

describe('estimateTokens', () => {
  it('prices digits at half a token each', () => {
    expect(estimateTokens('1234')).toBe(2)
  })

  it('prices a word at one token per six letters', () => {
    // 8 letters: 1 + floor(7 / 6) = 2
    expect(estimateTokens('abcdefgh')).toBe(2)
  })

  it('prices other symbols at nine tenths', () => {
    // 3 symbols: ceil(2.7) = 3
    expect(estimateTokens('!!!')).toBe(3)
  })

  it('mixes pieces', () => {
    // 'abcd' → 1, '12' → 1, '.' → 0.9 → total 2.9 → 3
    expect(estimateTokens('abcd12.')).toBe(3)
  })

  it('returns zero for empty text', () => {
    expect(estimateTokens('')).toBe(0)
  })
})

describe('truncateText', () => {
  it('keeps short text', () => {
    expect(truncateText('abc', 5)).toBe('abc')
  })

  it('truncates long text with an ellipsis', () => {
    expect(truncateText('abcdef', 4)).toBe('abc…')
  })
})
