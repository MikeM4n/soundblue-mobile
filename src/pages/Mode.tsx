import { ChevronLeft, Play, Shuffle, SlidersHorizontal } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Navigate, useNavigate, useParams } from 'react-router'
import { TrackList } from '../components/tracks/TrackList'
import { Chips } from '../components/ui/Chips'
import { IconButton } from '../components/ui/IconButton'
import { MODE_LOOK } from '../components/ui/ModeTiles'
import { customMode, defaultModeGenres, MODE_GENRES, MODES, modeNote, modeTracks } from '../data/genres'
import { modeGenres, useModeGenres } from '../data/modeGenres'
import { player } from '../player/engine'
import type { Track } from '../player/types'
import { useNowPlaying } from '../player/useNowPlaying'
import { showToast } from '../ui/toast'

const ALL = 'todo'

/**
 * Modo de ambiente (Rumba, Tomar, Relax): canciones de las playlists de sus géneros (búsquedas como «salsa para
 * fiesta», ver data/genres.ts), con un subfiltro por género («Todo» los mezcla). Con «Personalizar géneros» le agregas
 * o quitas cualquier género de la app (al menos uno). Tocar una o ▶ reemplaza la cola; al acabarse la lista sigue la
 * cola infinita (la radio de la última, mismo género).
 */
export function ModePage() {
  const { modo } = useParams()
  const navigate = useNavigate()
  const { open } = useNowPlaying()
  const saved = useModeGenres()
  const base = MODES.find((m) => m.key === modo)
  const chosen = base ? modeGenres.of(base, saved) : []
  const chosenKey = chosen.join(',')
  const mode = useMemo(() => base && customMode(base, chosenKey.split(',')), [base, chosenKey])
  const [selected, setFilter] = useState(ALL)
  const [editing, setEditing] = useState(false)
  const [loaded, setLoaded] = useState<Record<string, Track[] | 'error'>>({})
  const filter = mode?.filters.some((f) => f.key === selected) ? selected : ALL // si quitaste el que se veía, «Todo»
  const key = `${modo}:${filter}:${chosenKey}`

  useEffect(() => {
    if (!mode || loaded[key]) return
    let alive = true
    modeTracks(mode, filter === ALL ? null : filter)
      .then((tracks) => alive && setLoaded((all) => ({ ...all, [key]: tracks.length ? tracks : 'error' })))
      .catch(() => alive && setLoaded((all) => ({ ...all, [key]: 'error' })))
    return () => {
      alive = false
    }
  }, [mode, filter, key, loaded])

  if (!base || !mode) return <Navigate to="/" replace />
  const { icon: Icon, gradient } = MODE_LOOK[mode.key]
  const list = loaded[key]
  const tracks = Array.isArray(list) ? list : []
  const filterLabel = mode.filters.find((f) => f.key === filter)?.label
  const name = filterLabel ? `${mode.label} · ${filterLabel}` : mode.label
  const customized = chosenKey !== defaultModeGenres(base).join(',')

  // Agregar o quitar un género (el que agregas va al final). Sin ninguno el modo no tendría qué poner: no se permite.
  const toggle = (genre: string) => {
    const next = chosen.includes(genre) ? chosen.filter((k) => k !== genre) : [...chosen, genre]
    if (!modeGenres.set(base, next)) showToast(`${mode.label} necesita al menos un género: agrega otro antes de quitar este.`)
  }

  // La radio que sigue a la lista es de los géneros del modo (Tomar: popular, ranchera y vallenato, o los que elegiste).
  const options = { replaceQueue: true, genres: mode.genres }
  const play = (index: number) => {
    open() // primero «Sonando ahora», así el video aparece ya en su sitio
    player.playContext(name, tracks, index, options)
  }

  return (
    <div className="pb-10">
      <header className={`bg-linear-to-b ${gradient} px-4 pt-4 pb-5 md:px-6`}>
        <IconButton label="Volver" onClick={() => navigate(-1)} className="-ml-2 text-white">
          <ChevronLeft className="size-6" />
        </IconButton>
        <div className="mt-2 flex items-end gap-4">
          <div className="grid size-20 shrink-0 place-items-center rounded-lg bg-black/20">
            <Icon className="size-10 text-white" aria-hidden="true" />
          </div>
          <div className="min-w-0 text-white">
            <p className="text-xs font-semibold tracking-wider text-white/80 uppercase">Modo de ambiente</p>
            <h1 className="text-3xl font-bold md:text-5xl">{mode.label}</h1>
            <p className="text-sm text-white/85">{modeNote(base, chosen)}</p>
          </div>
        </div>
      </header>

      <div className="mt-4">
        <div className="mx-4 mb-3 md:mx-6">
          <button
            type="button"
            aria-expanded={editing}
            onClick={() => setEditing((on) => !on)}
            className="flex items-center gap-2 text-sm font-semibold text-acento-texto hover:underline"
          >
            <SlidersHorizontal className="size-4" aria-hidden="true" />
            Personalizar géneros de {mode.label}
          </button>
          {editing && (
            <div className="mt-2 rounded-lg bg-tarjeta p-3">
              <p className="mb-2 text-sm text-texto-sec">Agrega o quita cualquier género. Debe quedar al menos uno.</p>
              <div role="group" aria-label={`Géneros de ${mode.label}`} className="flex flex-wrap gap-2">
                {MODE_GENRES.map((g) => {
                  const on = chosen.includes(g.key)
                  return (
                    <button
                      key={g.key}
                      type="button"
                      aria-pressed={on}
                      onClick={() => toggle(g.key)}
                      className={`rounded-full px-3 py-1.5 text-sm font-semibold transition-colors ${on ? 'bg-acento text-white' : 'bg-contraste/10 text-texto hover:bg-contraste/15'}`}
                    >
                      {on ? '✓ ' : '+ '}
                      {g.label}
                    </button>
                  )
                })}
              </div>
              <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2">
                <button type="button" onClick={() => setEditing(false)} className="text-sm font-semibold text-acento-texto hover:underline">
                  Listo
                </button>
                {customized && (
                  <button type="button" onClick={() => modeGenres.set(base, defaultModeGenres(base))} className="text-sm font-semibold text-texto-sec hover:text-texto hover:underline">
                    Volver a los de siempre
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
        <Chips label={`Subfiltros de ${mode.label}`} options={[{ key: ALL, label: 'Todo' }, ...mode.filters]} value={filter} onChange={setFilter} />
      </div>
      {/* La acción principal de la pantalla: botón ancho y grande, con «Aleatorio» al lado. */}
      <div className="flex items-center gap-3 px-4 pt-3 md:px-6">
        <button
          type="button"
          disabled={!tracks.length}
          onClick={() => play(0)}
          aria-label={`Reproducir ${name}`}
          className="flex h-14 min-w-0 flex-1 items-center justify-center gap-2 rounded-full bg-acento px-6 text-lg font-bold text-white shadow-lg shadow-acento/30 transition hover:bg-acento-hover active:scale-[.98] disabled:opacity-50 md:max-w-sm"
        >
          <Play className="size-6 shrink-0 fill-current" aria-hidden="true" />
          <span className="truncate">Reproducir {mode.label}</span>
        </button>
        <button
          type="button"
          disabled={!tracks.length}
          onClick={() => {
            open()
            player.shuffleContext(name, tracks, options)
          }}
          aria-label={`Reproducir ${name} en aleatorio`}
          className="flex h-14 shrink-0 items-center gap-2 rounded-full bg-contraste/10 px-5 font-semibold text-texto transition hover:bg-contraste/15 disabled:opacity-50"
        >
          <Shuffle className="size-5" aria-hidden="true" />
          Aleatorio
        </button>
      </div>
      <p className="px-4 pt-2 text-xs text-texto-sec md:px-6">{mode.key === 'rumba' ? 'Se priorizan videos musicales con más de 1 millón de reproducciones; si la API no está disponible, usamos playlists de YouTube Music. Sin covers ni artistas que sueles saltar.' : 'Sin covers, sin artistas que sueles saltar y como mucho 2 canciones por artista.'}</p>

      {list === undefined && <p className="mt-6 px-4 text-sm text-texto-sec md:px-6">Armando la lista…</p>}
      {list === 'error' && <p className="mt-6 px-4 text-sm text-texto-sec md:px-6">No se pudo armar la lista. Revisa tu conexión y vuelve a intentarlo.</p>}
      {tracks.length > 0 && (
        <div className="mt-3">
          <TrackList key={key} tracks={tracks} numbered={false} onPlay={play} />
        </div>
      )}
    </div>
  )
}
