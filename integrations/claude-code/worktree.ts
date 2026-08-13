import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { copyFile, lstat, mkdir } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

import {
	HierarchyAllocationError,
	RemoteHierarchyAllocator,
	hierarchyConfiguration,
	type Address,
} from './index.ts'

interface WorktreeCreateInput {
	hook_event_name: 'WorktreeCreate'
	session_id: string
	cwd: string
	name: string
}

interface WorktreeEnvironment {
	ZETTELKASTEN_SERVICE_URL?: string
	ZETTELKASTEN_NAMESPACE_ID?: string
	ZETTELKASTEN_NAMESPACE_CAPABILITY?: string
	CLAUDE_PLUGIN_OPTION_SERVICE_URL?: string
	CLAUDE_PLUGIN_OPTION_NAMESPACE_ID?: string
	CLAUDE_PLUGIN_OPTION_NAMESPACE_CAPABILITY?: string
	ZETTELKASTEN_CLAUDE_PARENT_SESSION_ID?: string
}

interface CommandResult {
	stdout: string
	stderr: string
}

interface WorktreeDependencies {
	request?: typeof fetch
	runGit?: (cwd: string, args: string[]) => Promise<CommandResult>
}

const executeFile = promisify(execFile)

async function runGit(cwd: string, args: string[]): Promise<CommandResult> {
	const result = await executeFile('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 10_000 })
	return { stdout: result.stdout, stderr: result.stderr }
}

function directChildOf(parent: Address, child: Address): boolean {
	return child.length === parent.length + 1 && parent.every((segment, index) => child[index] === segment)
}

function validateNativeName(name: string): void {
	const segments = name.split('/')
	if (
		name.length === 0
		|| name.length > 64
		|| !/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(name)
		|| segments.some((segment) => segment === '.' || segment === '..')
	) {
		throw new HierarchyAllocationError('Claude Code supplied an invalid native worktree description.')
	}
}

export function formatWorktreeLabel(address: Address, nativeName: string): string {
	validateNativeName(nativeName)
	const canonical = address.join('')
	const slug = nativeName.replaceAll('/', '-')
	return slug.startsWith(`${canonical}-`) ? slug : `${canonical}-${slug}`
}

async function allocateWorktreeAddress(
	input: WorktreeCreateInput,
	environment: WorktreeEnvironment,
	request?: typeof fetch,
): Promise<Address> {
	const configuration = hierarchyConfiguration(environment)
	if (!configuration.serviceURL || !configuration.namespaceID || !configuration.capability) {
		throw new HierarchyAllocationError(configuration.useInstalledPlugin
			? 'Zettelkasten plugin configuration is incomplete; worktree creation was deferred.'
			: 'Zettelkasten configuration is incomplete; worktree creation was deferred.')
	}
	const allocator = new RemoteHierarchyAllocator(
		configuration.serviceURL,
		configuration.namespaceID,
		configuration.capability,
		request,
		AbortSignal.timeout(7_000),
	)
	const parentID = environment.ZETTELKASTEN_CLAUDE_PARENT_SESSION_ID ?? null
	if (parentID === null) return await allocator.allocate(input.session_id, null)
	const parent = await allocator.resolveAssignment(parentID)
	const address = await allocator.allocate(input.session_id, parentID)
	if (!directChildOf(parent.address, address)) {
		throw new HierarchyAllocationError('Hierarchy service returned an address outside the launcher parent Claude Code session lineage.')
	}
	return address
}

function nulSeparated(value: string): Set<string> {
	return new Set(value.split('\0').filter(Boolean))
}

async function copyIncludedIgnoredFiles(
	repositoryRoot: string,
	worktreePath: string,
	git: (cwd: string, args: string[]) => Promise<CommandResult>,
): Promise<void> {
	let included: Set<string>
	try {
		included = nulSeparated((await git(repositoryRoot, [
			'ls-files', '--others', '--ignored', '-z', '--exclude-from=.worktreeinclude',
		])).stdout)
	} catch (error) {
		if (error instanceof Error && 'stderr' in error && String(error.stderr).includes('.worktreeinclude')) return
		throw error
	}
	if (included.size === 0) return
	const ignored = nulSeparated((await git(repositoryRoot, [
		'ls-files', '--others', '--ignored', '-z', '--exclude-standard',
	])).stdout)
	for (const relativePath of included) {
		if (!ignored.has(relativePath)) continue
		if (relativePath === '.claude/settings.local.json') continue
		const source = resolve(repositoryRoot, relativePath)
		const destination = resolve(worktreePath, relativePath)
		const value = await lstat(source)
		if (!value.isFile() || value.isSymbolicLink()) continue
		await mkdir(dirname(destination), { recursive: true })
		try { await copyFile(source, destination, constants.COPYFILE_EXCL) }
		catch (error) {
			if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
		}
	}
}

export async function createManagedWorktree(
	input: WorktreeCreateInput,
	environment: WorktreeEnvironment,
	dependencies: WorktreeDependencies = {},
): Promise<string> {
	if (input.hook_event_name !== 'WorktreeCreate' || !input.session_id || !input.cwd) {
		throw new HierarchyAllocationError('Claude Code supplied invalid worktree hook input.')
	}
	validateNativeName(input.name)
	const git = dependencies.runGit ?? runGit
	const address = await allocateWorktreeAddress(input, environment, dependencies.request)
	const bare = (await git(input.cwd, ['rev-parse', '--is-bare-repository'])).stdout.trim()
	if (bare !== 'false') throw new HierarchyAllocationError('Claude Code worktrees require a non-bare Git repository.')
	const worktreeList = (await git(input.cwd, ['worktree', 'list', '--porcelain'])).stdout
	const repositoryRoot = worktreeList.match(/^worktree (.+)$/m)?.[1]
	if (!repositoryRoot || !isAbsolute(repositoryRoot)) {
		throw new HierarchyAllocationError('Claude Code did not expose a supported main Git worktree.')
	}
	const worktreeRoot = resolve(repositoryRoot, '.claude', 'worktrees')
	const worktreePath = resolve(worktreeRoot, formatWorktreeLabel(address, input.name))
	const branch = `worktree-${input.name}`
	await mkdir(worktreeRoot, { recursive: true })
	let created = false
	try {
		let base = 'HEAD'
		try {
			await git(input.cwd, ['fetch', 'origin', 'main'])
			await git(input.cwd, ['rev-parse', '--verify', 'refs/remotes/origin/main'])
			base = 'origin/main'
		} catch {
			// Claude's native fallback when origin/main is absent or unavailable.
		}
		await git(input.cwd, ['worktree', 'add', '-b', branch, worktreePath, base])
		created = true
		await copyIncludedIgnoredFiles(repositoryRoot, worktreePath, git)
		return worktreePath
	} catch (error) {
		if (created) {
			try { await git(repositoryRoot, ['worktree', 'remove', '--force', worktreePath]) } catch {}
			try { await git(repositoryRoot, ['branch', '-D', branch]) } catch {}
		}
		throw error
	}
}

async function run(): Promise<void> {
	const chunks: Buffer[] = []
	for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
	try {
		const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as WorktreeCreateInput
		process.stdout.write(`${await createManagedWorktree(input, process.env)}\n`)
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : 'Zettelkasten worktree creation failed safely.'}\n`)
		process.exitCode = 1
	}
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined
if (invokedPath === fileURLToPath(import.meta.url)) await run()
