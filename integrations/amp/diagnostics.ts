import { randomUUID } from 'node:crypto'
import { appendFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const cacheRoot = process.env.XDG_CACHE_HOME ?? join(process.env.HOME ?? '.', '.cache')
const diagnosticPath = join(cacheRoot, 'amp', 'logs', 'zettelkasten.log')
let writes = Promise.resolve()

export function diagnosticLogPath(): string {
	return diagnosticPath
}

export function newTraceID(): string {
	return randomUUID().slice(0, 8)
}

export function logDiagnostic(event: string, fields: Record<string, unknown> = {}): Promise<void> {
	const line = `${JSON.stringify({ timestamp: new Date().toISOString(), event, ...fields })}\n`
	writes = writes
		.then(async () => {
			await mkdir(dirname(diagnosticPath), { recursive: true })
			await appendFile(diagnosticPath, line, { encoding: 'utf8', mode: 0o600 })
		})
		.catch((error) => {
			console.error(`[zettelkasten] Failed to write diagnostics: ${error instanceof Error ? error.message : String(error)}`)
		})
	return writes
}
