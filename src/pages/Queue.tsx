import { ChevronLeft } from 'lucide-react'
import { Link, useNavigate } from 'react-router'
import { QueueSections, SectionTitle } from '../components/tracks/QueueSections'
import { TrackRow } from '../components/tracks/TrackRow'
import { IconButton } from '../components/ui/IconButton'
import { useNowPlaying } from '../player/useNowPlaying'
import { usePlayer } from '../player/usePlayer'

/** «Próximas en sonar» como página (desde el PC). En el celular está en «Sonando ahora», deslizando hacia arriba. */
export function Queue() {
  const { current, status } = usePlayer()
  const navigate = useNavigate()
  const { open } = useNowPlaying()
  const playing = status === 'playing' || status === 'buffering' || status === 'loading'

  return (
    <div className="px-2 pt-4 pb-10 md:px-4">
      <header className="flex items-center gap-1">
        <IconButton label="Volver" onClick={() => navigate(-1)}>
          <ChevronLeft className="size-6" />
        </IconButton>
        <h1 className="text-xl font-bold md:text-2xl">Próximas en sonar</h1>
      </header>

      {!current ? (
        <p className="mt-10 px-2 text-center text-texto-sec">
          No hay nada sonando.{' '}
          <Link to="/" className="text-acento-texto hover:underline">
            Elige algo en Inicio
          </Link>
        </p>
      ) : (
        <>
          <SectionTitle>Sonando ahora</SectionTitle>
          <ol>
            <TrackRow track={current} isCurrent isPlaying={playing} onPlay={open} swipe="cola" />
          </ol>
          <QueueSections beforePlay={open} />
        </>
      )}
    </div>
  )
}
