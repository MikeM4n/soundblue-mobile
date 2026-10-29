import { useState } from 'react'
import { formatDuration } from '../../lib/format'
import { player } from '../../player/engine'
import { usePlaybackTime, usePlayer } from '../../player/usePlayer'

/** Barra de progreso: muestra el tiempo y permite adelantar o retroceder (también con las flechas). */
export function SeekBar({ className = '' }: { className?: string }) {
  const { current, duration } = usePlayer()
  const time = usePlaybackTime() // 4 veces por segundo: avanza suave, no a saltos
  const [dragging, setDragging] = useState<number | null>(null) // posición mientras se arrastra
  const max = Math.max(0, Math.floor(duration))
  const value = dragging ?? Math.min(time, max)

  const commit = () => {
    if (dragging == null) return
    player.seek(dragging)
    setDragging(null)
  }

  return (
    <div className={`flex w-full items-center gap-2 text-xs text-texto-sec ${className}`}>
      <span className="w-10 text-right tabular-nums">{formatDuration(value)}</span>
      <input
        type="range"
        min={0}
        max={max || 1}
        step="any" // la posición avanza en cuartos de segundo, sin saltos
        value={value}
        disabled={!current || !max}
        onChange={(e) => setDragging(Number(e.target.value))}
        onKeyDown={(e) => {
          // Con step="any" las flechas moverían una fracción: se mantiene 1 s por flecha.
          const delta = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0
          if (!delta) return
          e.preventDefault()
          setDragging(Math.max(0, Math.min(max, Math.round((dragging ?? time) + delta))))
        }}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
        aria-label="Posición en la canción"
        aria-valuetext={`${formatDuration(value)} de ${formatDuration(max)}`}
        className="h-1 flex-1 cursor-pointer accent-acento disabled:cursor-default"
      />
      <span className="w-10 tabular-nums">{max ? formatDuration(max) : '–:––'}</span>
    </div>
  )
}
