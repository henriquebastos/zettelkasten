import { chmod, lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'

import { configurationDirectory, HierarchyError, type RuntimeEnvironment, invokedDirectly } from './index.ts'

export async function saveConfiguration(environment: RuntimeEnvironment, serviceURL: string, namespaceID: string, capability: string): Promise<void> {
	const values = [serviceURL.trim(), namespaceID.trim(), capability.trim()]
	if (values.some((value) => !value)) throw new HierarchyError('Service URL, namespace ID, and namespace capability are required.')
	let parsed: URL
	try { parsed = new URL(values[0]) } catch { throw new HierarchyError('Service URL is invalid.') }
	if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') throw new HierarchyError('Service URL must use HTTPS outside local development.')
	if (parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname !== '/' && parsed.pathname !== '')) throw new HierarchyError('Service URL must be an origin without credentials, path, query, or fragment.')
	const directory = configurationDirectory(environment)
	await mkdir(directory, { recursive: true, mode: 0o700 })
	const metadata = await lstat(directory)
	if (metadata.isSymbolicLink() || !metadata.isDirectory() || (process.getuid !== undefined && metadata.uid !== process.getuid())) throw new HierarchyError('Pi Zettelkasten directory is not private and user-owned.')
	await chmod(directory, 0o700)
	const nonce = randomUUID()
	const settings = resolve(directory, 'config.json')
	const credential = resolve(directory, 'capability')
	const temporarySettings = `${settings}.${nonce}.tmp`
	const temporaryCredential = `${credential}.${nonce}.tmp`
	try {
		await writeFile(temporarySettings, `${JSON.stringify({ serviceURL: parsed.origin, namespaceID: values[1] }, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
		await writeFile(temporaryCredential, `${values[2]}\n`, { mode: 0o600, flag: 'wx' })
		await rename(temporarySettings, settings)
		await rename(temporaryCredential, credential)
		await chmod(settings, 0o600)
		await chmod(credential, 0o600)
	} finally {
		await rm(temporarySettings, { force: true })
		await rm(temporaryCredential, { force: true })
	}
}

async function readCapability(): Promise<string> {
	if (!stdin.isTTY) {
		let value = ''
		for await (const chunk of stdin) value += chunk
		return value.trim()
	}
	const readline = createInterface({ input: stdin, output: stdout, terminal: true })
	const mutable = readline as unknown as { _writeToOutput?: (text: string) => void }
	const original = mutable._writeToOutput
	mutable._writeToOutput = (text: string) => { if (text.includes('Namespace capability:')) stdout.write(text) }
	try { return (await readline.question('Namespace capability: ')).trim() }
	finally { mutable._writeToOutput = original; readline.close(); stdout.write('\n') }
}

async function run(): Promise<void> {
	const readline = createInterface({ input: stdin, output: stdout })
	try {
		const serviceURL = await readline.question('Service URL [https://zettelkasten.henriquebastos.net]: ')
		const namespaceID = await readline.question('Namespace ID: ')
		readline.close()
		const capability = await readCapability()
		await saveConfiguration(process.env, serviceURL || 'https://zettelkasten.henriquebastos.net', namespaceID, capability)
		stdout.write('Pi Zettelkasten configuration saved in the private user-local Pi directory.\n')
	} finally { readline.close() }
}

if (invokedDirectly(import.meta.url)) {
	try { await run() } catch (error) { process.stderr.write(`${error instanceof Error ? error.message : 'Pi configuration failed.'}\n`); process.exitCode = 1 }
}
