import { ChevronRight } from 'lucide-react'
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Link } from 'react-router'
import { GenrePicker } from '../components/tastes/GenrePicker'
import { Switch } from '../components/ui/Switch'
import { onboarding } from '../lib/onboarding'
import { settings, useSettings, type ThemeChoice } from '../lib/settings'
import { LIMIT_OPTIONS, MB_PER_SONG, offlineCache } from '../player/offlineCache'
import { showToast } from '../ui/toast'

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
      <OfflineSection />
      <section aria-labelledby="ajustes-generos" className="rounded-lg bg-tarjeta p-4">
        <h2 id="ajustes-generos" className="text-lg font-bold">Mis Géneros Favoritos</h2>
        <p className="mt-1 text-sm text-texto-sec">Se usan para filtrar selecciones, recomendaciones, búsqueda y la cola. Si no eliges ninguno, se usan tus artistas o la selección habitual.</p>
        <GenrePicker className="mt-3" />
      </section>
      <section aria-labelledby="ajustes-mas" className="rounded-lg bg-tarjeta p-4">
        <h2 id="ajustes-mas" className="text-lg font-bold">Más</h2>
        <ul className="mt-2">
          <LinkRow to="/gustos">Cambiar tus artistas</LinkRow>
          <li>
            {/* Vuelve a mostrar la bienvenida (artistas, ritmos y cómo importar); la música sigue sonando. */}
            <button type="button" onClick={onboarding.replay} className="flex w-full items-center justify-between py-2 text-left font-semibold hover:underline">
              Ver la bienvenida otra vez
              <ChevronRight className="size-5 text-texto-sec" aria-hidden="true" />
            </button>
          </li>
          <LinkRow to="/ayuda">Ayuda</LinkRow>
        </ul>
        <p className="mt-3 text-sm text-texto-sec">Versión: <span className="font-semibold text-texto">{__APP_VERSION__}</span></p>
      </section>
    </div>
  )
}

/**
 * Modo sin conexión (player/offlineCache.ts): cuántas canciones de «Selecciones rápidas» guardar (15, 30, 50 o 100),
 * «Descargar solo con Wi-Fi», cuántas hay y «Limpiar caché offline» para liberar espacio. Solo en la app de Android.
 */
function OfflineSection() {
  const status = useSyncExternalStore(offlineCache.subscribe, offlineCache.get)
  const [clearing, setClearing] = useState(false)
  useEffect(() => {
    void offlineCache.refresh()
    // Mientras se ve Ajustes, el número (y el aviso de Wi-Fi) se pone al día.
    const timer = window.setInterval(() => void offlineCache.refresh(), 5000)
    return () => window.clearInterval(timer)
  }, [])
  const megabytes = Math.max(1, Math.round(status.bytes / (1024 * 1024)))
  const clear = async () => {
    setClearing(true)
    await offlineCache.clear()
    setClearing(false)
    showToast('Caché offline borrada')
  }
  const chooseLimit = (limit: number) => {
    if (limit === status.target) return
    const removes = Math.max(0, status.count - limit)
    void offlineCache.setLimit(limit)
    if (removes) showToast(`Se borraron las ${removes} canciones guardadas más viejas`)
  }
  // Lo que pasa ahora: guardando, esperando Wi-Fi o internet, o cuántas hay.
  const waitingForWifi = offlineCache.waitingForWifi(status)
  const note = status.downloading
    ? 'Guardando canciones…'
    : waitingForWifi
      ? 'Esperando conexión Wi-Fi para descargar'
      : status.waiting && !status.online
        ? 'Sin conexión: se seguirán guardando al volver internet'
        : null
  return (
    <section aria-labelledby="ajustes-offline" className="rounded-lg bg-tarjeta p-4">
      <h2 id="ajustes-offline" className="text-lg font-bold">Modo sin conexión</h2>
      <p className="mt-1 text-sm text-texto-sec">
        Si te quedas sin internet, la música no se detiene: suenan, una tras otra, canciones de «Selecciones rápidas» guardadas en el teléfono. Al volver la conexión, sigue tu cola donde iba. Cada una dura al menos 24 horas; después se cambian por nuevas.
      </p>
      {offlineCache.enabled ? (
        <>
          <p id="ajustes-offline-cuantas" className="mt-4 font-semibold">Canciones a guardar</p>
          <div role="radiogroup" aria-labelledby="ajustes-offline-cuantas" className="mt-2 flex flex-wrap gap-2">
            {LIMIT_OPTIONS.map((limit) => (
              <button
                key={limit}
                type="button"
                role="radio"
                aria-checked={status.target === limit}
                onClick={() => chooseLimit(limit)}
                className={`rounded-full px-4 py-1.5 text-sm font-semibold transition-colors ${status.target === limit ? 'bg-contraste text-inverso' : 'bg-contraste/10 text-texto hover:bg-contraste/15'}`}
              >
                {limit}
              </button>
            ))}
          </div>
          <p className="mt-1 text-sm text-texto-sec">Hasta unos {Math.round(status.target * MB_PER_SONG)} MB en el teléfono.</p>
          <Switch
            className="mt-4"
            label="Descargar solo con Wi-Fi"
            note={status.wifiOnly ? 'No gasta tus datos móviles: espera a tener Wi-Fi para guardar o renovar canciones.' : 'También descarga con datos móviles (ideal si tu plan es ilimitado).'}
            checked={status.wifiOnly}
            onChange={(on) => void offlineCache.setWifiOnly(on)}
          />
          <p className="mt-4 text-sm font-semibold" role="status">
            {status.count
              ? `${status.count === 1 ? '1 canción guardada' : `${status.count} canciones guardadas`} de ${status.target} · ${megabytes} MB`
              : 'Aún no hay canciones guardadas: se guardan solas al abrir Inicio.'}
          </p>
          {note && <p className="text-sm text-texto-sec">{note}</p>}
          <button
            type="button"
            onClick={() => void clear()}
            disabled={clearing || (!status.count && !status.downloading)}
            className="mt-3 rounded-full bg-contraste/10 px-4 py-2 text-sm font-semibold transition-colors hover:bg-contraste/15 disabled:opacity-40"
          >
            Limpiar caché offline
          </button>
        </>
      ) : (
        <p className="mt-3 text-sm text-texto-sec">Solo en la app de Android.</p>
      )}
    </section>
  )
}

function LinkRow({ to, children }: { to: string; children: ReactNode }) {
  return <li><Link to={to} className="flex items-center justify-between py-2 font-semibold hover:underline">{children}<ChevronRight className="size-5 text-texto-sec" aria-hidden="true" /></Link></li>
}
