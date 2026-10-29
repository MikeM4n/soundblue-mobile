import { ChevronRight } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { GenrePicker } from '../components/tastes/GenrePicker'
import { Switch } from '../components/ui/Switch'
import { settings, useSettings, type ThemeChoice } from '../lib/settings'

const THEMES: { key: ThemeChoice; label: string; note: string }[] = [
  { key: 'sistema', label: 'Predeterminado del sistema', note: 'Claro u oscuro, como tu teléfono' },
  { key: 'claro', label: 'Claro', note: 'Fondo blanco' },
  { key: 'oscuro', label: 'Oscuro', note: 'Negro puro (AMOLED): ahorra batería en pantallas OLED' },
]

export function Settings() {
  const { hideViewToggle, dynamicQueue, theme } = useSettings()
  return (
    <div className="mx-auto max-w-2xl space-y-4 px-4 pt-6 pb-10">
      <h1 className="text-2xl font-bold md:text-3xl">Ajustes</h1>
      <section aria-labelledby="ajustes-tema" className="rounded-lg bg-tarjeta p-4">
        <h2 id="ajustes-tema" className="text-lg font-bold">Tema</h2>
        <div role="radiogroup" aria-labelledby="ajustes-tema" className="mt-2 space-y-1">
          {THEMES.map((option) => (
            <button key={option.key} type="button" role="radio" aria-checked={theme === option.key} onClick={() => settings.set({ theme: option.key })} className="flex w-full items-center gap-3 rounded-md py-2 text-left">
              <span className={`grid size-5 shrink-0 place-items-center rounded-full border-2 ${theme === option.key ? 'border-acento' : 'border-texto-sec'}`} aria-hidden="true">
                {theme === option.key && <span className="size-2.5 rounded-full bg-acento" />}
              </span>
              <span className="min-w-0"><span className="block font-semibold">{option.label}</span><span className="block text-sm text-texto-sec">{option.note}</span></span>
            </button>
          ))}
        </div>
      </section>
      <section aria-labelledby="ajustes-sonando" className="rounded-lg bg-tarjeta p-4">
        <h2 id="ajustes-sonando" className="text-lg font-bold">Sonando ahora</h2>
        <Switch className="mt-3" label="Mostrar «Canción | Letra»" note="Si lo ocultas, siempre se ve la carátula (sin la letra). La música suena igual." checked={!hideViewToggle} onChange={(on) => settings.set({ hideViewToggle: !on })} />
        <Switch className="mt-4" label="Fila Dinámica" note="La cola nunca baja de 10: si quitas una o se acaba la lista, entran canciones de «Recomendadas». También se cambia en «Próximas en sonar»." checked={dynamicQueue} onChange={(on) => settings.set({ dynamicQueue: on })} />
      </section>
      <section aria-labelledby="ajustes-generos" className="rounded-lg bg-tarjeta p-4">
        <h2 id="ajustes-generos" className="text-lg font-bold">Mis Géneros Favoritos</h2>
        <p className="mt-1 text-sm text-texto-sec">Se usan para filtrar selecciones, recomendaciones, búsqueda y la cola. Si no eliges ninguno, se usan tus artistas o la selección habitual.</p>
        <GenrePicker className="mt-3" />
      </section>
      <section aria-labelledby="ajustes-mas" className="rounded-lg bg-tarjeta p-4">
        <h2 id="ajustes-mas" className="text-lg font-bold">Más</h2>
        <ul className="mt-2">
          <LinkRow to="/gustos">Cambiar tus artistas</LinkRow>
          <LinkRow to="/ayuda">Ayuda</LinkRow>
        </ul>
        <p className="mt-3 text-sm text-texto-sec">Versión: <span className="font-semibold text-texto">{__APP_VERSION__}</span></p>
      </section>
    </div>
  )
}

function LinkRow({ to, children }: { to: string; children: ReactNode }) {
  return <li><Link to={to} className="flex items-center justify-between py-2 font-semibold hover:underline">{children}<ChevronRight className="size-5 text-texto-sec" aria-hidden="true" /></Link></li>
}
