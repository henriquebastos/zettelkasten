import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { chmod, lstat, mkdir, rename, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'

import { HierarchyError, configurationDirectory, invokedDirectly } from './index.ts'

export async function saveConfiguration(
	environment: NodeJS.ProcessEnv,
	serviceURL: string,
	namespaceID: string,
	capability: string,
): Promise<void> {
	const directory = configurationDirectory(environment)
	if (!directory) throw new HierarchyError('CODEX_HOME or HOME must be an absolute path.')
	const values = [serviceURL.trim(), namespaceID.trim(), capability.trim()]
	if (values.some((value) => !value)) throw new HierarchyError('Service URL, namespace ID, and namespace capability are required.')
	let parsed: URL
	try { parsed = new URL(values[0]!) } catch { throw new HierarchyError('Service URL must be an absolute HTTPS URL.') }
	if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
		throw new HierarchyError('Service URL must be an HTTPS URL without credentials, query, or fragment.')
	}
	await mkdir(directory, { recursive: true, mode: 0o700 })
	const directoryStat = await lstat(directory)
	if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory() || (process.getuid !== undefined && directoryStat.uid !== process.getuid())) {
		throw new HierarchyError('Codex Zettelkasten configuration path must be a user-owned directory, not a symlink.')
	}
	await chmod(directory, 0o700)
	const suffix = `${process.pid}.${randomUUID()}.tmp`
	const config = resolve(directory, 'config.json')
	const credential = resolve(directory, 'capability')
	await writeFile(`${config}.${suffix}`, `${JSON.stringify({ serviceURL: values[0], namespaceID: values[1] }, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
	await writeFile(`${credential}.${suffix}`, `${values[2]}\n`, { mode: 0o600, flag: 'wx' })
	await rename(`${config}.${suffix}`, config)
	await rename(`${credential}.${suffix}`, credential)
	await chmod(config, 0o600)
	await chmod(credential, 0o600)
}

async function readCapability(): Promise<string> {
	if (!stdin.isTTY) {
		let value = ''
		for await (const chunk of stdin) value += chunk
		return value.trim()
	}
	const readline = createInterface({ input: stdin, output: stdout })
	const hidden = spawnSync('stty', ['-echo'], { stdio: ['inherit', 'ignore', 'ignore'] }).status === 0
	if (!hidden) {
		readline.close()
		throw new HierarchyError('This terminal cannot hide capability input. Pipe it on stdin from a trusted terminal instead.')
	}
	try { return (await readline.question('Namespace capability: ')).trim() }
	finally {
		spawnSync('stty', ['echo'], { stdio: ['inherit', 'ignore', 'ignore'] })
		stdout.write('\n')
		readline.close()
	}
}

async function run(): Promise<void> {
	const readline = createInterface({ input: stdin, output: stdout })
	try {
		const serviceURL = (await readline.question('Service URL [https://zettelkasten.henriquebastos.net]: ')).trim()
		const namespaceID = (await readline.question('Existing shared namespace ID: ')).trim()
		readline.close()
		const capability = await readCapability()
		await saveConfiguration(process.env, serviceURL || 'https://zettelkasten.henriquebastos.net', namespaceID, capability)
		stdout.write('Codex Zettelkasten configuration saved in the private user-local Codex directory.\n')
	} finally { readline.close() }
}

if (invokedDirectly(import.meta.url)) {
	try { await run() } catch (error) { process.stderr.write(`${error instanceof Error ? error.message : 'Configuration failed safely.'}\n`); process.exitCode = 1 }
}
