import { Check, Search as SearchIcon, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { starterArtists } from '../../data/tastes'
import { ytmSearchArtists, ytmSimilarArtists, type YtmCard } from '../../data/ytmusic'
import { sizedArtwork } from '../../player/types'
import { Cover } from '../ui/Cover'

/**
 * Elegir artistas (la pantalla «¿Qué artistas te gustan?» y el primer paso de la bienvenida): buscador y artistas
 * populares; al elegir uno aparecen al lado otros parecidos, como en YouTube Music. Tocarlo otra vez lo quita.
 */
export function ArtistPicker({ selected, onChange }: { selected: readonly YtmCard[]; onChange: (artists: YtmCard[]) => void }) {
  const [artists, setArtists] = useState<YtmCard[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<{ query: string; artists: YtmCard[] } | null>(null)
  const expanded = useRef(new Set<string>()) // artistas cuyos parecidos ya se agregaron
  const initial = useRef(selected) // los que ya habías elegido van primero

  useEffect(() => {
    let alive = true
    starterArtists()
      .then((list) => alive && setArtists(withoutRepeats([...initial.current, ...list])))
      .catch(() => alive && setFailed(true))
    return () => {
      alive = false
    }
  }, [])

  // Buscar cualquier artista (espera a que dejes de escribir).
  useEffect(() => {
    const q = query.trim()
    if (!q) return
    let alive = true
    const timer = window.setTimeout(() => {
      ytmSearchArtists(q)
        .then((found) => alive && setResults({ query: q, artists: found.slice(0, 12) }))
        .catch(() => alive && setResults({ query: q, artists: [] }))
    }, 400)
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [query])

  const isOn = (card: YtmCard) => selected.some((artist) => artist.id === card.id)

  const toggle = (card: YtmCard) => {
    if (isOn(card)) {
      onChange(selected.filter((artist) => artist.id !== card.id))
      return
    }
    onChange([...selected, card])
    setArtists((list) => (list && !list.some((artist) => artist.id === card.id) ? [card, ...list] : list)) // si vino de la búsqueda
    if (expanded.current.has(card.id)) return
    expanded.current.add(card.id)
    ytmSimilarArtists(card.id)
      .then((similar) =>
        setArtists((list) => {
          if (!list) return list
          const present = new Set(list.map((artist) => artist.id))
          const extra = similar.filter((artist) => !present.has(artist.id)).slice(0, 4)
          const at = list.findIndex((artist) => artist.id === card.id)
          return [...list.slice(0, at + 1), ...extra, ...list.slice(at + 1)]
        }),
      )
      .catch(() => {})
  }

  const q = query.trim()
  const shown = q ? (results?.query === q ? results.artists : null) : artists

  return (
    <>
      <label className="relative mt-5 block max-w-xl">
        <span className="sr-only">Buscar un artista</span>
        <SearchIcon className="pointer-events-none absolute top-1/2 left-4 size-5 -translate-y-1/2 text-texto-sec" aria-hidden="true" />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Busca un artista"
          enterKeyHint="search"
          className="h-12 w-full rounded-full bg-tarjeta pr-11 pl-12 text-texto ring-1 ring-contraste/10 outline-none placeholder:text-texto-sec focus:ring-2 focus:ring-acento [&::-webkit-search-cancel-button]:hidden"
        />
        {query && (
          <button
            type="button"
            aria-label="Borrar búsqueda"
            onClick={() => setQuery('')}
            className="absolute top-1/2 right-3 grid size-7 -translate-y-1/2 place-items-center rounded-full text-texto-sec hover:text-texto"
          >
            <X className="size-4" />
          </button>
        )}
      </label>

      {failed && !q && <p className="mt-8 text-texto-sec">No se pudo conectar con el catálogo. Puedes omitir este paso y elegir después.</p>}
      {!shown && !failed && <p className="mt-8 text-texto-sec">{q ? 'Buscando…' : 'Cargando artistas…'}</p>}
      {shown && shown.length === 0 && <p className="mt-8 text-texto-sec">No encontramos «{q}».</p>}
      {shown && shown.length > 0 && (
        <ul className="mt-6 grid grid-cols-3 gap-x-3 gap-y-5 sm:grid-cols-4 lg:grid-cols-6" aria-label={q ? 'Resultados' : 'Artistas'}>
          {shown.map((card) => {
            const on = isOn(card)
            return (
              <li key={card.id}>
                <button type="button" aria-pressed={on} onClick={() => toggle(card)} className="group w-full text-center">
                  <span className="relative block">
                    <Cover
                      seed={card.id}
                      // Más nítida a 226 px; si Google no la da en ese tamaño (a veces responde 429), la original.
                      src={card.image ? [sizedArtwork(card.image, 226), card.image] : undefined}
                      className={`aspect-square w-full rounded-full transition ${on ? 'ring-4 ring-acento' : 'group-hover:opacity-90'}`}
                    />
                    {on && (
                      <span className="absolute right-0 bottom-0 grid size-8 place-items-center rounded-full bg-acento text-white shadow-lg" aria-hidden="true">
                        <Check className="size-5" />
                      </span>
                    )}
                  </span>
                  <span className="mt-2 block truncate text-sm font-semibold">{card.title}</span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </>
  )
}

function withoutRepeats(list: YtmCard[]): YtmCard[] {
  const seen = new Set<string>()
  return list.filter((card) => !seen.has(card.id) && !!seen.add(card.id))
}
