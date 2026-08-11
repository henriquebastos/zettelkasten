import { DurableObject } from 'cloudflare:workers'

const MAX_KEY_BYTES = 512
const MAX_DEPTH = 64
const NAMESPACE_ID = /^ns_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

interface Env {
  HIERARCHIES: DurableObjectNamespace<Hierarchy>
  SERVICE_ADMIN_TOKEN: string
  CAPABILITY_SIGNING_KEY: string
}

type NamespaceState = 'initializing' | 'active' | 'disabled'

interface NamespaceMetaRow extends Record<string, SqlStorageValue> {
  namespace_id: string
  name: string
  state: NamespaceState
  token_digest: string
}

interface ElementRow extends Record<string, SqlStorageValue> {
  element_key: string
  parent_key: string | null
  ordinal: number
}

interface MaximumRow extends Record<string, SqlStorageValue> {
  maximum: number | null
}

interface ElementInput {
  key: string
  parentKey: string | null
}

interface ImportedElement extends ElementInput {
  ordinal: number
  address?: string
}

interface ElementRecord extends ElementInput {
  ordinal: number
  ordinalPath: number[]
  address: string
}

interface NamespaceMetadata {
  namespaceID: string
  name: string
  state: NamespaceState
}

type OperationResult<T> =
  | { ok: true; created?: boolean; value: T }
  | { ok: false; status: number; code: string; detail?: unknown }

class OperationAbort extends Error {
  constructor(readonly result: OperationResult<never>) {
    super('Operation aborted')
  }
}

export class Hierarchy extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.ctx.storage.sql.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS namespace_meta (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        namespace_id TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('initializing', 'active', 'disabled')),
        token_digest TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        activated_at TEXT,
        disabled_at TEXT
      );
      CREATE TABLE IF NOT EXISTS elements (
        element_key TEXT PRIMARY KEY,
        parent_key TEXT REFERENCES elements(element_key) ON DELETE RESTRICT,
        ordinal INTEGER NOT NULL CHECK (ordinal > 0),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE UNIQUE INDEX IF NOT EXISTS unique_nonroot_ordinal
        ON elements(parent_key, ordinal) WHERE parent_key IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS unique_root_ordinal
        ON elements(ordinal) WHERE parent_key IS NULL;
      CREATE INDEX IF NOT EXISTS elements_by_parent
        ON elements(parent_key, ordinal);
    `)
  }

  initialize(namespaceID: string, name: string, tokenDigest: string): OperationResult<NamespaceState> {
    return this.ctx.storage.transactionSync(() => {
      const existing = this.meta()
      if (existing) {
        if (existing.namespace_id !== namespaceID) {
          return failure(409, 'namespace_conflict')
        }
        return { ok: true, created: false, value: existing.state }
      }
      this.ctx.storage.sql.exec(
        `INSERT INTO namespace_meta (singleton, namespace_id, name, state, token_digest)
         VALUES (1, ?, ?, 'initializing', ?)`,
        namespaceID,
        name,
        tokenDigest,
      )
      return { ok: true, created: true, value: 'initializing' }
    })
  }

  activate(): OperationResult<NamespaceState> {
    return this.ctx.storage.transactionSync(() => {
      const meta = this.meta()
      if (!meta) return failure(404, 'namespace_not_found')
      if (meta.state === 'disabled') return failure(409, 'namespace_disabled')
      this.ctx.storage.sql.exec(
        `UPDATE namespace_meta
         SET state = 'active', activated_at = COALESCE(activated_at, CURRENT_TIMESTAMP)
         WHERE singleton = 1`,
      )
      return { ok: true, value: 'active' }
    })
  }

  disable(): OperationResult<NamespaceState> {
    return this.ctx.storage.transactionSync(() => {
      if (!this.meta()) return failure(404, 'namespace_not_found')
      this.ctx.storage.sql.exec(
        `UPDATE namespace_meta
         SET state = 'disabled', disabled_at = COALESCE(disabled_at, CURRENT_TIMESTAMP)
         WHERE singleton = 1`,
      )
      return { ok: true, value: 'disabled' }
    })
  }

  rotateToken(tokenDigest: string): OperationResult<NamespaceState> {
    return this.ctx.storage.transactionSync(() => {
      const meta = this.meta()
      if (!meta) return failure(404, 'namespace_not_found')
      if (meta.state === 'disabled') return failure(409, 'namespace_disabled')
      this.ctx.storage.sql.exec(
        'UPDATE namespace_meta SET token_digest = ? WHERE singleton = 1',
        tokenDigest,
      )
      return { ok: true, value: meta.state }
    })
  }

  rename(name: string): OperationResult<NamespaceMetadata> {
    return this.ctx.storage.transactionSync(() => {
      const meta = this.meta()
      if (!meta) return failure(404, 'namespace_not_found')
      this.ctx.storage.sql.exec('UPDATE namespace_meta SET name = ? WHERE singleton = 1', name)
      return {
        ok: true,
        value: {
          namespaceID: meta.namespace_id,
          name,
          state: meta.state,
        },
      }
    })
  }

  adminMetadata(): OperationResult<NamespaceMetadata> {
    const meta = this.meta()
    if (!meta) return failure(404, 'namespace_not_found')
    return {
      ok: true,
      value: {
        namespaceID: meta.namespace_id,
        name: meta.name,
        state: meta.state,
      },
    }
  }

  importElements(elements: ImportedElement[]): OperationResult<{ imported: number }> {
    try {
      return this.ctx.storage.transactionSync(() => {
        const meta = this.meta()
        if (!meta) abort(404, 'namespace_not_found')
        if (meta.state !== 'initializing') abort(409, 'namespace_not_initializing')

        let imported = 0
        for (const element of elements) {
          const existing = this.element(element.key)
          let record: ElementRecord
          if (existing) {
            if (existing.parent_key !== element.parentKey || existing.ordinal !== element.ordinal) {
              abort(409, 'element_conflict', { key: element.key })
            }
            record = this.elementRecord(element.key)
          } else {
            if (element.parentKey !== null && !this.element(element.parentKey)) {
              abort(404, 'parent_not_found', { key: element.key, parentKey: element.parentKey })
            }
            const parentPath = element.parentKey === null ? [] : this.pathFor(element.parentKey)
            if (parentPath.length >= MAX_DEPTH) {
              abort(409, 'maximum_depth_exceeded', { key: element.key })
            }
            if (this.ordinalOwner(element.parentKey, element.ordinal)) {
              abort(409, 'ordinal_conflict', {
                parentKey: element.parentKey,
                ordinal: element.ordinal,
              })
            }
            this.ctx.storage.sql.exec(
              'INSERT INTO elements (element_key, parent_key, ordinal) VALUES (?, ?, ?)',
              element.key,
              element.parentKey,
              element.ordinal,
            )
            imported += 1
            record = makeRecord(element, element.ordinal, [...parentPath, element.ordinal])
          }

          if (element.address !== undefined && record.address !== element.address) {
            abort(409, 'address_mismatch', {
              key: element.key,
              expected: element.address,
              actual: record.address,
            })
          }
        }
        return { ok: true, value: { imported } }
      })
    } catch (error) {
      if (error instanceof OperationAbort) return error.result
      throw error
    }
  }

  createElement(input: ElementInput, tokenDigest: string): OperationResult<ElementRecord> {
    return this.ctx.storage.transactionSync(() => {
      const authorization = this.authorize(tokenDigest)
      if (!authorization.ok) return authorization

      const existing = this.element(input.key)
      if (existing) {
        if (existing.parent_key !== input.parentKey) {
          return failure(409, 'parent_conflict', { existingParentKey: existing.parent_key })
        }
        return { ok: true, created: false, value: this.elementRecord(input.key) }
      }
      if (input.parentKey !== null && !this.element(input.parentKey)) {
        return failure(404, 'parent_not_found')
      }

      const parentPath = input.parentKey === null ? [] : this.pathFor(input.parentKey)
      if (parentPath.length >= MAX_DEPTH) return failure(409, 'maximum_depth_exceeded')

      const ordinal = this.nextOrdinal(input.parentKey)
      if (!Number.isSafeInteger(ordinal)) return failure(409, 'ordinal_exhausted')
      this.ctx.storage.sql.exec(
        'INSERT INTO elements (element_key, parent_key, ordinal) VALUES (?, ?, ?)',
        input.key,
        input.parentKey,
        ordinal,
      )
      return { ok: true, created: true, value: makeRecord(input, ordinal, [...parentPath, ordinal]) }
    })
  }

  resolveElement(key: string, tokenDigest: string): OperationResult<ElementRecord> {
    const authorization = this.authorize(tokenDigest)
    if (!authorization.ok) return authorization
    if (!this.element(key)) return failure(404, 'element_not_found')
    return { ok: true, value: this.elementRecord(key) }
  }

  private authorize(tokenDigest: string): OperationResult<never> | { ok: true } {
    const meta = this.meta()
    if (!meta || meta.token_digest !== tokenDigest) return failure(401, 'unauthorized')
    if (meta.state !== 'active') return failure(409, `namespace_${meta.state}`)
    return { ok: true }
  }

  private meta(): NamespaceMetaRow | undefined {
    return this.ctx.storage.sql
      .exec<NamespaceMetaRow>(
        'SELECT namespace_id, name, state, token_digest FROM namespace_meta WHERE singleton = 1',
      )
      .toArray()[0]
  }

  private element(key: string): ElementRow | undefined {
    return this.ctx.storage.sql
      .exec<ElementRow>(
        'SELECT element_key, parent_key, ordinal FROM elements WHERE element_key = ?',
        key,
      )
      .toArray()[0]
  }

  private ordinalOwner(parentKey: string | null, ordinal: number): ElementRow | undefined {
    const query = parentKey === null
      ? 'SELECT element_key, parent_key, ordinal FROM elements WHERE parent_key IS NULL AND ordinal = ?'
      : 'SELECT element_key, parent_key, ordinal FROM elements WHERE parent_key = ? AND ordinal = ?'
    const bindings = parentKey === null ? [ordinal] : [parentKey, ordinal]
    return this.ctx.storage.sql.exec<ElementRow>(query, ...bindings).toArray()[0]
  }

  private nextOrdinal(parentKey: string | null): number {
    const result = parentKey === null
      ? this.ctx.storage.sql
          .exec<MaximumRow>('SELECT MAX(ordinal) AS maximum FROM elements WHERE parent_key IS NULL')
          .one()
      : this.ctx.storage.sql
          .exec<MaximumRow>('SELECT MAX(ordinal) AS maximum FROM elements WHERE parent_key = ?', parentKey)
          .one()
    return (result.maximum ?? 0) + 1
  }

  private pathFor(key: string): number[] {
    const path: number[] = []
    let current: string | null = key
    while (current !== null) {
      const row = this.element(current)
      if (!row) throw new Error(`Broken hierarchy at ${current}`)
      path.unshift(row.ordinal)
      current = row.parent_key
      if (path.length > MAX_DEPTH) throw new Error('Hierarchy exceeds maximum depth')
    }
    return path
  }

  private elementRecord(key: string): ElementRecord {
    const row = this.element(key)
    if (!row) throw new Error(`Element not found: ${key}`)
    return makeRecord(
      { key: row.element_key, parentKey: row.parent_key },
      row.ordinal,
      this.pathFor(key),
    )
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    try {
      return await route(request, env)
    } catch (error) {
      console.error(error)
      return json({ code: 'internal_error' }, 500)
    }
  },
} satisfies ExportedHandler<Env>

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  if (request.method === 'GET' && url.pathname === '/health') return json({ ok: true })
  if (request.method !== 'POST') return json({ code: 'not_found' }, 404)

  if (url.pathname === '/v1/admin/namespaces') {
    if (!isAdmin(request, env)) return json({ code: 'unauthorized' }, 401)
    const body = await readObject(request)
    if (!body.ok) return resultResponse(body)
    const name = validNamespaceName(body.value.name)
    if (!name) return json({ code: 'invalid_namespace_name' }, 400)

    const namespaceID = `ns_${crypto.randomUUID()}`
    const capabilityToken = await createCapability(namespaceID, env)
    const tokenDigest = await digest(capabilityToken)
    const result = await hierarchy(env, namespaceID).initialize(namespaceID, name, tokenDigest)
    if (!result.ok) return resultResponse(result)
    return json({ namespaceID, name, state: result.value, capabilityToken }, 201)
  }

  const recoveryMatch = url.pathname.match(
    /^\/v1\/admin\/recovery\/objects\/([0-9a-f]{64})\/token:rotate$/,
  )
  if (recoveryMatch) {
    if (!isAdmin(request, env)) return json({ code: 'unauthorized' }, 401)
    const target = env.HIERARCHIES.get(env.HIERARCHIES.idFromString(recoveryMatch[1]))
    const metadata = await target.adminMetadata()
    if (!metadata.ok) return resultResponse(metadata)

    const capabilityToken = await createCapability(metadata.value.namespaceID, env)
    const rotated = await target.rotateToken(await digest(capabilityToken))
    if (!rotated.ok) return resultResponse(rotated)
    return json({ ...metadata.value, state: rotated.value, capabilityToken })
  }

  const adminMatch = url.pathname.match(
    /^\/v1\/admin\/namespaces\/(ns_[0-9a-f-]+)\/(imports|activate|disable|rename|token:rotate)$/,
  )
  if (adminMatch) {
    if (!isAdmin(request, env)) return json({ code: 'unauthorized' }, 401)
    const namespaceID = adminMatch[1]
    if (!NAMESPACE_ID.test(namespaceID)) return json({ code: 'not_found' }, 404)
    const target = hierarchy(env, namespaceID)
    const action = adminMatch[2]

    if (action === 'activate') return resultResponse(await target.activate())
    if (action === 'disable') return resultResponse(await target.disable())
    if (action === 'token:rotate') {
      const capabilityToken = await createCapability(namespaceID, env)
      const result = await target.rotateToken(await digest(capabilityToken))
      if (!result.ok) return resultResponse(result)
      return json({ namespaceID, state: result.value, capabilityToken })
    }

    const body = await readObject(request)
    if (!body.ok) return resultResponse(body)
    if (action === 'rename') {
      const name = validNamespaceName(body.value.name)
      if (!name) return json({ code: 'invalid_namespace_name' }, 400)
      return resultResponse(await target.rename(name))
    }
    const elements = validateImport(body.value.elements)
    if (!elements) return json({ code: 'invalid_import' }, 400)
    return resultResponse(await target.importElements(elements))
  }

  const dataMatch = url.pathname.match(
    /^\/v1\/namespaces\/(ns_[0-9a-f-]+)\/elements(?:\/(resolve))?$/,
  )
  if (!dataMatch || !NAMESPACE_ID.test(dataMatch[1])) return json({ code: 'not_found' }, 404)

  const namespaceID = dataMatch[1]
  const token = bearerToken(request)
  if (!token || !(await verifyCapability(token, namespaceID, env))) {
    return json({ code: 'unauthorized' }, 401)
  }
  const tokenDigest = await digest(token)
  const body = await readObject(request)
  if (!body.ok) return resultResponse(body)
  const target = hierarchy(env, namespaceID)

  if (dataMatch[2] === 'resolve') {
    const key = validElementKey(body.value.key)
    if (!key) return json({ code: 'invalid_element_key' }, 400)
    return resultResponse(await target.resolveElement(key, tokenDigest))
  }

  const input = validateElement(body.value)
  if (!input) return json({ code: 'invalid_element' }, 400)
  const result = await target.createElement(input, tokenDigest)
  return resultResponse(result, result.ok && result.created ? 201 : 200)
}

function hierarchy(env: Env, namespaceID: string): DurableObjectStub<Hierarchy> {
  return env.HIERARCHIES.getByName(`namespace-v1:${namespaceID}`)
}

function isAdmin(request: Request, env: Env): boolean {
  return Boolean(env.SERVICE_ADMIN_TOKEN) && bearerToken(request) === env.SERVICE_ADMIN_TOKEN
}

function bearerToken(request: Request): string | null {
  const value = request.headers.get('authorization')
  return value?.startsWith('Bearer ') ? value.slice(7) : null
}

async function readObject(request: Request): Promise<OperationResult<Record<string, unknown>>> {
  try {
    const value: unknown = await request.json()
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return failure(400, 'invalid_json_object')
    }
    return { ok: true, value: value as Record<string, unknown> }
  } catch {
    return failure(400, 'invalid_json')
  }
}

function validNamespaceName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const name = value.trim()
  return name.length > 0 && name.length <= 100 ? name : null
}

function validElementKey(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || hasUnpairedSurrogate(value)) return null
  return new TextEncoder().encode(value).length <= MAX_KEY_BYTES ? value : null
}

function validateElement(body: Record<string, unknown>): ElementInput | null {
  const key = validElementKey(body.key)
  if (!key || !Object.hasOwn(body, 'parentKey')) return null
  const parentKey = body.parentKey === null ? null : validElementKey(body.parentKey)
  if (body.parentKey !== null && !parentKey) return null
  if (key === parentKey) return null
  return { key, parentKey }
}

function validateImport(value: unknown): ImportedElement[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 1000) return null
  const result: ImportedElement[] = []
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null
    const body = candidate as Record<string, unknown>
    const element = validateElement(body)
    if (!element || !Number.isSafeInteger(body.ordinal) || (body.ordinal as number) <= 0) return null
    if (body.address !== undefined && typeof body.address !== 'string') return null
    result.push({ ...element, ordinal: body.ordinal as number, address: body.address as string | undefined })
  }
  return result
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (next < 0xdc00 || next > 0xdfff) return true
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true
    }
  }
  return false
}

function makeRecord(input: ElementInput, ordinal: number, ordinalPath: number[]): ElementRecord {
  return { ...input, ordinal, ordinalPath, address: renderAddress(ordinalPath) }
}

function renderAddress(path: number[]): string {
  return path
    .map((ordinal, depth) => (depth % 2 === 0 ? String(ordinal) : letters(ordinal)))
    .join('')
}

function letters(ordinal: number): string {
  let value = ordinal
  let result = ''
  while (value > 0) {
    value -= 1
    result = String.fromCharCode(97 + (value % 26)) + result
    value = Math.floor(value / 26)
  }
  return result
}

async function createCapability(namespaceID: string, env: Env): Promise<string> {
  const namespace = base64url(new TextEncoder().encode(namespaceID))
  const nonce = new Uint8Array(32)
  crypto.getRandomValues(nonce)
  const unsigned = `zk1.${namespace}.${base64url(nonce)}`
  const signature = await sign(unsigned, env.CAPABILITY_SIGNING_KEY)
  return `${unsigned}.${base64url(signature)}`
}

async function verifyCapability(token: string, namespaceID: string, env: Env): Promise<boolean> {
  const parts = token.split('.')
  if (parts.length !== 4 || parts[0] !== 'zk1' || !env.CAPABILITY_SIGNING_KEY) return false
  try {
    const embeddedNamespace = new TextDecoder().decode(fromBase64url(parts[1]))
    if (embeddedNamespace !== namespaceID) return false
    const key = await hmacKey(env.CAPABILITY_SIGNING_KEY, ['verify'])
    return crypto.subtle.verify(
      'HMAC',
      key,
      fromBase64url(parts[3]),
      new TextEncoder().encode(parts.slice(0, 3).join('.')),
    )
  } catch {
    return false
  }
}

async function sign(value: string, secret: string): Promise<Uint8Array> {
  if (!secret) throw new Error('CAPABILITY_SIGNING_KEY is not configured')
  const key = await hmacKey(secret, ['sign'])
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value)))
}

function hmacKey(secret: string, usages: Array<'sign' | 'verify'>): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    usages,
  )
}

async function digest(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function base64url(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function fromBase64url(value: string): Uint8Array {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(value.length / 4) * 4, '=')
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0))
}

function failure(status: number, code: string, detail?: unknown): OperationResult<never> {
  return { ok: false, status, code, detail }
}

function abort(status: number, code: string, detail?: unknown): never {
  throw new OperationAbort(failure(status, code, detail))
}

function resultResponse<T>(result: OperationResult<T>, successStatus = 200): Response {
  if (!result.ok) return json({ code: result.code, detail: result.detail }, result.status)
  return json(result.value, successStatus)
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } })
}
