import { Plus, Settings as SettingsIcon } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { Link, Navigate } from 'react-router'
import { Logo } from '../components/brand/Logo'
import { ArtistTopSongsRow } from '../components/tracks/ArtistTopSongs'
import { Chips } from '../components/ui/Chips'
import { Cover } from '../components/ui/Cover'
import { FavoritesCover, TopCover } from '../components/ui/LibraryItem'
import { ModeTiles } from '../components/ui/ModeTiles'
import { CardPages, TrackPages } from '../components/ui/RowPages'
import { Section } from '../components/ui/Section'
import { SkeletonRows, SkeletonSection } from '../components/ui/Skeleton'
import { computeForYou, type ForYou } from '../data/forYou'
import { favoriteGenres, useFavoriteGenres } from '../data/favoriteGenres'
import { genreIndex, type GenreKey } from '../data/genreIndex'
import { NOT_ORIGINAL, POPULAR_GENRES, QUICK_PICK_DEFAULT, QUICK_PICK_OPTIONS, sourcePlaylists, sourceTracks } from '../data/genres'
import { listening } from '../data/history'
import { artistKeys, capPerArtist, unique } from '../data/lists'
import { createRadio } from '../data/radio'
import { readTastes } from '../data/tastes'
import { ytmHome, type YtmCard, type YtmSection } from '../data/ytmusic'
import { library, useLibrary } from '../library/store'
import { greeting } from '../lib/format'
import { player } from '../player/engine'
import { coverSources, type Track } from '../player/types'
import { useNowPlaying } from '../player/useNowPlaying'

// Estantes de YouTube Music que no se muestran: su «Selecciones rápidas» no es personal (sin iniciar sesión no sabe qué
// escuchas; la nuestra va por género) y «Versiones y remixes» son covers.
const HIDDEN_SHELVES = /selecciones r[aá]pidas|versiones|covers/i
const MIN_TRACKS = 4 // un estante de canciones con menos, tras los filtros, no se muestra
const YOUR_TILES = 4 // accesos con tus canciones bajo «Tus me gusta» y «Tu Top 50» (6 en total: filas completas)

/**
 * Inicio: saludo, accesos rápidos (Tus me gusta, Tu Top 50 y tus canciones: las que te gustan o las últimas que sonaron), los
 * Modos de ambiente, «Para ti» («Selecciones rápidas» y «Muy sonadas» por género, «Tus artistas» con sus canciones más
 * conocidas y sugerencias según tus artistas, favoritas e historial; ver data/genres.ts, data/forYou.ts y
 * data/artistTop.ts) y las tendencias, solo de tus géneros. Todo en listas compactas que se deslizan de lado. La primera
 * vez lleva a «¿Qué artistas te gustan?».
 */
export function Home() {
  const { open } = useNowPlaying()
  const { favorites } = useLibrary()
  const [tastes] = useState(readTastes)
  const [ytm, setYtm] = useState<YtmSection[] | 'error' | null>(null)
  const [mine, setMine] = useState<ForYou | null>(null)

  useEffect(() => {
    if (!tastes) return // primero elige sus artistas
    let alive = true
    ytmHome()
      .then((sections) => alive && setYtm(sections.length ? sections : 'error'))
      .catch(() => alive && setYtm('error'))
    // «Para ti» se recalcula al abrir, al marcar o quitar favoritas y al terminar de escuchar canciones.
    let pending: number | undefined
    const refresh = (rotate: boolean) =>
      computeForYou({ rotate })
        .then((data) => alive && setMine(data))
        .catch(() => {}) // nunca un error en pantalla: si falla, se queda lo anterior
    const later = () => {
      window.clearTimeout(pending)
      pending = window.setTimeout(() => refresh(false), 1500)
    }
    void refresh(true)
    const offLibrary = library.subscribe(later)
    const offListening = listening.subscribe(later)
    return () => {
      alive = false
      window.clearTimeout(pending)
      offLibrary()
      offListening()
    }
  }, [tastes])

  if (!tastes) return <Navigate to="/gustos" replace />

  // Tocar una canción abre «Sonando ahora» y pone su radio (en ese orden: así el video aparece ya en su sitio): 10
  // «Recomendadas basadas en esta canción» y luego «Nuevas para ti». En Inicio lo que tocas reemplaza la cola: nada se
  // agrega a la cola sin que lo pidas (con «⋮» o en Buscar).
  const playSong = (track: Track, name = `Radio de «${track.title}»`) => {
    open()
    player.playRadio(name, track, createRadio(track), { replaceQueue: true })
  }
  // Tus canciones: una que te gusta suena dentro de «Tus me gusta»; una de las últimas que sonaron, con su radio.
  const playYours = (track: Track) => {
    const index = favorites.findIndex((t) => t.id === track.id)
    if (index < 0) return playSong(track)
    open()
    player.playContext('Tus me gusta', favorites, index, { replaceQueue: true })
  }
  // «Tus artistas»: como mucho 1 de cada 5 del mismo artista; el resto, su género.
  const playArtist = (artist: YtmCard, track: Track) => playSong(track, `Radio de ${artist.title}`)

  // Estrictamente lo tuyo: las que te gustan (la más reciente primero) y, si faltan, las últimas que sonaron.
  const yours = unique([...favorites, ...listening.entries().map((entry) => entry.track)]).slice(0, YOUR_TILES)
  const shown = new Set(mine?.shownIds)
  const artists = mine?.artists ?? tastes.artists
  const trends = Array.isArray(ytm) && mine ? forYourGenres(ytm, mine, shown) : null

  return (
    <div className="pb-10">
      <header className="bg-linear-to-b from-acento/30 via-acento/5 to-transparent px-4 pt-6 pb-2 md:px-6">
        {/* En el celular no hay barra lateral: el nombre de la app y Ajustes van arriba de Inicio. */}
        <div className="mb-4 flex items-center justify-between md:hidden">
          <Logo />
          <Link to="/ajustes" aria-label="Ajustes" className="grid size-10 place-items-center rounded-full text-texto-sec hover:text-texto">
            <SettingsIcon className="size-6" aria-hidden="true" />
          </Link>
        </div>
        <h1 className="text-2xl font-bold md:text-3xl">{greeting()}</h1>
        <ul className="mt-5 grid grid-cols-2 gap-2 xl:grid-cols-3" aria-label="Accesos rápidos">
          <QuickTile to="/coleccion/favoritos/todas" title="Tus me gusta" cover={<FavoritesCover className="size-14 md:size-16" />} />
          {/* Las 50 que más escuchaste aquí (data/history.ts). */}
          <QuickTile to="/coleccion/top/50" title="Tu Top 50" cover={<TopCover className="size-14 rounded-none md:size-16" />} />
          {yours.map((track) => (
            <QuickTile
              key={track.id}
              title={track.title}
              cover={<Cover seed={track.id} src={coverSources(track)} className="size-14 shrink-0 md:size-16" />}
              onPlay={() => playYours(track)}
            />
          ))}
        </ul>
      </header>

      <div aria-label="Para ti">
        <Kicker>Para ti · sugerencias</Kicker>
        <GenreQuickPicks hide={shown} onPlay={playSong} artistGenres={tastes.artists.flatMap((artist) => artistKeys(artist.title))} />
      </div>

      <Section title="Modos">
        <ModeTiles />
      </Section>

      {/* «Para ti»: sugerencias propias (no son recomendaciones oficiales de YouTube Music). */}
      <div aria-label="Para ti">
        {mine === null && <SkeletonSection label="Preparando tus sugerencias…" />}
        {mine?.shelves.map((shelf) => (
          <Section key={shelf.key} title={shelf.title}>
            <p className="-mt-2 mb-1 px-4 text-sm text-texto-sec md:px-6">{shelf.note}</p>
            <TrackPages tracks={shelf.tracks} onPlay={(i) => playSong(shelf.tracks[i])} />
          </Section>
        ))}
        <GenrePlaylists />
        {mine && mine.similar.length > 0 && (
          <Section title="Artistas recomendados para ti">
            <CardPages cards={mine.similar} />
          </Section>
        )}
        <Section title="Tus artistas">
          {/* Son los que elegiste: salen enseguida, sin esperar a «Para ti» (sus canciones ya vienen de la bienvenida). */}
          {artists.length > 0 && <ArtistTopSongsRow artists={artists} onPlay={playArtist} />}
          <Link to="/gustos" className="mx-4 mt-2 inline-flex items-center gap-2 rounded-full bg-contraste/10 px-4 py-2 text-sm font-semibold hover:bg-contraste/15 md:mx-6">
            <Plus className="size-4" aria-hidden="true" />{tastes.artists.length ? 'Agregar más artistas' : 'Elegir tus artistas'}
          </Link>
        </Section>
      </div>

      {(ytm === null || (ytm !== 'error' && !mine)) && <SkeletonSection label="Cargando tendencias…" />}
      {trends && trends.length > 0 && (
        <div aria-label="Tendencias">
          <Kicker>Tendencias · solo de tus géneros</Kicker>
          {trends.map((section) => (
            <Section key={section.title} title={section.title}>
              {section.tracks.length > 0 && <TrackPages tracks={section.tracks} onPlay={(i) => playSong(section.tracks[i])} />}
              {section.cards.length > 0 && <CardPages cards={section.cards} />}
            </Section>
          ))}
        </div>
      )}
      {ytm === 'error' && <p className="mt-8 px-4 text-sm text-texto-sec md:px-6">No se pudo cargar el catálogo. Revisa tu conexión y vuelve a abrir Inicio.</p>}
    </div>
  )
}

/**
 * «Selecciones rápidas» por género (por defecto Salsa, Reggaetón, Merengue y Popular; con «+» eliges cuáles, y se
 * recuerda en este navegador): canciones de las playlists de YouTube Music de ese género, sin las que ya se ven en otro
 * estante de Inicio. Cada género se pide al elegirlo.
 */
function GenreQuickPicks({ hide, onPlay, artistGenres }: { hide: ReadonlySet<string>; onPlay: (track: Track) => void; artistGenres: string[] }) {
  const preferred = useFavoriteGenres()
  const [derived, setDerived] = useState<GenreKey[]>([])
  useEffect(() => { if (preferred.length || !artistGenres.length) { setDerived([]); return }
    void genreIndex().then((index) => setDerived([...new Set(artistGenres.flatMap((artist) => [...(index.get(artist) ?? [])]))])).catch(() => setDerived([]))
  }, [preferred.join(','), artistGenres.join(',')])
  const chosen: GenreKey[] = preferred.length ? preferred : derived.length ? derived : QUICK_PICK_DEFAULT as GenreKey[]
  const [picking, setPicking] = useState(false)
  const genres = QUICK_PICK_OPTIONS.filter((g) => chosen.includes(g.key as GenreKey))
  const [selected, setGenre] = useState(genres[0].key)
  const genre = chosen.includes(selected as GenreKey) ? selected : genres[0].key // si quitaste el que se veía, el primero
  const [loaded, setLoaded] = useState<Record<string, Track[] | 'error'>>({})
  useEffect(() => {
    if (loaded[genre]) return
    let alive = true
    const source = QUICK_PICK_OPTIONS.find((g) => g.key === genre)!
    sourceTracks(source, 24)
      .then((tracks) => alive && setLoaded((all) => ({ ...all, [genre]: tracks.length ? tracks : 'error' })))
      .catch(() => alive && setLoaded((all) => ({ ...all, [genre]: 'error' })))
    return () => {
      alive = false
    }
  }, [genre, loaded])
  // Quitar o poner un género (siempre queda al menos uno).
  const toggle = (key: string) => {
    const typed = key as GenreKey
    const next = chosen.includes(typed) ? chosen.filter((k) => k !== typed) : QUICK_PICK_OPTIONS.map((g) => g.key as GenreKey).filter((k) => k === typed || chosen.includes(k))
    favoriteGenres.set(next)
  }
  const list = loaded[genre]
  const tracks = Array.isArray(list) ? list.filter((track) => !hide.has(track.id)).slice(0, 16) : []
  return (
    <Section
      title="Selecciones rápidas"
      action={
        <button
          type="button"
          aria-label="Elegir los géneros de las selecciones rápidas"
          aria-expanded={picking}
          onClick={() => setPicking((open) => !open)}
          className={`grid size-8 place-items-center rounded-full transition-colors ${picking ? 'bg-contraste text-inverso' : 'bg-contraste/10 text-texto hover:bg-contraste/15'}`}
        >
          <Plus className={`size-5 transition-transform ${picking ? 'rotate-45' : ''}`} aria-hidden="true" />
        </button>
      }
    >
      {picking && (
        <div className="mx-4 mb-3 rounded-lg bg-tarjeta p-3 md:mx-6">
          <p className="mb-2 text-sm text-texto-sec">Elige qué géneros quieres ver aquí:</p>
          <div role="group" aria-label="Géneros de las selecciones rápidas" className="flex flex-wrap gap-2">
            {QUICK_PICK_OPTIONS.map((g) => {
              const on = chosen.includes(g.key as GenreKey)
              return (
                <button
                  key={g.key}
                  type="button"
                  aria-pressed={on}
                  disabled={on && chosen.length === 1} // al menos uno
                  onClick={() => toggle(g.key)}
                  className={`rounded-full px-3 py-1.5 text-sm font-semibold transition-colors disabled:opacity-60 ${on ? 'bg-acento text-white' : 'bg-contraste/10 text-texto hover:bg-contraste/15'}`}
                >
                  {on ? '✓ ' : '+ '}
                  {g.label}
                </button>
              )
            })}
          </div>
          <button type="button" onClick={() => setPicking(false)} className="mt-3 text-sm font-semibold text-acento-texto hover:underline">
            Listo
          </button>
        </div>
      )}
      <Chips label="Género de las selecciones rápidas" options={genres} value={genre} onChange={setGenre} />
      {list === undefined && <SkeletonRows />}
      {list === 'error' && <p className="px-4 text-sm text-texto-sec md:px-6">No se pudo cargar este género. Revisa tu conexión.</p>}
      {tracks.length > 0 && <TrackPages key={genre} tracks={tracks} onPlay={(i) => onPlay(tracks[i])} />}
    </Section>
  )
}

/** «Muy sonadas»: las playlists más escuchadas de cada género (Salsa, Reggaetón, Merengue, Popular, Vallenato…). */
function GenrePlaylists() {
  const [genre, setGenre] = useState(POPULAR_GENRES[0].key)
  const [loaded, setLoaded] = useState<Record<string, YtmCard[] | 'error'>>({})
  useEffect(() => {
    if (loaded[genre]) return
    let alive = true
    const source = POPULAR_GENRES.find((g) => g.key === genre)!
    sourcePlaylists(source)
      .then((cards) => alive && setLoaded((all) => ({ ...all, [genre]: cards.length ? cards.slice(0, 8) : 'error' })))
      .catch(() => alive && setLoaded((all) => ({ ...all, [genre]: 'error' })))
    return () => {
      alive = false
    }
  }, [genre, loaded])
  const list = loaded[genre]
  return (
    <Section title="Muy sonadas">
      <p className="-mt-2 mb-3 px-4 text-sm text-texto-sec md:px-6">Las listas más escuchadas de cada género</p>
      <Chips label="Género de las listas muy sonadas" options={POPULAR_GENRES} value={genre} onChange={setGenre} />
      {list === undefined && <SkeletonRows />}
      {list === 'error' && <p className="px-4 text-sm text-texto-sec md:px-6">No se pudo cargar este género. Revisa tu conexión.</p>}
      {Array.isArray(list) && <CardPages key={genre} cards={list} />}
    </Section>
  )
}

/**
 * Tendencias y novedades de YouTube Music, solo de tus géneros: canciones y álbumes de artistas que aparecen en las
 * radios de lo que escuchas (o tuyos). Sin covers, sin artistas que sueles saltar, sin las que ya están en «Para ti»,
 * ninguna en dos estantes y 2 por artista como mucho. Las playlists quedan (son por género o por ánimo).
 */
function forYourGenres(sections: YtmSection[], mine: ForYou, shown: Set<string>): YtmSection[] {
  const genre = new Set(mine.genreArtists)
  const hasGlobalGenres = favoriteGenres.get().length > 0
  const skipped = new Set(mine.skippedArtists)
  const taken = new Set(shown)
  const ofYourGenres = (artist: string) => {
    const keys = artistKeys(artist)
    // Sin nada tuyo todavía (ni artistas ni historial), no se filtra por género.
    return !keys.some((key) => skipped.has(key)) && (hasGlobalGenres ? genre.size > 0 && keys.some((key) => genre.has(key)) : genre.size === 0 || keys.some((key) => genre.has(key)))
  }
  return sections
    .filter((section) => !HIDDEN_SHELVES.test(section.title))
    .map((section) => {
      const tracks = capPerArtist(
        section.tracks.filter((track) => !NOT_ORIGINAL.test(track.title) && ofYourGenres(track.artist)),
        2,
        taken,
      )
      // Álbumes y singles: «Single • Bad Bunny y Jhayco»; artistas: su nombre.
      const cards = section.cards.filter((card) =>
        card.kind === 'album' ? ofYourGenres(card.subtitle.split('•').at(-1) ?? '') : card.kind === 'artist' ? ofYourGenres(card.title) : true,
      )
      return { ...section, tracks: tracks.length >= MIN_TRACKS ? tracks : [], cards }
    })
    .filter((section) => section.tracks.length > 0 || section.cards.length > 0)
}

function Kicker({ children }: { children: ReactNode }) {
  return <p className="mt-8 px-4 text-xs font-semibold tracking-wider text-texto-sec uppercase md:px-6">{children}</p>
}

/** Acceso rápido: abre una lista (`to`) o reproduce una canción (`onPlay`). */
function QuickTile({ title, cover, to, onPlay }: { title: string; cover: ReactNode; to?: string; onPlay?: () => void }) {
  const className =
    'flex h-14 w-full items-center gap-3 overflow-hidden rounded-md bg-tarjeta text-left transition-colors hover:bg-tarjeta-claro md:h-16'
  const content = (
    <>
      {cover}
      <span className="min-w-0 flex-1 truncate pr-2 text-sm font-semibold">{title}</span>
    </>
  )
  return (
    <li>
      {to ? (
        <Link to={to} className={className}>
          {content}
        </Link>
      ) : (
        <button type="button" onClick={onPlay} className={className}>
          {content}
        </button>
      )}
    </li>
  )
}
