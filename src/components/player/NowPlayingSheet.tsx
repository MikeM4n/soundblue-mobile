import { ChevronDown, ChevronUp, Heart } from 'lucide-react'
import { useEffect, useRef, useState, useSyncExternalStore, type PointerEvent } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { lyricsOf, type Lyrics } from '../../data/lyrics'
import { useLibrary } from '../../library/store'
import { useSettings } from '../../lib/settings'
import { usePreventTouchMove } from '../../lib/usePreventTouchMove'
import { player } from '../../player/engine'
import { sheetState, stagePulse, youtubeView, type YouTubeView } from '../../player/stage'
import { coverSources, type Track } from '../../player/types'
import { usePlaybackTime, usePlayer } from '../../player/usePlayer'
import { TrackMenu } from '../tracks/TrackMenu'
import { toggleFavorite } from '../tracks/trackActions'
import { Cover } from '../ui/Cover'
import { IconButton } from '../ui/IconButton'
import { CoverSwipe } from './CoverSwipe'
import { QueuePanel } from './QueuePanel'
import { QueueSections } from '../tracks/QueueSections'
import { SeekBar } from './SeekBar'
import { TransportControls } from './TransportControls'

const SLIDE_MS = 300
const INTERACTIVE = 'button, a, input, [role="menu"], [data-queue-panel], [data-queue-desktop], [data-lyrics]'

/**
 * «Sonando ahora» en pantalla completa, como Spotify. Sube deslizándose al tocar una canción.
 * Fondo: la imagen de la canción en alta resolución, muy difuminada y oscurecida. Al centro: la carátula nítida o, con
 * «Letra», la letra tipo karaoke (la línea que se canta resaltada). El audio se reproduce en un elemento HTML oculto.
 * Debajo: título, artista, favorito, progreso y controles, siempre a la vista: tocar la carátula o el fondo no hace nada.
 * Gestos: hacia abajo = minimizar (si el panel de la cola está cerrado) · hacia arriba = «Próximas en sonar».
 */
export function NowPlayingSheet() {
  const { current, contextName, error } = usePlayer()
  const { favorites } = useLibrary()
  const navigate = useNavigate()
  const location = useLocation()
  const view = useSyncExternalStore(youtubeView.subscribe, youtubeView.get)
  const { hideViewToggle } = useSettings() // Ajustes: ocultar «Canción | Letra»
  const [shown, setShown] = useState(false) // para la animación de entrada
  const [closing, setClosing] = useState(false)
  const [dragY, setDragY] = useState<number | null>(null)
  const [queueOpen, setQueueOpen] = useState(false)
  const [desktopLayout, setDesktopLayout] = useState(() => window.matchMedia('(min-width: 1024px)').matches)
  const drag = useRef<{ pointerId: number; startY: number; startX: number; axis: 'x' | 'y' | null; dy: number } | null>(null)
  const closeTimer = useRef<number | undefined>(undefined)
  const rootRef = useRef<HTMLDivElement>(null)
  usePreventTouchMove(rootRef, () => drag.current?.axis === 'y')

  useEffect(() => {
    const media = window.matchMedia('(min-width: 1024px)')
    const update = () => setDesktopLayout(media.matches)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  // Entrada: empieza abajo y sube.
  useEffect(() => {
    sheetState.set('open')
    const frame = requestAnimationFrame(() => requestAnimationFrame(() => setShown(true)))
    stagePulse.emit()
    return () => {
      cancelAnimationFrame(frame)
      // Si mientras bajaba ya fuiste a otra pantalla, no se vuelve atrás (te sacaría de donde estás).
      window.clearTimeout(closeTimer.current)
      sheetState.set('closed')
    }
  }, [])

  const close = () => {
    if (closing) return
    setClosing(true)
    sheetState.set('closing')
    stagePulse.emit()
    closeTimer.current = window.setTimeout(() => {
      const background = (location.state as { background?: unknown } | null)?.background
      if (background) navigate(-1)
      else navigate('/', { replace: true })
    }, SLIDE_MS)
  }

  // En el PC, Esc minimiza (o cierra «Próximas en sonar» si está abierta). Si Esc ya cerró un menú, no hace nada más.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      if (queueOpen) setQueueOpen(false)
      else close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // Deslizar: hacia abajo minimiza; hacia arriba abre «Próximas en sonar». La dirección dominante decide.
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (queueOpen || (e.target as Element).closest(INTERACTIVE)) return
    drag.current = { pointerId: e.pointerId, startY: e.clientY, startX: e.clientX, axis: null, dy: 0 }
  }
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d || e.pointerId !== d.pointerId) return
    const dy = e.clientY - d.startY
    const dx = e.clientX - d.startX
    if (!d.axis) {
      if (Math.abs(dy) < 8 && Math.abs(dx) < 8) return
      d.axis = Math.abs(dy) > Math.abs(dx) ? 'y' : 'x'
      if (d.axis === 'y') e.currentTarget.setPointerCapture(e.pointerId)
    }
    if (d.axis !== 'y') return
    d.dy = dy
    if (dy > 0) {
      setDragY(dy) // la pantalla sigue al dedo hacia abajo
      stagePulse.emit() // y el video con ella
    }
  }
  const onPointerUp = () => {
    const d = drag.current
    drag.current = null
    if (!d || d.axis !== 'y') return
    setDragY(null)
    if (d.dy > window.innerHeight * 0.18) close()
    else if (d.dy < -60) setQueueOpen(true)
    else stagePulse.emit()
  }

  if (!current) {
    return (
      <div className="fixed inset-x-0 top-0 z-40 grid h-dvh w-full place-items-center bg-black p-8 pb-[70px] text-center lg:right-0 lg:bottom-0 lg:left-[236px] lg:h-auto lg:w-auto lg:pb-8 lg:z-50">
        <div>
          <p className="text-lg font-semibold">No hay nada sonando</p>
          <button type="button" onClick={close} className="mt-2 text-acento-texto hover:underline">
            Volver
          </button>
        </div>
      </div>
    )
  }

  const showLyrics = view === 'letra'
  const liked = favorites.some((t) => t.id === current.id)
  const panelTop = Math.round(window.innerHeight * 0.12) // hasta dónde sube el panel de la cola
  const offset = !shown || closing ? '100%' : `${dragY ?? 0}px`

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-label="Sonando ahora"
      // En celular cubre toda la pantalla; en PC deja sitio para la barra lateral.
      // siempre-oscuro: va sobre la carátula difuminada, también con el tema claro.
      className="siempre-oscuro fixed inset-x-0 top-0 z-40 h-dvh w-full touch-none overflow-hidden overscroll-contain bg-black pb-[70px] text-white select-none lg:right-0 lg:bottom-0 lg:left-[236px] lg:h-auto lg:w-auto lg:pb-0 lg:z-50 lg:touch-auto"
      style={{ transform: `translateY(${offset})`, transition: dragY === null ? `transform ${SLIDE_MS}ms cubic-bezier(.2,.8,.2,1)` : 'none' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      {/* Tres partes: encabezado arriba, controles abajo con ALTO FIJO (título en 2 líneas como máximo) y, en medio,
          el espacio que sobra para la carátula o el video, centrados. Nada entra ni sale del flujo al deslizar o al
          cambiar de canción, así que el conjunto no salta y nunca hay scroll. */}
      <div className="relative mx-auto grid h-full w-full max-w-[1600px] grid-cols-1 lg:grid-cols-[minmax(0,3fr)_minmax(280px,2fr)]">
      <section aria-label="Reproductor" className="relative flex min-h-0 min-w-0 flex-col pt-[env(safe-area-inset-top)] pb-2 lg:pr-4">
        {/* Tres columnas, las de los lados del mismo ancho: el centro queda siempre al centro de la pantalla, sin
            importar los botones. Izquierda: minimizar (también deslizar hacia abajo o, en el PC, la tecla Esc); centro:
            «Canción | Letra» (en el PC, debajo de dónde suena); derecha: ⋮. El selector va aquí arriba para que la
            letra tenga todo el alto del centro. */}
        <header className="grid w-full shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-2 p-4 lg:px-2 lg:py-2">
          <div className="justify-self-start">
            <IconButton label="Minimizar reproductor" onClick={close} className="text-white">
              <ChevronDown className="size-6" aria-hidden="true" />
            </IconButton>
          </div>
          <div className="flex flex-col items-center gap-1">
            <div className="hidden max-w-64 text-center lg:block">
              <p className="text-[11px] font-semibold tracking-wider text-white/70 uppercase">Sonando desde</p>
              <p className="truncate text-sm font-bold">{contextName ?? 'Tu música'}</p>
            </div>
            {!hideViewToggle && <ViewToggle view={view} />}
          </div>
          <div className="justify-self-end">
            <TrackMenu track={current} />
          </div>
        </header>

        {/* Centro: la carátula nítida (como Spotify y YouTube Music) o, si eliges «Letra», el karaoke con todo el alto. */}
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3">
          {showLyrics ? (
            <LyricsPanel track={current} />
          ) : (
            // La carátula mide lo que quepa: 82 % del ancho, máx. 26 rem, y nunca más que el alto libre (100cqh).
            <div className="grid min-h-0 w-full flex-1 place-items-center [container-type:size]">
              {/* Deslizar la carátula: izquierda = siguiente, derecha = anterior (o reiniciar si lleva más de 3 s). */}
              <CoverSwipe className="w-[min(70vw,280px,100cqh)] lg:w-[min(82vw,26rem,100cqh)]">
                <Cover seed={current.id} src={coverSources(current, 'large')} eager className="aspect-square w-full rounded-lg shadow-2xl shadow-black/60" />
              </CoverSwipe>
            </div>
          )}
        </div>
        {/* Abajo, alto fijo: aviso de segundo plano, título, artista, progreso, controles y la pista de la cola. */}
        <div className="shrink-0">
          <TrackInfo track={current} liked={liked} error={error} />
          <div className="lg:hidden"><QueueHint onOpen={() => setQueueOpen(true)} /></div>
        </div>
      </section>

      <aside data-queue-desktop aria-label="Próximas en sonar" className="queue-pure-black relative z-10 hidden min-h-0 min-w-0 flex-col border-l border-white/10 bg-black px-4 pt-[calc(env(safe-area-inset-top)+1.25rem)] text-white lg:flex">
        <h2 className="shrink-0 text-xl font-bold">Próximas en sonar</h2>
        <div className="queue-pure-black scroll-fino mt-2 min-h-0 flex-1 touch-pan-y overflow-y-auto overscroll-contain pb-8">
          {desktopLayout && <QueueSections />}
        </div>
      </aside>

      <div className="contents lg:hidden"><QueuePanel open={queueOpen} top={panelTop} onClose={() => setQueueOpen(false)} /></div>
      </div>
    </div>
  )
}

/**
 * Aviso sobre reproducción de audio en segundo plano.
 */
const LYRICS_LEAD_S = 0.3 // la línea se resalta un poco antes de cantarse (como en Spotify)
const USER_SCROLL_MS = 4000 // si desplazas la letra con el dedo, deja de seguir la canción por 4 s

/**
 * Letra tipo karaoke (data/lyrics.ts): con tiempos, la línea que se canta va resaltada y la lista se desplaza sola para
 * dejarla a la vista; tocar una línea lleva la canción a ese momento. Sin tiempos, el texto completo. Se desplaza con el
 * dedo (no minimiza «Sonando ahora») y muestra su fuente, como pide quien la licencia.
 */
function LyricsPanel({ track }: { track: Track }) {
  const { duration } = usePlayer()
  const time = usePlaybackTime() // 4 veces por segundo mientras suena: la línea resaltada va al ritmo de la canción
  const [found, setFound] = useState<{ id: string; lyrics: Lyrics | null | 'error' } | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const userScrollUntil = useRef(0)
  useEffect(() => {
    let alive = true
    lyricsOf(track, duration)
      .then((lyrics) => alive && setFound({ id: track.id, lyrics }))
      .catch(() => alive && setFound({ id: track.id, lyrics: 'error' }))
    return () => {
      alive = false
    }
  }, [track]) // sin `duration`: solo ayuda a elegir la versión; cambiarla no vuelve a buscar
  const lyrics = found?.id === track.id ? found.lyrics : undefined
  const lines = lyrics && lyrics !== 'error' ? lyrics.lines : null
  // Las líneas vienen en orden: la que se canta es la última que ya empezó.
  const active = lines ? lines.filter((line) => line.time <= time + LYRICS_LEAD_S).length - 1 : -1

  // La línea que se canta queda a un tercio de la altura (salvo que estés desplazando la letra con el dedo).
  useEffect(() => {
    const list = listRef.current
    const line = list?.querySelector<HTMLElement>(`[data-line="${active}"]`)
    if (!list || !line || Date.now() < userScrollUntil.current) return
    list.scrollTo({ top: line.offsetTop - list.clientHeight * 0.33, behavior: 'smooth' })
  }, [active])
  const userScrolls = () => {
    userScrollUntil.current = Date.now() + USER_SCROLL_MS
  }

  return (
    <div
      ref={listRef}
      data-lyrics
      aria-label="Letra"
      onTouchStart={userScrolls}
      onWheel={userScrolls}
      // Se desvanece arriba y abajo: las líneas no se cortan de golpe.
      className="scroll-fino relative min-h-0 w-full flex-1 touch-pan-y overflow-y-auto overscroll-contain px-6 pt-6 pb-10 [mask-image:linear-gradient(to_bottom,transparent,black_24px,black_calc(100%-48px),transparent)]"
    >
      {lyrics === undefined ? (
        <p className="text-center text-sm text-white/60">Buscando la letra…</p>
      ) : lyrics === 'error' ? (
        <p className="text-center text-sm text-white/60">No se pudo cargar la letra. Revisa tu conexión.</p>
      ) : lyrics === null ? (
        <p className="text-center text-sm text-white/60">No encontramos la letra de esta canción.</p>
      ) : lines ? (
        <>
          {lines.map((line, i) => (
            <button
              key={`${i}-${line.time}`}
              type="button"
              data-line={i}
              data-time={line.time}
              aria-current={i === active ? 'true' : undefined}
              onClick={() => player.seek(line.time)}
              className={`block w-full origin-left py-1.5 text-left text-2xl leading-snug font-extrabold transition-all duration-300 ${
                i === active ? 'scale-[1.03] text-white' : i < active ? 'text-white/40' : 'text-white/65'
              }`}
            >
              {line.text || '♪'}
            </button>
          ))}
          {lyrics.source && <p className="mt-6 text-xs text-white/50">{lyrics.source}</p>}
        </>
      ) : (
        <>
          <p className="mb-3 text-xs text-white/50">Esta letra no tiene tiempos: no se puede seguir al ritmo.</p>
          <p className="text-xl leading-relaxed font-bold whitespace-pre-line text-white/90">{lyrics.text}</p>
          {lyrics.source && <p className="mt-6 text-xs text-white/50">{lyrics.source}</p>}
        </>
      )}
    </div>
  )
}

/** «Canción | Letra»: la carátula o la letra tipo karaoke. La música sigue igual al cambiar. */
function ViewToggle({ view }: { view: YouTubeView }) {
  const options: [YouTubeView, string][] = [
    ['cancion', 'Canción'],
    ['letra', 'Letra'],
  ]
  return (
    <div role="group" aria-label="Qué ver" className="flex h-8 shrink-0 rounded-full bg-black/40 p-0.5 text-[13px] font-semibold">
      {options.map(([value, label]) => (
        <button
          key={value}
          type="button"
          aria-pressed={view === value}
          onClick={() => youtubeView.set(value)}
          className={`rounded-full px-3 transition-colors ${view === value ? 'bg-white text-black' : 'text-white/80 hover:text-white'}`}
        >
          {label}
        </button>
      ))}
    </div>
  )
}

/**
 * Título (máx. 2 líneas, alto reservado para 2), artista, álbum o aviso de error (siempre una línea), favorito,
 * barra de progreso y controles. Su alto no cambia entre canciones.
 */
function TrackInfo({ track, liked, error }: { track: Track; liked: boolean; error: string | null }) {
  return (
    <div className="px-6 pt-2 lg:px-10">
      <div className="flex items-end gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex h-[3.5rem] items-end">
            <h1 className="line-clamp-2 text-2xl leading-7 font-bold break-words">{track.title}</h1>
          </div>
          <p className="truncate text-texto-sec">{track.artist}</p>
          {error ? (
            <p role="alert" className="truncate text-xs text-red-300">
              {error}
            </p>
          ) : (
            <p className="h-4 truncate text-xs text-white/50">{track.album}</p>
          )}
        </div>
        <IconButton label={liked ? 'Quitar de favoritos' : 'Agregar a favoritos'} active={liked} onClick={() => toggleFavorite(track)} className={liked ? '' : 'text-white'}>
          <Heart className={`size-7 ${liked ? 'fill-current' : ''}`} />
        </IconButton>
      </div>
      <div className="mt-3">
        <SeekBar />
      </div>
      <div className="mt-2 flex justify-center">
        <TransportControls large />
      </div>
    </div>
  )
}

/** Pista del gesto para abrir la cola (también se puede tocar, para quien no usa gestos). */
function QueueHint({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="mx-auto mt-3 flex items-center gap-1 text-xs font-semibold tracking-wide text-white/60 uppercase"
    >
      <ChevronUp className="size-4" aria-hidden="true" />
      Desliza hacia arriba: próximas en sonar
    </button>
  )
}
