const MAX_INT64 = 9_223_372_036_854_775_807n

const invalidResponse = (): never => {
  throw new Error('Invalid OTLP export response')
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const parseRejectedSpans = (value: unknown, keptCount: number): number => {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0 || value > keptCount)
      return invalidResponse()
    return value
  }
  if (typeof value !== 'string' || !/^\d+$/.test(value))
    return invalidResponse()
  const rejected = BigInt(value)
  if (rejected > MAX_INT64 || rejected > BigInt(keptCount))
    return invalidResponse()
  return Number(rejected)
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
