import { EllipsisVertical, Heart, ListEnd, ListPlus, ListStart, ListX, Play, Radio, Share2, Trash } from 'lucide-react'
import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { shareTrack } from '../../lib/share'
import { useLibrary } from '../../library/store'
import { player } from '../../player/engine'
import { stageBox } from '../../player/stage'
import type { Track } from '../../player/types'
import { useNowPlaying } from '../../player/useNowPlaying'
import { usePlayer } from '../../player/usePlayer'
import { PlaylistDialog } from './PlaylistDialog'
import { addToSiguientes, playNext, removeFromQueue, removeWithUndo, startRadio, toggleFavorite, type RemoveAction } from './trackActions'

interface TrackMenuProps {
  track: Track
  removeAction?: RemoveAction // «Eliminar de …» cuando la lista lo permite
  onPlay?: () => void // «Reproducir» (en las filas de las listas)
}

interface TrackMenuControl {
  open?: boolean // abierto desde fuera (deslizar a la derecha una fila de Buscar o de una lista)
  onOpenChange?: (open: boolean) => void
}

/**
 * Botón «⋮» con las acciones de una canción.
 */
export function TrackMenu({ track, removeAction, onPlay, open: openProp, onOpenChange }: TrackMenuProps & TrackMenuControl) {
  const [openState, setOpenState] = useState(false)
  const open = openProp ?? openState
  const setOpen = onOpenChange ?? setOpenState
  const [choosingPlaylist, setChoosingPlaylist] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-label={`Más opciones para ${track.title}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="grid size-10 shrink-0 place-items-center rounded-full text-texto-sec hover:text-texto"
      >
        <EllipsisVertical className="size-5" />
      </button>
      {open && (
        <MenuPopover
          anchor={buttonRef.current}
          track={track}
          removeAction={removeAction}
          onPlay={onPlay}
          onClose={() => {
            setOpen(false)
            buttonRef.current?.focus()
          }}
          onChoosePlaylist={() => {
            setOpen(false)
            setChoosingPlaylist(true)
          }}
        />
      )}
      {choosingPlaylist && <PlaylistDialog track={track} onClose={() => setChoosingPlaylist(false)} />}
    </>
  )
}

interface MenuPopoverProps extends TrackMenuProps {
  anchor: HTMLElement | null
  onClose: () => void
  onChoosePlaylist: () => void
}

function MenuPopover({ anchor, track, removeAction, onPlay, onClose, onChoosePlaylist }: MenuPopoverProps) {
  const menuRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null)
  const { favorites } = useLibrary()
  const { open } = useNowPlaying()
  usePlayer() // para saber al momento si está en la cola
  const liked = favorites.some((t) => t.id === track.id)
  const queued = player.isQueued(track.id)

  // Se abre debajo del botón, o encima si no cabe; dentro de la pantalla y nunca sobre el video.
  useLayoutEffect(() => {
    const menu = menuRef.current
    if (!anchor || !menu) return
    const a = anchor.getBoundingClientRect()
    const { width, height } = menu.getBoundingClientRect()
    const maxTop = window.innerHeight - height - 8
    const left = Math.min(Math.max(8, a.right - width), window.innerWidth - width - 8)
    let top = a.bottom + 4 > maxTop ? a.top - height - 4 : a.bottom + 4
    const video = stageBox.get()
    if (video && left < video.left + video.width && left + width > video.left && top < video.top + video.height && top + height > video.top) {
      // El video abajo (barra) → el menú va encima; el video arriba → el menú va debajo.
      top = video.top > window.innerHeight / 2 ? video.top - height - 8 : video.top + video.height + 8
    }
    setPosition({ top: Math.min(Math.max(8, top), maxTop), left })
    menu.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
  }, [anchor])

  // Cerrar al tocar fuera.
  useLayoutEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node) && !anchor?.contains(e.target as Node)) onClose()
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [anchor, onClose])

  const run = (action: () => void) => () => {
    action()
    onClose()
  }

  // Teclado: flechas para moverse, Escape para cerrar.
  const onKeyDown = (e: KeyboardEvent) => {
    const items = [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]
    const index = items.indexOf(document.activeElement as HTMLElement)
    if (e.key === 'ArrowDown') items[(index + 1) % items.length]?.focus()
    else if (e.key === 'ArrowUp') items[(index - 1 + items.length) % items.length]?.focus()
    else if (e.key === 'Escape' || e.key === 'Tab') onClose()
    else return
    e.preventDefault()
  }

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label={`Opciones para ${track.title}`}
      onKeyDown={onKeyDown}
      className="fixed z-40 lg:z-[60] w-64 rounded-lg bg-tarjeta-claro p-1 shadow-2xl shadow-black/60 ring-1 ring-contraste/10"
      style={position ?? { top: -9999, left: -9999 }}
    >
      {onPlay && (
        <MenuItem icon={<Play className="size-4" />} onSelect={run(onPlay)}>
          Reproducir
        </MenuItem>
      )}
      <MenuItem icon={<ListStart className="size-4" />} onSelect={run(() => playNext(track))}>
        Reproducir a continuación
      </MenuItem>
      <MenuItem icon={<ListEnd className="size-4" />} onSelect={run(() => addToSiguientes(track))}>
        Agregar a la cola
      </MenuItem>
      {queued && (
        <MenuItem icon={<ListX className="size-4" />} onSelect={run(() => removeFromQueue(track))}>
          Quitar de la cola
        </MenuItem>
      )}
      <MenuItem icon={<Radio className="size-4" />} onSelect={run(() => startRadio(track, open))}>
        Iniciar radio
      </MenuItem>
      <MenuItem icon={<ListPlus className="size-4" />} onSelect={onChoosePlaylist}>
        Agregar a playlist
      </MenuItem>
      <MenuItem icon={<Heart className={`size-4 ${liked ? 'fill-current' : ''}`} />} onSelect={run(() => toggleFavorite(track))}>
        {liked ? 'Quitar de Tus me gusta' : 'Me gusta'}
      </MenuItem>
      <MenuItem icon={<Share2 className="size-4" />} onSelect={run(() => void shareTrack(track))}>
        Compartir
      </MenuItem>
      {removeAction && (
        <MenuItem icon={<Trash className="size-4" />} onSelect={run(() => removeWithUndo(removeAction))}>
          Eliminar de {removeAction.listName}
        </MenuItem>
      )}
    </div>,
    document.body,
  )
}

function MenuItem({ icon, children, onSelect }: { icon: ReactNode; children: ReactNode; onSelect: () => void }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onSelect}
      className="flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left text-sm text-texto outline-none hover:bg-contraste/10 focus-visible:bg-contraste/10"
    >
      <span className="text-texto-sec" aria-hidden="true">
        {icon}
      </span>
      {children}
    </button>
  )
}
