import { House, Library, Search, Settings as SettingsIcon } from 'lucide-react'
import { Link, NavLink } from 'react-router'
import { Logo } from '../brand/Logo'

const linkClass = ({ isActive }: { isActive: boolean }) =>
  `flex h-11 items-center gap-3 rounded-md px-3 text-sm font-semibold transition-colors ${isActive ? 'bg-contraste/10 text-texto' : 'text-texto-sec hover:bg-contraste/5 hover:text-texto'}`

/** Barra lateral global de 220 px: logo, navegación con texto y mini reproductor horizontal abajo. */
export function Sidebar() {
  return (
    <aside aria-label="Navegación" className="hidden h-full min-h-0 w-[220px] shrink-0 flex-col gap-2 rounded-lg lg:flex">
      <nav aria-label="Principal" className="min-h-0 flex-1 rounded-lg bg-panel p-3">
        <Link to="/" aria-label="SoundBlue, ir al inicio" className="mb-4 inline-flex rounded-md px-1 py-1">
          <Logo />
        </Link>
        <ul className="space-y-1">
          <li><NavLink to="/" end className={linkClass}><House className="size-5 shrink-0" aria-hidden="true" />Inicio</NavLink></li>
          <li><NavLink to="/buscar" className={linkClass}><Search className="size-5 shrink-0" aria-hidden="true" />Buscar</NavLink></li>
          <li><NavLink to="/biblioteca" className={linkClass}><Library className="size-5 shrink-0" aria-hidden="true" />Tu biblioteca</NavLink></li>
          <li><NavLink to="/ajustes" className={linkClass}><SettingsIcon className="size-5 shrink-0" aria-hidden="true" />Ajustes</NavLink></li>
        </ul>
      </nav>
    </aside>
  )
}
