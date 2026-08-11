import { CodexAppServer } from './index.ts'

interface DeferredNameInput {
	nativeID: string
	name: string
}

async function run(): Promise<void> {
	let raw = ''
	for await (const chunk of process.stdin) raw += chunk
	const input = JSON.parse(raw) as Partial<DeferredNameInput>
	if (!input.nativeID || !input.name) return
	await new Promise((resolveDelay) => setTimeout(resolveDelay, 750))
	const native = new CodexAppServer(true)
	try {
		for (let attempt = 0; attempt < 4; attempt += 1) {
			await native.setName(input.nativeID, input.name)
			if ((await native.read(input.nativeID)).name === input.name) return
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 500))
		}
	} finally { await native.close() }
}

try { await run() } catch { process.exitCode = 1 }
