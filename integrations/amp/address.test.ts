import { describe, expect, test } from 'bun:test'

import {
	directChildSuffix,
	formatAddress,
	formatThreadTitle,
	lettersToNumber,
	parseAddress,
	parseThreadTitle,
} from './address'

describe('alternating Zettelkasten addresses', () => {
	test.each(['1', '5a', '5a1', '5a1a', '12aa34zz'])('round-trips %s', (value) => {
		expect(formatAddress(parseAddress(value))).toBe(value)
	})

	test.each(['', 'a', '0', '01', '1A', '1a0', '1a01', '1-a', '1aa01'])('rejects %s', (value) => {
		expect(() => parseAddress(value)).toThrow()
	})

	test('uses spreadsheet-style letters', () => {
		expect(lettersToNumber('zz')).toBe(702)
	})

	test('validates direct child lineage', () => {
		expect(directChildSuffix(parseAddress('5'), parseAddress('5aa'))).toBe(27)
		expect(directChildSuffix(parseAddress('5a'), parseAddress('5b1'))).toBeUndefined()
	})
})

describe('thread titles', () => {
	test('separates and normalizes the semantic title', () => {
		expect(parseThreadTitle('5a1   Durable notes')).toEqual({
			address: [5, 'a', 1],
			semanticTitle: 'Durable notes',
		})
		expect(formatThreadTitle([5, 'a', 1], '  Durable notes  ')).toBe('5a1 Durable notes')
	})

	test.each(['Title', '1', '1 ', '01 Invalid'])('rejects malformed title %s', (title) => {
		expect(() => parseThreadTitle(title)).toThrow()
	})
})
