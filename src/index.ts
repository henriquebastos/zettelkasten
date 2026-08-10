import { DurableObject } from 'cloudflare:workers'

const LEDGER_NAME = 'global-v1'
const ROOT_PARENT = '<roots>'
const THREAD_ID = /^T-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface Env {
  ALLOCATIONS: DurableObjectNamespace<AllocationLedger>
  ALLOCATOR_TOKEN: string
}

interface ReservationRequest {
  threadID: string
  parentThreadID: string | null
}

interface Reservation {
  threadID: string
  parentThreadID: string | null
  ordinal: number
}

type ReservationResult =
  | { ok: true; created: boolean; reservation: Reservation }
  | { ok: false; existingParentThreadID: string | null }

interface AllocationRow {
  [key: string]: SqlStorageValue
  thread_id: string
  parent_key: string
  ordinal: number
}

interface CounterRow {
  [key: string]: SqlStorageValue
  maximum: number
}

export class AllocationLedger extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS counters (
        parent_key TEXT PRIMARY KEY,
        maximum INTEGER NOT NULL CHECK (maximum > 0)
      );
      CREATE TABLE IF NOT EXISTS allocations (
        thread_id TEXT PRIMARY KEY,
        parent_key TEXT NOT NULL,
        ordinal INTEGER NOT NULL CHECK (ordinal > 0),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (parent_key, ordinal)
      );
    `)
  }

  reserve(request: ReservationRequest): ReservationResult {
    return this.ctx.storage.transactionSync(() => {
      const existing = this.ctx.storage.sql
        .exec<AllocationRow>(
          'SELECT thread_id, parent_key, ordinal FROM allocations WHERE thread_id = ?',
          request.threadID,
        )
        .toArray()[0]

      if (existing) {
        const existingParentThreadID = decodeParent(existing.parent_key)
        if (existingParentThreadID !== request.parentThreadID) {
          return { ok: false, existingParentThreadID }
        }
        return {
          ok: true,
          created: false,
          reservation: toReservation(existing),
        }
      }

      const parentKey = encodeParent(request.parentThreadID)
      const { maximum } = this.ctx.storage.sql
        .exec<CounterRow>(
          `INSERT INTO counters (parent_key, maximum)
           VALUES (?, 1)
           ON CONFLICT (parent_key)
           DO UPDATE SET maximum = maximum + 1
           RETURNING maximum`,
          parentKey,
        )
        .one()

      this.ctx.storage.sql.exec(
        'INSERT INTO allocations (thread_id, parent_key, ordinal) VALUES (?, ?, ?)',
        request.threadID,
        parentKey,
        maximum,
      )

      return {
        ok: true,
        created: true,
        reservation: {
          threadID: request.threadID,
          parentThreadID: request.parentThreadID,
          ordinal: maximum,
        },
      }
    })
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url)

    if (request.method === 'GET' && url.pathname === '/health') {
      return json({ ok: true })
    }

    if (request.method !== 'POST' || url.pathname !== '/v1/allocations') {
      return json({ error: 'Not found' }, 404)
    }

    if (!env.ALLOCATOR_TOKEN) {
      return json({ error: 'Allocator is not configured' }, 503)
    }
    if (request.headers.get('authorization') !== `Bearer ${env.ALLOCATOR_TOKEN}`) {
      return json({ error: 'Unauthorized' }, 401)
    }

    const body = await readReservationRequest(request)
    if (!body.ok) return json({ error: body.error }, 400)

    const ledger = env.ALLOCATIONS.getByName(LEDGER_NAME)
    const result = await ledger.reserve(body.value)
    if (!result.ok) {
      return json(
        {
          error: 'Thread already has a reservation under a different parent',
          existingParentThreadID: result.existingParentThreadID,
        },
        409,
      )
    }

    return json(result.reservation, result.created ? 201 : 200)
  },
} satisfies ExportedHandler<Env>

function encodeParent(parentThreadID: string | null): string {
  return parentThreadID ?? ROOT_PARENT
}

function decodeParent(parentKey: string): string | null {
  return parentKey === ROOT_PARENT ? null : parentKey
}

function toReservation(row: AllocationRow): Reservation {
  return {
    threadID: row.thread_id,
    parentThreadID: decodeParent(row.parent_key),
    ordinal: row.ordinal,
  }
}

async function readReservationRequest(
  request: Request,
): Promise<{ ok: true; value: ReservationRequest } | { ok: false; error: string }> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return { ok: false, error: 'Request body must be valid JSON' }
  }

  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'Request body must be an object' }
  }

  const { threadID, parentThreadID } = body as Record<string, unknown>
  const normalizedThreadID = normalizeThreadID(threadID)
  if (!normalizedThreadID) {
    return { ok: false, error: 'threadID must be an Amp thread ID' }
  }
  if (!Object.hasOwn(body, 'parentThreadID')) {
    return { ok: false, error: 'parentThreadID is required' }
  }
  const normalizedParentThreadID = parentThreadID === null ? null : normalizeThreadID(parentThreadID)
  if (parentThreadID !== null && !normalizedParentThreadID) {
    return { ok: false, error: 'parentThreadID must be an Amp thread ID or null' }
  }
  if (normalizedThreadID === normalizedParentThreadID) {
    return { ok: false, error: 'A thread cannot be its own parent' }
  }

  return {
    ok: true,
    value: {
      threadID: normalizedThreadID,
      parentThreadID: normalizedParentThreadID,
    },
  }
}

function normalizeThreadID(value: unknown): string | null {
  if (typeof value !== 'string' || !THREAD_ID.test(value)) return null
  return `T-${value.slice(2).toLowerCase()}`
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: {
      'cache-control': 'no-store',
    },
  })
}
