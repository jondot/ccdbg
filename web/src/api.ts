import type { Bundle } from './types'

export async function fetchBundle(): Promise<Bundle> {
  const res = await fetch('/api/bundle')
  if (!res.ok) throw new Error(`/api/bundle returned ${res.status}`)
  return res.json() as Promise<Bundle>
}
