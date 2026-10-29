/** Commit y hora de compilación (vite.config.ts), para el registro de diagnóstico. */
declare const __APP_VERSION__: string

interface ImportMetaEnv {
  /** Clave de la YouTube Data API v3 (en .env y como secreto de GitHub). Sin ella, Buscar usa el catálogo de prueba. */
  readonly VITE_YT_API_KEY?: string
  /** Backend que resuelve las URL de audio. Se puede cambiar después en Ajustes, sin recompilar. */
  readonly VITE_AUDIO_BACKEND_URL?: string
  /** Intermediario para YouTube Music (InnerTube) en la versión publicada. Al probar se usa /ytm-api de Vite. */
  readonly VITE_YTM_PROXY?: string
}
