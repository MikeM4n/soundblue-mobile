import { ChevronRight } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { GenrePicker } from '../components/tastes/GenrePicker'
import { Switch } from '../components/ui/Switch'
import { onboarding } from '../lib/onboarding'
import { settings, useSettings, type ThemeChoice } from '../lib/settings'
import { MAX_LIMIT, MB_PER_SONG, MIN_LIMIT, offlineCache, useOfflineStatus } from '../player/offlineCache'
import { showToast } from '../ui/toast'

const LIMIT_COMMIT_MS = 700 // el límite de descargas se aplica al dejar de mover el slider

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
 * Modo sin conexión (player/offlineCache.ts): el límite global de descargas (de 50 a 1000 canciones, con lo que se usa y
 * lo que ocupará), «Descargar solo con Wi-Fi», la cola de descargas y «Borrar todas las descargas». Solo en
 * la app de Android.
 */
function OfflineSection() {
  const status = useOfflineStatus()
  const [clearing, setClearing] = useState(false)
  const [draft, setDraft] = useState<number | null>(null) // mientras mueves el slider
  useEffect(() => {
    void offlineCache.refresh()
    // Mientras se ve Ajustes, los números (y el aviso de Wi-Fi) se ponen al día.
    const timer = window.setInterval(() => void offlineCache.refresh(), 5000)
    return () => window.clearInterval(timer)
  }, [])
  // El límite se aplica al dejar de mover el slider (así no se borra nada mientras lo ajustas).
  useEffect(() => {
    if (draft === null) return
    const timer = window.setTimeout(() => {
      void offlineCache.setLimit(draft).then(() => setDraft(null))
    }, LIMIT_COMMIT_MS)
    return () => window.clearTimeout(timer)
  }, [draft])
  const limit = draft ?? status.target
  const over = Math.max(0, status.count - limit)
  const clear = async () => {
    if (!window.confirm(`¿Borrar las ${status.count === 1 ? 'canción descargada' : `${status.count} canciones descargadas`} y la cola de descargas?`)) return
    setClearing(true)
    await offlineCache.clear()
    setClearing(false)
    showToast('Descargas borradas')
  }
  // Lo que pasa ahora: descargando, esperando Wi-Fi o internet.
  const note = status.downloading
    ? `Descargando 1 canción${status.queued ? ` · ${status.queued} en cola` : ''}`
    : offlineCache.waitingForWifi(status)
      ? `Esperando conexión Wi-Fi para descargar${status.queued ? ` (${status.queued} en cola)` : ''}`
      : status.waiting && !status.online
        ? 'Sin conexión: se seguirán descargando al volver internet'
        : null
  return (
    <section aria-labelledby="ajustes-offline" className="rounded-lg bg-tarjeta p-4">
      <h2 id="ajustes-offline" className="text-lg font-bold">Modo sin conexión</h2>
      <p className="mt-1 text-sm text-texto-sec">
        Descarga listas o canciones (botón «Descargar» de cada lista o menú ⋮) para escucharlas sin internet. Solo se guarda lo que tú descargas, de a una canción y en el orden en que lo pediste. Sin internet, tu cola salta las que no están descargadas; si ya no queda ninguna, suenan tus descargas hasta que vuelva la conexión y luego tu cola sigue donde iba.
      </p>
      {offlineCache.enabled ? (
        <>
          <label htmlFor="ajustes-offline-limite" className="mt-4 block font-semibold">
            Límite de descargas
          </label>
          <input
            id="ajustes-offline-limite"
            type="range"
            min={MIN_LIMIT}
            max={MAX_LIMIT}
            step={10}
            value={limit}
            onChange={(e) => setDraft(Number(e.target.value))}
            aria-valuetext={`${limit} canciones, unos ${size(limit * MB_PER_SONG)}`}
            className="mt-3 w-full accent-acento"
          />
          <div className="flex justify-between text-xs text-texto-sec" aria-hidden="true">
            <span>{MIN_LIMIT}</span>
            <span>{MAX_LIMIT}</span>
          </div>
          <p className="mt-2 text-sm font-semibold" role="status">
            Usando: {status.count === 1 ? '1 canción' : `${status.count} canciones`} ({size(status.bytes / (1024 * 1024))}) / Límite: {limit} canciones ({size(limit * MB_PER_SONG)})
          </p>
          {over > 0 && (
            <p className="mt-1 text-sm text-amber-400">
              Con este límite se borrarán {over === 1 ? '1 canción' : `${over} canciones`}: las que menos escuchas.
            </p>
          )}
          <Switch
            className="mt-4"
            label="Descargar solo con Wi-Fi"
            note={status.wifiOnly ? 'No gasta tus datos móviles: espera a tener Wi-Fi para descargar o renovar canciones.' : 'También descarga con datos móviles (ideal si tu plan es ilimitado).'}
            checked={status.wifiOnly}
            onChange={(on) => void offlineCache.setWifiOnly(on)}
          />
          {note && <p className="mt-3 text-sm text-texto-sec">{note}</p>}
          <button
            type="button"
            onClick={() => void clear()}
            disabled={clearing || (!status.count && !status.downloading && !status.queued)}
            className="mt-3 rounded-full bg-contraste/10 px-4 py-2 text-sm font-semibold transition-colors hover:bg-contraste/15 disabled:opacity-40"
          >
            Borrar todas las descargas
          </button>
        </>
      ) : (
        <p className="mt-3 text-sm text-texto-sec">Solo en la app de Android.</p>
      )}
    </section>
  )
}

/** «150 MB», «1,4 GB». */
function size(megabytes: number): string {
  if (megabytes >= 1024) return `${(megabytes / 1024).toLocaleString('es-CO', { maximumFractionDigits: 1 })} GB`
  return `${Math.max(megabytes > 0 ? 1 : 0, Math.round(megabytes))} MB`
}

function LinkRow({ to, children }: { to: string; children: ReactNode }) {
  return <li><Link to={to} className="flex items-center justify-between py-2 font-semibold hover:underline">{children}<ChevronRight className="size-5 text-texto-sec" aria-hidden="true" /></Link></li>
}
