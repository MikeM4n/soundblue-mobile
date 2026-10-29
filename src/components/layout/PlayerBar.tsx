import { ListMusic, Maximize2 } from 'lucide-react'
import { useLocation, useNavigate } from 'react-router'
import { useNowPlaying } from '../../player/useNowPlaying'
import { usePlayer } from '../../player/usePlayer'
import { coverSources } from '../../player/types'
import { SeekBar } from '../player/SeekBar'
import { TransportControls } from '../player/TransportControls'
import { VolumeControl } from '../player/VolumeControl'
import { IconButton } from '../ui/IconButton'
import { Cover } from '../ui/Cover'

/** Reproductor fijo de escritorio: lo que suena, controles y volumen. */
export function PlayerBar() {
  return (
    <footer aria-label="Reproductor" className="hidden h-20 shrink-0 grid-cols-[minmax(0,1.2fr)_minmax(0,1.6fr)_minmax(0,1.2fr)] items-center gap-4 px-2 lg:grid">
      <MiniPlayer />
      <div className="flex flex-col items-center gap-1">
        <TransportControls showFavorite />
        <SeekBar className="max-w-xl" />
      </div>
      <ExtraControls />
    </footer>
  )
}

function MiniPlayer() {
  const { current } = usePlayer()
  const { open } = useNowPlaying()
  if (!current) return <div aria-hidden="true" />

  return (
    <button
      type="button"
      aria-label={`Abrir reproducción: ${current.title} — ${current.artist}`}
      onClick={open}
      className="flex w-full min-w-0 items-center gap-3 overflow-hidden rounded-md text-left transition-all duration-200 hover:scale-[1.02] hover:bg-[#2a2a2a] active:scale-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-acento"
    >
      <Cover seed={current.id} src={coverSources(current)} eager className="size-12 shrink-0 rounded object-cover" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate whitespace-nowrap text-sm font-semibold text-white" title={current.title}>{current.title}</span>
        <span className="truncate whitespace-nowrap text-xs text-[#b3b3b3]" title={current.artist}>{current.artist}</span>
      </span>
    </button>
  )
}

function ExtraControls() {
  const { current } = usePlayer()
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const { open } = useNowPlaying()

  return (
    <div className="flex items-center justify-end gap-1">
      <IconButton label="Próximas en sonar" active={pathname === '/cola'} disabled={!current} onClick={() => navigate('/cola')}>
        <ListMusic className="size-4" />
      </IconButton>
      <IconButton label="Sonando ahora en pantalla completa" disabled={!current} onClick={open}>
        <Maximize2 className="size-4" />
      </IconButton>
      <VolumeControl />
    </div>
  )
}
