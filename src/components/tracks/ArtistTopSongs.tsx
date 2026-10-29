import { ChevronRight } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { artistTopSongs, type ArtistTop } from '../../data/artistTop'
import type { YtmCard } from '../../data/ytmusic'
import type { Track } from '../../player/types'
import { Cover } from '../ui/Cover'
import { SkeletonRows } from '../ui/Skeleton'
import { TrackList } from './TrackList'

const MAX_ARTISTS = 8

type OnPlay = (artist: YtmCard, track: Track) => void

/**
 * «Tus artistas»: por cada artista, su nombre como cabecera (con una foto pequeña; abre su página) y sus canciones más
 * conocidas, cada una con carátula, título y ▶ (solo ▶: sin gestos ni menú de cola). Los artistas van en una fila que
 * se desliza de lado.
 */
export function ArtistTopSongsRow({ artists, onPlay }: { artists: readonly YtmCard[]; onPlay: OnPlay }) {
  return (
    <div className="sin-scroll flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-2 md:px-6">
      {artists.slice(0, MAX_ARTISTS).map((artist) => (
        <ArtistTopSongs key={artist.id} artist={artist} onPlay={onPlay} />
      ))}
    </div>
  )
}

function ArtistTopSongs({ artist, onPlay }: { artist: YtmCard; onPlay: OnPlay }) {
  const [top, setTop] = useState<ArtistTop | null>(null)
  const { id, title } = artist

  useEffect(() => {
    let alive = true
    void artistTopSongs({ ...artist, id, title }).then((result) => alive && setTop(result))
    return () => {
      alive = false
    }
    // Solo cuando cambia el artista (la tarjeta llega como objeto nuevo en cada cálculo de «Para ti»).
  }, [id, title])

  return (
    <article aria-label={title} className="w-[85%] max-w-sm shrink-0 snap-start rounded-lg bg-tarjeta/60 py-3 md:w-96">
      <Link to={`/ytm/${encodeURIComponent(id)}`} className="flex items-center gap-3 px-4 hover:underline">
        <Cover seed={id} src={artist.image} className="size-10 shrink-0 rounded-full" />
        <h3 className="min-w-0 flex-1 truncate text-lg font-bold">{title}</h3>
        <ChevronRight className="size-5 shrink-0 text-texto-sec" aria-hidden="true" />
      </Link>
      {top === null && <SkeletonRows rows={3} label="Cargando sus canciones…" className="mt-1" />}
      {top && top.tracks.length > 0 && <TrackList tracks={top.tracks} numbered={false} plain onPlay={(i) => onPlay(artist, top.tracks[i])} />}
      {top?.notice && <p className="px-4 pt-2 text-xs text-texto-sec">{top.notice}</p>}
    </article>
  )
}
