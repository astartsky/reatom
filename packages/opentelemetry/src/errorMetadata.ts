const domPrototype =
  typeof DOMException === 'undefined' ? undefined : DOMException.prototype
const domName =
  domPrototype && Object.getOwnPropertyDescriptor(domPrototype, 'name')?.get
const domMessage =
  domPrototype && Object.getOwnPropertyDescriptor(domPrototype, 'message')?.get

/**
 * Read data properties and branded DOMException intrinsics, never user
 * accessors.
 */
export const errorData = (error: unknown, key: string): unknown => {
  if (
    (typeof error !== 'object' && typeof error !== 'function') ||
    error === null
  )
    return undefined
  let current: object | null = error
  for (let depth = 0; current !== null && depth < 8; depth++) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key)
    if (descriptor) {
      if ('value' in descriptor) return descriptor.value
      if (
        descriptor.get &&
        (descriptor.get === domName || descriptor.get === domMessage)
      )
        return descriptor.get.call(error)
      return undefined
    }
    current = Object.getPrototypeOf(current)
  }
  return undefined
}

const errorTypes = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'URIError',
  'EvalError',
  'AggregateError',
  'AbortError',
])

/** Only fixed built-in names are safe metadata; custom names may contain data. */
export const exceptionType = (error: unknown): string => {
  if (
    !(error instanceof Error) &&
    !(typeof DOMException !== 'undefined' && error instanceof DOMException)
  )
    return 'Error'
  const name = errorData(error, 'name')
  return typeof name === 'string' && errorTypes.has(name) ? name : 'Error'
}
