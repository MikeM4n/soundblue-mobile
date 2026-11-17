import { ChevronLeft, LoaderCircle, RefreshCw, Shuffle, SlidersHorizontal } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Navigate, useNavigate, useParams } from 'react-router'
import { TrackList } from '../components/tracks/TrackList'
import { Chips } from '../components/ui/Chips'
import { IconButton } from '../components/ui/IconButton'
import { MODE_LOOK } from '../components/ui/ModeTiles'
import { PlayButton } from '../components/ui/PlayButton'
import { customMode, defaultModeGenres, MODE_GENRES, MODES, modeNote, modeTracks, type Mode, type ModeTrack } from '../data/genres'
import { CACHE_TRACKS, modeCache } from '../data/modeCache'
import { modeGenres, modeRhythm, RHYTHM_OPTIONS, useModeGenres, useModeRhythm } from '../data/modeGenres'
import { continueRotation, mergeModeTracks, rotateByGenre } from '../data/modeRotation'
import { player } from '../player/engine'
import { useNowPlaying } from '../player/useNowPlaying'
import { showToast } from '../ui/toast'

const ALL = 'todo'
const LIMIT = 50 // canciones de la lista de un modo

/** Canciones de un modo (en el orden en que llegaron: equilibradas entre géneros) y si falta alguna (carga progresiva). */
interface Loaded {
  items: ModeTrack[]
  done: boolean
}

/**
 * La lista de un Modo que suena: si llegan más canciones (o cambias «Canciones por ritmo»), su cola sigue la rotación.
 * Fuera del componente: vale también si sales de la página y vuelves (mientras siga sonando esa lista).
 */
interface Playing {
  key: string
  id: number // el de engine.playContext
  seed?: number // «Aleatorio»: el azar dentro de cada género
  items: ModeTrack[] // todas las de esa lista que se conocen (las que había al darle ▶ y las que llegaron después)
}
let playing: Playing | null = null

/**
 * Modo de ambiente (Rumba, Tomar, Relax): canciones de las playlists de sus géneros (búsquedas como «salsa para
 * fiesta», ver data/genres.ts), con un subfiltro por género («Todo» los mezcla). Con «Personalizar géneros» le agregas
 * o quitas cualquier género de la app (al menos uno). Tocar una o ▶ reemplaza la cola; al acabarse la lista sigue la
 * cola infinita (la radio de la última, mismo género).
 * - Rotación de ritmos («Canciones por ritmo», 1 a 5, 2 por defecto): la lista y la cola van por bloques de cada género,
 *   en el orden del modo (Salsa 1, Salsa 2, Reggaetón 1, Reggaetón 2, Merengue 1…). «Aleatorio» mezcla dentro de cada
 *   género, pero respeta la rotación.
 * - Caché (data/modeCache.ts): las primeras 20 se muestran al instante desde el teléfono y ya se les puede dar ▶; el resto
 *   llega en segundo plano y va detrás. Si la lista tiene más de 24 h, se buscan canciones nuevas en segundo plano (la
 *   que se ve no cambia hasta que llegan); «Actualizar lista» hace lo mismo cuando quieras.
 * - Carga progresiva: en cuanto hay 5 canciones se ven y se puede dar ▶; lo que llega con la lista ya sonando se suma a
 *   su cola en la misma rotación (engine.replanContext).
 */
export function ModePage() {
  const { modo } = useParams()
  const navigate = useNavigate()
  const { open } = useNowPlaying()
  const saved = useModeGenres()
  const rhythms = useModeRhythm()
  const base = MODES.find((m) => m.key === modo)
  const chosen = base ? modeGenres.of(base, saved) : []
  const chosenKey = chosen.join(',')
  const mode = useMemo(() => base && customMode(base, chosenKey.split(',')), [base, chosenKey])
  const [selected, setFilter] = useState(ALL)
  const [editing, setEditing] = useState(false)
  const [loaded, setLoaded] = useState<Record<string, Loaded | 'error' | undefined>>({})
  const [renewing, setRenewing] = useState<Record<string, boolean>>({}) // buscando canciones nuevas (Actualizar o 24 h)
  const requested = useRef(new Set<string>()) // listas pedidas (no se cancelan al llegar las primeras canciones)
  const generation = useRef<Record<string, number>>({}) // la última búsqueda de cada lista: las anteriores se descartan
  const mounted = useRef(true)
  const filter = mode?.filters.some((f) => f.key === selected) ? selected : ALL // si quitaste el que se veía, «Todo»
  const key = `${modo}:${filter}:${chosenKey}`
  const perRhythm = base ? modeRhythm.of(base, rhythms) : 2
  const genres = useMemo(() => mode?.filters.map((source) => source.key) ?? [], [mode])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  /**
   * Busca la lista `target` en internet. Sin `base`: la primera vez (carga progresiva). Con `base` y sin `renew` (caché de
   * hoy): lo que llega va DETRÁS de las de la caché. Con `renew` (Actualizar o caché de más de 24 h): canciones nuevas
   * (otra semilla; las que se veían, al final); la lista cambia cuando llegan al menos 20 (o terminó). La guarda en la
   * caché al terminar, salvo con la caché de hoy (sigue la de hoy). `manual` (tocaste «Actualizar»): si no encuentra
   * nada, lo avisa (la renovación automática no molesta).
   */
  const search = (target: string, targetMode: Mode, targetFilter: string, base: ModeTrack[] | null, renew: boolean, manual = false) => {
    const turn = (generation.current[target] = (generation.current[target] ?? 0) + 1)
    const current = () => mounted.current && generation.current[target] === turn
    const update = (value: Loaded | 'error') => current() && setLoaded((all) => ({ ...all, [target]: value }))
    const finish = () => current() && setRenewing((all) => ({ ...all, [target]: false }))
    if (renew) setRenewing((all) => ({ ...all, [target]: true }))
    const combine = (items: ModeTrack[], done: boolean): Loaded | null => {
      if (!base) return { items, done }
      if (!renew) return { items: mergeModeTracks(base, items, LIMIT), done }
      return done || items.length >= Math.min(base.length, CACHE_TRACKS) ? { items, done } : null // hasta entonces, la de antes
    }
    const fresh = renew ? { seed: Date.now(), avoid: new Set(base?.map((item) => item.track.id)) } : {}
    modeTracks(targetMode, targetFilter === ALL ? null : targetFilter, LIMIT, (items) => {
      const next = combine(items, false)
      if (next) update(next)
    }, fresh)
      .then((items) => {
        if (!items.length) {
          update(base ? { items: base, done: true } : 'error')
          if (manual && base && current()) showToast('No se encontraron canciones nuevas. Revisa tu conexión y vuelve a intentarlo.')
          return
        }
        update(combine(items, true)!)
        if ((!base || renew) && current()) modeCache.write(target, items)
      })
      .catch(() => {
        update(base ? { items: base, done: true } : 'error')
        if (manual && base && current()) showToast('No se pudo actualizar la lista. Revisa tu conexión y vuelve a intentarlo.')
      })
      .finally(finish)
  }

  // Al entrar (o cambiar de subfiltro o de géneros): la caché al instante, si hay, y en segundo plano la búsqueda.
  useEffect(() => {
    if (!mode || requested.current.has(key)) return
    requested.current.add(key)
    const cached = modeCache.read(key)
    if (cached) setLoaded((all) => ({ ...all, [key]: { items: cached.items, done: false } }))
    search(key, mode, filter, cached?.items ?? null, !!cached && !modeCache.isFresh(cached))
  }, [mode, filter, key]) // (`search` es de este render: lo que usa ya va en `key`)

  const list = loaded[key]
  const items = useMemo(() => (list && list !== 'error' ? list.items : []), [list])
  // Lo que se ve y lo que suena con ▶: la rotación de ritmos.
  const tracks = useMemo(() => rotateByGenre(items, perRhythm, genres), [items, perRhythm, genres])

  // Llegaron más canciones (o cambiaste «Canciones por ritmo») con esta lista sonando: la cola sigue la rotación donde iba,
  // con todas las que se conocen de ella (al volver a la página se ve la caché: no por eso se pierden las demás).
  useEffect(() => {
    const now = playing
    if (now?.key !== key || !items.length) return
    const known = new Set(now.items.map((item) => item.track.id))
    now.items = [...now.items, ...items.filter((item) => !known.has(item.track.id))]
    const all = now.items
    player.replanContext(now.id, (played) => continueRotation(played, all, perRhythm, genres, now.seed))
  }, [items, perRhythm, genres, key])

  if (!base || !mode) return <Navigate to="/" replace />
  const { icon: Icon, gradient } = MODE_LOOK[mode.key]
  const loadingMore = !!list && list !== 'error' && !list.done && !renewing[key]
  const filterLabel = mode.filters.find((f) => f.key === filter)?.label
  const name = filterLabel ? `${mode.label} · ${filterLabel}` : mode.label
  const customized = chosenKey !== defaultModeGenres(base).join(',')
  const rotating = filter === ALL && mode.filters.length > 1 // con un solo género no hay rotación

  // Agregar o quitar un género (el que agregas va al final). Sin ninguno el modo no tendría qué poner: no se permite.
  const toggle = (genre: string) => {
    const next = chosen.includes(genre) ? chosen.filter((k) => k !== genre) : [...chosen, genre]
    if (!modeGenres.set(base, next)) showToast(`${mode.label} necesita al menos un género: agrega otro antes de quitar este.`)
  }

  // La radio que sigue a la lista es de los géneros del modo (Tomar: popular, ranchera y vallenato, o los que elegiste).
  // `ordered`: la cola va en el orden de la rotación (sin aleatorio), también en el reproductor nativo.
  const options = { replaceQueue: true, genres: mode.genres, ordered: true }
  const play = (index: number) => {
    open() // primero «Sonando ahora», así el video aparece ya en su sitio
    playing = { key, id: player.playContext(name, tracks, index, options), items }
  }
  // «Aleatorio»: al azar dentro de cada género, empezando por uno al azar, pero en rotación.
  const playShuffled = () => {
    open()
    const seed = Date.now()
    const start = { genre: genres[seed % genres.length], used: 0 }
    playing = { key, id: player.playContext(name, rotateByGenre(items, perRhythm, genres, { seed, start }), 0, options), seed, items }
  }
  const refresh = () => {
    if (renewing[key]) return
    if (!items.length) setLoaded((all) => ({ ...all, [key]: undefined })) // no había lista (error): «Armando la lista…»
    search(key, mode, filter, items.length ? items : null, items.length > 0, true)
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
      {/* Como en la cabecera de una playlist: ▶ redondo, Aleatorio y Actualizar lista. */}
      <div className="flex items-center gap-3 px-4 pt-3 md:px-6">
        <PlayButton label={`Reproducir ${name}`} disabled={!tracks.length} onClick={() => play(0)} />
        <IconButton label={`Reproducir ${name} en aleatorio`} disabled={!tracks.length} onClick={playShuffled}>
          <Shuffle className="size-6" />
        </IconButton>
        <IconButton label="Actualizar lista" disabled={!!renewing[key]} onClick={refresh}>
          <RefreshCw className={`size-6 ${renewing[key] ? 'animate-spin' : ''}`} />
        </IconButton>
      </div>
      {rotating && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 pt-3 md:px-6">
          <span id="canciones-por-ritmo" className="text-sm font-semibold text-texto">
            Canciones por ritmo
          </span>
          <div role="group" aria-labelledby="canciones-por-ritmo" className="flex gap-1.5">
            {RHYTHM_OPTIONS.map((n) => (
              <button
                key={n}
                type="button"
                aria-pressed={perRhythm === n}
                aria-label={n === 1 ? '1 canción por ritmo' : `${n} canciones por ritmo`}
                onClick={() => modeRhythm.set(base, n)}
                className={`grid size-9 place-items-center rounded-full text-sm font-semibold transition-colors ${perRhythm === n ? 'bg-acento text-white' : 'bg-contraste/10 text-texto hover:bg-contraste/15'}`}
              >
                {n}
              </button>
            ))}
          </div>
        </div>
      )}
      <p className="px-4 pt-2 text-xs text-texto-sec md:px-6">{mode.key === 'rumba' ? 'Se priorizan videos musicales con más de 1 millón de reproducciones; si la API no está disponible, usamos playlists de YouTube Music. Sin covers, sin artistas que sueles saltar ni lo que sonó en las últimas 24 h.' : 'Sin covers, sin artistas que sueles saltar ni lo que sonó en las últimas 24 h, y como mucho 2 canciones por artista.'}</p>

      {list === undefined && <p className="mt-6 px-4 text-sm text-texto-sec md:px-6">Armando la lista…</p>}
      {list === 'error' && <p className="mt-6 px-4 text-sm text-texto-sec md:px-6">No se pudo armar la lista. Revisa tu conexión y vuelve a intentarlo.</p>}
      {renewing[key] && tracks.length > 0 && (
        <p className="mt-3 flex items-center gap-2 px-4 text-sm text-texto-sec md:px-6">
          <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
          Buscando canciones nuevas…
        </p>
      )}
      {tracks.length > 0 && (
        <div className="mt-3">
          <TrackList key={key} tracks={tracks} numbered={false} onPlay={play} />
        </div>
      )}
      {loadingMore && (
        <p className="mt-2 flex items-center gap-2 px-4 text-sm text-texto-sec md:px-6">
          <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
          Cargando más canciones…
        </p>
      )}
    </div>
  )
}
