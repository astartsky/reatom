const MAX_UNLOAD_BYTES = 60 * 1024

// Shared by adapters from this package copy for the lifetime of the document.
// Accepted beacons have no observable settlement, so their credit stays held.
const documents = new WeakMap<
  Document,
  { fetchBytes: number; beaconBytes: number }
>()

const stateFor = (document: Document) => {
  let state = documents.get(document)
  if (!state) {
    state = { fetchBytes: 0, beaconBytes: 0 }
    documents.set(document, state)
  }
  return state
}

export const availableUnloadBytes = (document: Document): number => {
  const state = stateFor(document)
  return MAX_UNLOAD_BYTES - state.fetchBytes - state.beaconBytes
}

export const reserveUnloadBytes = (document: Document, bytes: number) => {
  if (
    !Number.isSafeInteger(bytes) ||
    bytes < 0 ||
    bytes > availableUnloadBytes(document)
  )
    throw new RangeError('Unavailable unload byte budget')
  const state = stateFor(document)
  state.fetchBytes += bytes
  let active = true
  return {
    release() {
      if (!active) return
      active = false
      state.fetchBytes -= bytes
    },
    acceptBeacon() {
      if (!active) return
      active = false
      state.fetchBytes -= bytes
      state.beaconBytes += bytes
    },
  }
}
