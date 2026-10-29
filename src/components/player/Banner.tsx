import { Heart, LoaderCircle, Pause, Play } from 'lucide-react'
import { useLayoutEffect, useRef, useSyncExternalStore } from 'react'
import { useLibrary } from '../../library/store'
import { player } from '../../player/engine'
import { sheetState } from '../../player/stage'
import { useNowPlaying } from '../../player/useNowPlaying'
import { usePlaybackTime, usePlayer } from '../../player/usePlayer'
import { toggleFavorite, vibrate } from '../tracks/trackActions'
import { Backdrop } from './Backdrop'
import { BarCarousel } from './BarCarousel'

/**
 * Barra del reproductor en el celular, como la de Spotify (sin video): carátula, título, artista,
 * favorito, reproducir/pausar y una línea de progreso azul. SOLO aparece al minimizar «Sonando ahora»
 * (o al abrir la app con una canción guardada). Gestos: izquierda = siguiente, derecha = anterior,
 * arriba o tocar = abrir «Sonando ahora».
 */
export function Banner() {
  const { current, status, duration } = usePlayer()
  const { favorites } = useLibrary()
  const sheet = useSyncExternalStore(sheetState.subscribe, sheetState.get)
  const { open } = useNowPlaying()
  const bannerRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const banner = bannerRef.current
    if (!banner || !current || sheet !== 'closed') return
    const updateHeight = () => document.documentElement.style.setProperty('--mobile-player-banner-h', `${banner.offsetHeight + 4}px`)
    updateHeight()
    const observer = new ResizeObserver(updateHeight)
    observer.observe(banner)
    return () => {
      observer.disconnect()
      document.documentElement.style.removeProperty('--mobile-player-banner-h')
    }
  }, [current?.id, sheet])

  if (!current || sheet !== 'closed') return null

  const playing = status === 'playing'
  const busy = status === 'loading' || status === 'buffering'
  const liked = favorites.some((t) => t.id === current.id)

  return (
    // siempre-oscuro: va sobre la carátula difuminada, también con el tema claro.
    <div ref={bannerRef} className="siempre-oscuro fixed right-2 bottom-[calc(var(--nav-h,70px)+4px)] left-2 z-40 overflow-hidden rounded-lg bg-elevado text-white lg:hidden">
      <Backdrop track={current} variant="barra" />
      <div className="relative flex items-center gap-1 py-2 pr-1 pl-2">
        <BarCarousel onOpen={open} showCover className="h-10 flex-1" />
        <button
          type="button"
          aria-label={liked ? 'Quitar de favoritos' : 'Agregar a favoritos'}
          aria-pressed={liked}
          onClick={() => toggleFavorite(current)}
          className={`grid size-10 shrink-0 place-items-center rounded-full ${liked ? 'text-acento' : 'text-white'}`}
        >
          <Heart className={`size-5 ${liked ? 'fill-current' : ''}`} />
        </button>
        <button
          type="button"
          aria-label={playing || busy ? 'Pausar' : 'Reproducir'}
          onClick={() => {
            vibrate() // vibración corta al dar ▶ o ⏸ (si el teléfono la tiene)
            player.toggle()
          }}
          className="grid size-10 shrink-0 place-items-center rounded-full text-white"
        >
          {busy ? <LoaderCircle className="size-6 animate-spin" /> : playing ? <Pause className="size-6 fill-current" /> : <Play className="size-6 fill-current" />}
        </button>
      </div>
      <ProgressLine duration={duration} />
    </div>
  )
}

/** La línea de progreso, aparte: se redibuja 4 veces por segundo sin redibujar toda la barra. */
function ProgressLine({ duration }: { duration: number }) {
  const time = usePlaybackTime()
  const progress = duration > 0 ? Math.min(100, (time / duration) * 100) : 0
  return (
    <div className="relative h-0.5 bg-contraste/15" aria-hidden="true">
      <div className="h-full bg-acento" style={{ width: `${progress}%` }} />
    </div>
  )
}
