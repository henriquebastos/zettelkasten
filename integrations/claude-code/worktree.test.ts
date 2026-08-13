import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { createManagedWorktree, formatWorktreeLabel } from './worktree.ts'

const environment = {
	ZETTELKASTEN_SERVICE_URL: 'https://service.test',
	ZETTELKASTEN_NAMESPACE_ID: 'shared',
	ZETTELKASTEN_NAMESPACE_CAPABILITY: 'secret',
}

function git(cwd: string, ...args: string[]): string {
	return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
}

async function repository(): Promise<string> {
	const root = await mkdtemp(resolve(tmpdir(), 'zettelkasten-claude-worktree-'))
	git(root, 'init', '-q')
	git(root, 'config', 'user.email', 'probe@example.invalid')
	git(root, 'config', 'user.name', 'Probe')
	await writeFile(resolve(root, 'tracked'), 'committed\n')
	await writeFile(resolve(root, '.gitignore'), 'private/\nignored.txt\nignored-link\n.claude/settings.local.json\n')
	await writeFile(resolve(root, '.worktreeinclude'), 'private/config.txt\nignored.txt\nignored-link\ntracked\n.claude/settings.local.json\n')
	git(root, 'add', '.')
	git(root, 'commit', '-qm', 'initial')
	return root
}

function service(address = '4', parentAddress = '3'): typeof fetch {
	return (async (input, init) => {
		const path = new URL(String(input)).pathname
		const body = JSON.parse(String(init?.body)) as { key: string; parentKey?: string | null }
		if (path.endsWith('/resolve')) {
			return Response.json({ key: body.key, parentKey: null, address: parentAddress })
		}
		return Response.json({ key: body.key, parentKey: body.parentKey ?? null, address }, { status: 201 })
	}) as typeof fetch
}

describe('Claude managed worktree display labels', () => {
	test('combines the allocated address with Claude native description without treating it as identity', () => {
		expect(formatWorktreeLabel([4], 'investigate-hooks')).toBe('4-investigate-hooks')
		expect(formatWorktreeLabel([4, 'a'], '4a-already-addressed')).toBe('4a-already-addressed')
		expect(formatWorktreeLabel([4], 'feature/auth')).toBe('4-feature-auth')
		expect(() => formatWorktreeLabel([4], '../escape')).toThrow('invalid native worktree description')
	})

	test('uses Claude native location and branch behavior while copying only included ignored files', async () => {
		const root = await repository()
		try {
			await mkdir(resolve(root, 'private'))
			await writeFile(resolve(root, 'private', 'config.txt'), 'private config\n')
			await writeFile(resolve(root, 'ignored.txt'), 'included local file\n')
			await symlink('ignored.txt', resolve(root, 'ignored-link'))
			await mkdir(resolve(root, '.claude'))
			await writeFile(resolve(root, '.claude', 'settings.local.json'), '{"private":true}\n')
			await writeFile(resolve(root, 'tracked'), 'dirty source change\n')
			const path = await createManagedWorktree({
				hook_event_name: 'WorktreeCreate', session_id: 'opaque-session', cwd: root, name: 'cleanup-description',
			}, environment, { request: service('4') })
			expect(path).toBe(resolve(root, '.claude', 'worktrees', '4-cleanup-description'))
			expect(git(path, 'branch', '--show-current').trim()).toBe('worktree-cleanup-description')
			expect(await readFile(resolve(path, 'tracked'), 'utf8')).toBe('committed\n')
			expect(await readFile(resolve(path, 'private', 'config.txt'), 'utf8')).toBe('private config\n')
			expect(await readFile(resolve(path, 'ignored.txt'), 'utf8')).toBe('included local file\n')
			expect(await Bun.file(resolve(path, 'ignored-link')).exists()).toBe(false)
			expect(await Bun.file(resolve(path, '.claude', 'settings.local.json')).exists()).toBe(false)
		} finally { await rm(root, { recursive: true, force: true }) }
	})

	test('uses fetched origin/main when available instead of a local-only commit', async () => {
		const parent = await mkdtemp(resolve(tmpdir(), 'zettelkasten-claude-origin-'))
		const origin = resolve(parent, 'origin.git')
		const root = resolve(parent, 'repo')
		try {
			git(parent, 'init', '-q', '--bare', origin)
			git(parent, 'clone', '-q', origin, root)
			git(root, 'config', 'user.email', 'probe@example.invalid')
			git(root, 'config', 'user.name', 'Probe')
			await writeFile(resolve(root, 'tracked'), 'remote\n')
			git(root, 'add', '.')
			git(root, 'commit', '-qm', 'remote')
			git(root, 'branch', '-M', 'main')
			git(root, 'push', '-qu', 'origin', 'main')
			const remoteHead = git(root, 'rev-parse', 'origin/main').trim()
			await writeFile(resolve(root, 'tracked'), 'local only\n')
			git(root, 'commit', '-qam', 'local only')
			const path = await createManagedWorktree({
				hook_event_name: 'WorktreeCreate', session_id: 'opaque', cwd: root, name: 'remote-base',
			}, environment, { request: service('4') })
			expect(git(path, 'rev-parse', 'HEAD').trim()).toBe(remoteHead)
		} finally { await rm(parent, { recursive: true, force: true }) }
	})

	test('creates multiple labels for one opaque session using the same idempotent address', async () => {
		const root = await repository()
		try {
			const first = await createManagedWorktree({
				hook_event_name: 'WorktreeCreate', session_id: 'same-session', cwd: root, name: 'first-task',
			}, environment, { request: service('4') })
			const second = await createManagedWorktree({
				hook_event_name: 'WorktreeCreate', session_id: 'same-session', cwd: first, name: 'second-task',
			}, environment, { request: service('4') })
			expect([first, second]).toEqual([
				resolve(root, '.claude', 'worktrees', '4-first-task'),
				resolve(root, '.claude', 'worktrees', '4-second-task'),
			])
		} finally { await rm(root, { recursive: true, force: true }) }
	})

	test('resolves a launcher parent before allocating and validates direct lineage', async () => {
		const root = await repository()
		const requests: string[] = []
		try {
			const request = (async (input, init) => {
				const path = new URL(String(input)).pathname
				const body = JSON.parse(String(init?.body)) as { key: string; parentKey?: string | null }
				requests.push(`${path.endsWith('/resolve') ? 'resolve' : 'allocate'}:${body.key}`)
				return path.endsWith('/resolve')
					? Response.json({ key: 'claude:parent', parentKey: null, address: '4' })
					: Response.json({ key: 'claude:child', parentKey: 'claude:parent', address: '4a' }, { status: 201 })
			}) as typeof fetch
			const path = await createManagedWorktree({
				hook_event_name: 'WorktreeCreate', session_id: 'child', cwd: root, name: 'child-task',
			}, { ...environment, ZETTELKASTEN_CLAUDE_PARENT_SESSION_ID: 'parent' }, { request })
			expect(requests).toEqual(['resolve:claude:parent', 'allocate:claude:child'])
			expect(path.endsWith('/4a-child-task')).toBe(true)
		} finally { await rm(root, { recursive: true, force: true }) }
	})

	test('fails before filesystem creation when configuration or service allocation fails', async () => {
		const root = await repository()
		try {
			const input = { hook_event_name: 'WorktreeCreate' as const, session_id: 'opaque', cwd: root, name: 'deferred' }
			await expect(createManagedWorktree(input, {})).rejects.toThrow('configuration is incomplete')
			await expect(createManagedWorktree(input, environment, {
				request: (async () => { throw new Error('offline') }) as typeof fetch,
			})).rejects.toThrow('service is unavailable')
			expect(git(root, 'worktree', 'list', '--porcelain').match(/^worktree /gm)?.length).toBe(1)
		} finally { await rm(root, { recursive: true, force: true }) }
	})

	test('does not repurpose an existing branch or worktree on a description collision', async () => {
		const root = await repository()
		try {
			const input = { hook_event_name: 'WorktreeCreate' as const, session_id: 'opaque', cwd: root, name: 'collision' }
			await createManagedWorktree(input, environment, { request: service('4') })
			await expect(createManagedWorktree(input, environment, { request: service('4') })).rejects.toThrow()
			expect(git(root, 'worktree', 'list', '--porcelain').match(/^worktree /gm)?.length).toBe(2)
		} finally { await rm(root, { recursive: true, force: true }) }
	})
})
