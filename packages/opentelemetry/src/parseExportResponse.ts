const invalidResponse = (): never => {
  throw new Error('Invalid OTLP export response')
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const parseRejectedSpans = (value: unknown, keptCount: number): number => {
  if (typeof value === 'string' && /^\d+$/.test(value)) value = Number(value)
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > keptCount
  )
    return invalidResponse()
  return value
}

/** Parses an OTLP/HTTP 2xx body after the transport has already settled. */
export const parseExportResponse = (
  text: string,
  keptCount: number,
): { accepted: number; rejected: number; errorMessage?: string } => {
  if (!Number.isSafeInteger(keptCount) || keptCount < 0) invalidResponse()
  if (text === '') return { accepted: keptCount, rejected: 0 }

  let response: unknown
  try {
    response = JSON.parse(text)
  } catch {
    return invalidResponse()
  }
  if (!isRecord(response)) return invalidResponse()
  if (!Object.prototype.hasOwnProperty.call(response, 'partialSuccess'))
    return { accepted: keptCount, rejected: 0 }

  const partialSuccess = response.partialSuccess
  if (!isRecord(partialSuccess)) return invalidResponse()
  const rejected =
    partialSuccess.rejectedSpans === undefined
      ? 0
      : parseRejectedSpans(partialSuccess.rejectedSpans, keptCount)
  const errorMessage = partialSuccess.errorMessage
  if (errorMessage !== undefined && typeof errorMessage !== 'string')
    return invalidResponse()
  return {
    accepted: keptCount - rejected,
    rejected,
    ...(errorMessage === undefined ? {} : { errorMessage }),
  }
}

/** Bound untrusted collector responses; keep transport ownership through cancel. */
export const readExportResponse = async (
  response: Response,
  keptCount: number,
) => {
  const reader = response.body?.getReader()
  if (!reader) return parseExportResponse('', keptCount)
  const decoder = new TextDecoder()
  let bytes = 0
  let text = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > 64 * 1024) {
        await reader.cancel()
        throw new Error('OTLP export response exceeds 64 KiB')
      }
      text += decoder.decode(value, { stream: true })
    }
    return parseExportResponse(text + decoder.decode(), keptCount)
  } finally {
    reader.releaseLock()
  }
}
