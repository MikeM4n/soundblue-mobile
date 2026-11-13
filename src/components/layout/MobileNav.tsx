import { useLayoutEffect, useRef } from 'react'
import { NavLink } from 'react-router'
import { sheetState } from '../../player/stage'
import { libraryNav, mainNav } from './navItems'

/**
 * Barra inferior fija del celular con las tres secciones; permanece visible también en «Sonando ahora».
 * Alto: --nav-total (index.css). Con gestos, 70 px como siempre; con navegación por 3 botones crece para que los íconos
 * queden encima de los botones del sistema (pb = env(safe-area-inset-bottom)).
 * Desde aquí, tocar una sección navega sin detener la música.
 */
export function MobileNav() {
  const ref = useRef<HTMLElement>(null)

  // Publica su alto (con la zona segura del teléfono) para que «Sonando ahora» no la tape. En el PC está oculta: 0.
  useLayoutEffect(() => {
    const nav = ref.current
    if (!nav) return
    const update = () => document.documentElement.style.setProperty('--nav-h', `${nav.offsetHeight}px`)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(nav)
    return () => {
      observer.disconnect()
      document.documentElement.style.removeProperty('--nav-h')
    }
  }, [])

  return (
    <nav
      ref={ref}
      aria-label="Principal"
      className="fixed right-0 bottom-0 left-0 z-50 grid h-[var(--nav-total)] shrink-0 grid-cols-3 border-t border-contraste/5 bg-fondo pb-[env(safe-area-inset-bottom)] lg:hidden"
    >
      {[...mainNav, libraryNav].map(({ to, label, icon: Icon, end }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          onClick={(event) => {
            const active = (event.currentTarget as HTMLAnchorElement).getAttribute('aria-current') === 'page'
            if (active && sheetState.get() === 'closed') {
              event.preventDefault()
              document.querySelector('main')?.scrollTo({ top: 0, behavior: 'smooth' })
              window.scrollTo({ top: 0, behavior: 'smooth' })
            }
          }}
          className={({ isActive }) =>
            `flex flex-col items-center gap-1 pt-2 pb-1.5 text-[11px] font-medium ${isActive ? 'text-texto' : 'text-texto-sec'}`
          }
        >
          <Icon className="size-6" aria-hidden="true" />
          {label}
        </NavLink>
      ))}
    </nav>
  )
}
