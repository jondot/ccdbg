import { useState } from 'react'
import { BundleProvider, useBundleState } from './BundleContext'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { SessionsView } from './views/SessionsView'
import { IssuesView } from './views/IssuesView'
import { ProfileView } from './views/ProfileView'
import { CompareView } from './views/CompareView'

type ViewId = 'sessions' | 'issues' | 'profile' | 'compare'

function Shell() {
  const load = useBundleState()
  const [view, setView] = useState<ViewId>('sessions')

  if (load.status === 'loading') {
    return <div className="p-8 text-muted-foreground">Loading session data…</div>
  }
  if (load.status === 'error') {
    return (
      <div className="p-8">
        <p className="text-destructive font-medium">Failed to load: {load.error.message}</p>
        <p className="text-muted-foreground text-sm mt-1">
          Make sure you launched via <code>ccwhy web</code>.
        </p>
      </div>
    )
  }

  const bundle = load.bundle

  return (
    <div className="min-h-screen bg-background text-foreground font-sans">
      <header className="border-b">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-baseline justify-between">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">ccwhy</h1>
            <p className="text-xs text-muted-foreground font-mono">
              {bundle.sessions.length} sessions · $
              {bundle.sessions.reduce((a, s) => a + s.estimated_cost_usd, 0).toFixed(2)} total
            </p>
          </div>
          <span className="text-xs text-muted-foreground font-mono">
            generated {new Date(bundle.generated_at).toLocaleString()}
          </span>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-6">
        <Tabs value={view} onValueChange={(v) => setView(v as ViewId)}>
          <TabsList className="mb-6">
            <TabsTrigger value="sessions">Sessions</TabsTrigger>
            <TabsTrigger value="issues">Issues</TabsTrigger>
            <TabsTrigger value="profile">Profile</TabsTrigger>
            <TabsTrigger value="compare">Compare</TabsTrigger>
          </TabsList>
          <TabsContent value="sessions">
            <SessionsView />
          </TabsContent>
          <TabsContent value="issues">
            <IssuesView onOpenDetail={() => setView('sessions')} />
          </TabsContent>
          <TabsContent value="profile"><ProfileView /></TabsContent>
          <TabsContent value="compare"><CompareView /></TabsContent>
        </Tabs>
      </main>
    </div>
  )
}

export default function App() {
  return (
    <BundleProvider>
      <Shell />
    </BundleProvider>
  )
}
