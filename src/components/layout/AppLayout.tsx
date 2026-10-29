import { useEffect, useRef } from 'react'
import { Outlet, useLocation } from 'react-router'
import { Banner } from '../player/Banner'
import { Toaster } from '../ui/Toaster'
import { MobileNav } from './MobileNav'
import { PlayerBar } from './PlayerBar'
import { Sidebar } from './Sidebar'
import { useScreenWakeLock } from '../../lib/useScreenWakeLock'
import { InstallBanner } from './InstallBanner'

/**
 * Armazón de la app. Celular: contenido + barra banner (al minimizar) + menú inferior.
 * PC (lg): barra lateral + contenido; la cola lateral solo vive en «Sonando ahora».
 * «Sonando ahora» en pantalla completa lo dibuja App encima de esto (ruta /reproduciendo).
 */
export function AppLayout() {
  useScreenWakeLock()
  const mainRef = useRef<HTMLElement>(null)
  const { pathname } = useLocation() // la página de fondo (no cambia al abrir «Sonando ahora»)

  // Al cambiar de sección, el contenido vuelve arriba.
  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 })
  }, [pathname])

  return (
    <div className="flex h-dvh flex-col bg-fondo pt-[env(safe-area-inset-top)] lg:gap-2 lg:p-2">
      <div className="flex min-h-0 flex-1 lg:gap-2">
        <Sidebar />
        {/* min-w-0: sin esto los carruseles ensanchan la página en el celular */}
        <main ref={mainRef} className="scroll-fino min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain bg-panel pb-[calc(var(--nav-h,70px)_+_var(--mobile-player-banner-h,0px))] lg:rounded-lg lg:pb-0">
          <Outlet />
        </main>
      </div>
      <PlayerBar />
      <Banner />
      <MobileNav />
      <Toaster />
      <InstallBanner />
    </div>
  )
}
