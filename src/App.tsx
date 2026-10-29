import { lazy, Suspense, useEffect, useSyncExternalStore } from 'react'
import { Route, Routes, useLocation, type Location } from 'react-router'
import { genreIndex } from './data/genreIndex'
import { onboarding } from './lib/onboarding'
import { startUpdateChecks } from './lib/updates'
import { AppLayout } from './components/layout/AppLayout'
import { NowPlayingSheet } from './components/player/NowPlayingSheet'
import { startNativeWidget } from './player/nativeWidget'
import { usePlayerShortcuts } from './player/usePlayerShortcuts'
import { Home } from './pages/Home'

const Collection = lazy(() => import('./pages/Collection').then((m) => ({ default: m.Collection })))
const Help = lazy(() => import('./pages/Help').then((m) => ({ default: m.Help })))
const ModePage = lazy(() => import('./pages/Mode').then((m) => ({ default: m.ModePage })))
const Settings = lazy(() => import('./pages/Settings').then((m) => ({ default: m.Settings })))
const Library = lazy(() => import('./pages/Library').then((m) => ({ default: m.Library })))
const Onboarding = lazy(() => import('./pages/Onboarding').then((m) => ({ default: m.Onboarding })))
const Queue = lazy(() => import('./pages/Queue').then((m) => ({ default: m.Queue })))
const Search = lazy(() => import('./pages/Search').then((m) => ({ default: m.Search })))
const SongPage = lazy(() => import('./pages/Song').then((m) => ({ default: m.SongPage })))
const Tastes = lazy(() => import('./pages/Tastes').then((m) => ({ default: m.Tastes })))
const YtmPage = lazy(() => import('./pages/YtmPage').then((m) => ({ default: m.YtmPage })))

export default function App() {
  const location = useLocation()
  const onboarded = useSyncExternalStore(onboarding.subscribe, onboarding.seen)
  usePlayerShortcuts()
  useEffect(() => {
    if (import.meta.env.PROD) startUpdateChecks() // si hay una versión más nueva publicada, se actualiza
    startNativeWidget() // el widget de Android: su corazón y ▶ sobre la última canción
    // El índice de géneros de la radio (se guarda 7 días): se arma en segundo plano, después de cargar Inicio.
    const timer = window.setTimeout(() => void genreIndex(), 4000)
    return () => window.clearTimeout(timer)
  }, [])
  // La primera vez (o si la pides en Ajustes), la bienvenida va antes que Inicio y que todo lo demás.
  if (!onboarded) {
    return (
      <Suspense fallback={null}>
        <Onboarding />
      </Suspense>
    )
  }
  // «Sonando ahora» (/reproduciendo) se abre ENCIMA de la página donde estabas: esa sigue dibujada debajo.
  const background = (location.state as { background?: Location } | null)?.background
  const pageLocation = location.pathname === '/reproduciendo' ? (background ?? { ...location, pathname: '/' }) : location

  return (
    <>
      <Suspense fallback={<div className="p-6 text-sm text-texto-sec">Cargando…</div>}><Routes location={pageLocation}>
        <Route element={<AppLayout />}>
          <Route index element={<Home />} />
          <Route path="buscar" element={<Search />} />
          <Route path="biblioteca" element={<Library />} />
          <Route path="coleccion/:tipo/:id" element={<Collection />} />
          <Route path="cola" element={<Queue />} />
          <Route path="ayuda" element={<Help />} />
          <Route path="ajustes" element={<Settings />} />
          <Route path="modo/:modo" element={<ModePage />} />
          <Route path="ytm/:browseId" element={<YtmPage />} />
          <Route path="gustos" element={<Tastes />} />
          <Route path="cancion/:id" element={<SongPage />} />
          <Route path="*" element={<Home />} />
        </Route>
      </Routes></Suspense>
      {location.pathname === '/reproduciendo' && <NowPlayingSheet />}
    </>
  )
}
