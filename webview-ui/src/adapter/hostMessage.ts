function parseStringPayload(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return null
  }
}

function unwrapNestedPayload(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw
  const candidate = raw as { type?: unknown; detail?: unknown; data?: unknown }
  if (typeof candidate.type === 'string') {
    // This is already a typed host message payload; do not unwrap `data` field.
    return raw
  }
  if (candidate.data && typeof candidate.data === 'object') {
    const nestedData = candidate.data as { detail?: unknown }
    if (nestedData.detail !== undefined) return nestedData.detail
  }
  if (candidate.detail !== undefined) return candidate.detail
  if (candidate.data !== undefined) return candidate.data
  return raw
}

export function parseHostMessage(raw: unknown): unknown {
  let candidate: unknown = raw
  for (let depth = 0; depth < 3; depth += 1) {
    if (typeof candidate === 'string') {
      candidate = parseStringPayload(candidate)
      continue
    }
    const unwrapped = unwrapNestedPayload(candidate)
    if (unwrapped === candidate) break
    candidate = unwrapped
  }
  return candidate
}

export function asTypedHostMessage<T extends { type?: unknown }>(raw: unknown): T | null {
  const parsed = parseHostMessage(raw)
  if (!parsed || typeof parsed !== 'object') return null
  const maybe = parsed as T
  if (typeof maybe.type !== 'string') return null
  return maybe
}
