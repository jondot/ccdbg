import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react'
import { fetchBundle } from './api'
import type { Bundle } from './types'

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; error: Error }
  | { status: 'ready'; bundle: Bundle }

interface BundleCtx {
  load: LoadState
  selectedSessionId: string | null
  setSelectedSessionId: (id: string | null) => void
}

const BundleContext = createContext<BundleCtx | null>(null)

function sessionIdFromHash(): string | null {
  const m = window.location.hash.match(/^#session\/(.+)$/)
  return m ? m[1] : null
}

export function BundleProvider({ children }: { children: ReactNode }) {
  const [load, setLoad] = useState<LoadState>({ status: 'loading' })
  const [selectedSessionId, setSelectedSessionIdState] = useState<string | null>(sessionIdFromHash)

  useEffect(() => {
    fetchBundle()
      .then((bundle) => setLoad({ status: 'ready', bundle }))
      .catch((error: unknown) => {
        const err = error instanceof Error ? error : new Error(String(error))
        setLoad({ status: 'error', error: err })
      })
  }, [])

  useEffect(() => {
    const onPop = () => setSelectedSessionIdState(sessionIdFromHash())
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  const setSelectedSessionId = useCallback((id: string | null) => {
    if (id) {
      window.history.pushState({ sessionId: id }, '', `#session/${id}`)
    } else {
      window.history.pushState({ sessionId: null }, '', '#')
    }
    setSelectedSessionIdState(id)
  }, [])

  return (
    <BundleContext.Provider value={{ load, selectedSessionId, setSelectedSessionId }}>
      {children}
    </BundleContext.Provider>
  )
}

function useCtx() {
  const c = useContext(BundleContext)
  if (!c) throw new Error('must be inside BundleProvider')
  return c
}

export function useBundleState(): LoadState {
  return useCtx().load
}

export function useBundle(): Bundle {
  const c = useCtx()
  if (c.load.status !== 'ready') throw new Error('useBundle called before ready')
  return c.load.bundle
}

export function useSelectedSession() {
  const c = useCtx()
  const load = c.load
  const id = c.selectedSessionId
  const sessions = load.status === 'ready' ? load.bundle.sessions : []
  return {
    session: id ? sessions.find((s) => s.id === id) ?? null : null,
    selectedSessionId: id,
    setSelectedSessionId: c.setSelectedSessionId,
  }
}
