/** Alternating decimal and spreadsheet-letter address segments. */
export type Address = readonly [number, ...(number | string)[]]

export interface ParsedThreadTitle {
	address: Address
	semanticTitle: string
}

export class AddressParseError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'AddressParseError'
	}
}

function isDigit(character: string | undefined): boolean {
	return character !== undefined && character >= '0' && character <= '9'
}

function isLetter(character: string | undefined): boolean {
	return character !== undefined && character >= 'a' && character <= 'z'
}

function parsePositiveDecimal(value: string): number {
	if (value.length === 0 || value[0] === '0') {
		throw new AddressParseError(`decimal segment must be a canonical positive integer: ${value}`)
	}

	const parsed = Number(value)
	if (!Number.isSafeInteger(parsed) || parsed < 1) {
		throw new AddressParseError(`decimal segment is outside the safe positive range: ${value}`)
	}
	return parsed
}

export function lettersToNumber(value: string): number {
	if (value.length === 0) {
		throw new AddressParseError('letter segment cannot be empty')
	}

	let result = 0
	for (const character of value) {
		if (!isLetter(character)) {
			throw new AddressParseError(`letter segment must contain only a-z: ${value}`)
		}
		result = result * 26 + character.charCodeAt(0) - 96
		if (!Number.isSafeInteger(result)) {
			throw new AddressParseError(`letter segment is outside the safe range: ${value}`)
		}
	}
	return result
}

export function parseAddress(value: string): Address {
	if (value.length === 0 || !isDigit(value[0])) {
		throw new AddressParseError(`address must begin with a root integer: ${value}`)
	}

	const segments: (number | string)[] = []
	let position = 0
	while (position < value.length) {
		const segmentStart = position
		const expectsDecimal = segments.length % 2 === 0
		while (
			position < value.length &&
			(expectsDecimal ? isDigit(value[position]) : isLetter(value[position]))
		) {
			position += 1
		}

		if (segmentStart === position) {
			const expected = expectsDecimal ? 'decimal' : 'lowercase letter'
			throw new AddressParseError(`expected ${expected} segment at offset ${position}: ${value}`)
		}

		const segment = value.slice(segmentStart, position)
		segments.push(expectsDecimal ? parsePositiveDecimal(segment) : segment)
	}

	return segments as unknown as Address
}

export function formatAddress(address: Address): string {
	if (address.length === 0) {
		throw new AddressParseError('address must contain a root segment')
	}

	return address
		.map((segment, index) => {
			if (index % 2 === 0) {
				if (typeof segment !== 'number') {
					throw new AddressParseError(`segment ${index} must be decimal`)
				}
				return String(parsePositiveDecimal(String(segment)))
			}

			if (typeof segment !== 'string') {
				throw new AddressParseError(`segment ${index} must use lowercase letters`)
			}
			lettersToNumber(segment)
			return segment
		})
		.join('')
}

export function parseThreadTitle(title: string): ParsedThreadTitle {
	const separator = title.indexOf(' ')
	if (separator < 1) {
		throw new AddressParseError('numbered title must contain an address and semantic title')
	}

	const semanticTitle = title.slice(separator + 1).trim()
	if (semanticTitle.length === 0) {
		throw new AddressParseError('semantic title cannot be empty')
	}

	return { address: parseAddress(title.slice(0, separator)), semanticTitle }
}

export function formatThreadTitle(address: Address, semanticTitle: string): string {
	const normalized = semanticTitle.trim()
	if (normalized.length === 0) {
		throw new AddressParseError('semantic title cannot be empty')
	}
	return `${formatAddress(address)} ${normalized}`
}

export function directChildSuffix(parent: Address, candidate: Address): number | undefined {
	if (candidate.length !== parent.length + 1) return undefined
	for (let index = 0; index < parent.length; index += 1) {
		if (candidate[index] !== parent[index]) return undefined
	}

	const suffix = candidate[candidate.length - 1]
	return typeof suffix === 'string' ? lettersToNumber(suffix) : suffix
}
