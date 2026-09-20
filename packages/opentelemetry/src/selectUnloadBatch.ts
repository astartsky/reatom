const PREFIX = '{"resourceSpans":['
const SUFFIX = ']}'
const ENVELOPE_BYTES = PREFIX.length + SUFFIX.length
const utf8 = new TextEncoder()

/**
 * Selects owned records newest first. `encode` returns one complete
 * ResourceSpans JSON object per record; failures propagate to the lease owner.
 */
export const selectUnloadBatch = <T>({
  items,
  maxBytes,
  encode,
}: {
  items: readonly T[]
  maxBytes: number
  encode: (item: T) => string
}): { body: string; keptCount: number; droppedCount: number } => {
  if (!Number.isFinite(maxBytes) || maxBytes <= ENVELOPE_BYTES) {
    return { body: '', keptCount: 0, droppedCount: items.length }
  }

  const parts: string[] = []
  let usedBytes = ENVELOPE_BYTES
  for (let index = items.length - 1; index >= 0; index--) {
    const part = encode(items[index]!)
    const partBytes = utf8.encode(part).byteLength
    // Oversized records do not prevent selection of older eligible records.
    if (ENVELOPE_BYTES + partBytes > maxBytes) continue

    const addedBytes = partBytes + (parts.length > 0 ? 1 : 0)
    if (usedBytes + addedBytes > maxBytes) break
    parts.push(part)
    usedBytes += addedBytes
  }

  return {
    body: parts.length > 0 ? PREFIX + parts.reverse().join(',') + SUFFIX : '',
    keptCount: parts.length,
    droppedCount: items.length - parts.length,
  }
}
