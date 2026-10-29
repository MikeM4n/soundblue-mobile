import './lib/storageMigration' // primero: pasa los datos guardados de «bluemusic:» a «soundblue:»
import '@fontsource-variable/inter/index.css' // fuente incluida en el proyecto, sin CDN
import './index.css'
import { Capacitor } from '@capacitor/core'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter } from 'react-router'
import App from './App'
import { hideSplash } from './lib/splash'
import { startTheme } from './lib/theme'

startTheme() // claro, oscuro o el del teléfono (index.html ya lo puso antes de pintar)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* Rutas con # para que funcione en GitHub Pages sin configurar el servidor. */}
    <HashRouter>
      <App />
    </HashRouter>
  </StrictMode>,
)
hideSplash() // la pantalla de carga se desvanece cuando ya pasó su tiempo y la app está lista

// El service worker solo se registra en la versión web compilada, para no guardar copias mientras desarrollas. En el
// APK la interfaz ya viene dentro: el de versiones anteriores se borra con sus copias, para que nunca abra código viejo.
if (Capacitor.isNativePlatform()) {
  if ('serviceWorker' in navigator) {
    void navigator.serviceWorker.getRegistrations().then((registrations) => registrations.forEach((registration) => void registration.unregister()))
  }
  if ('caches' in window) void caches.keys().then((keys) => keys.filter((key) => /^(soundblue|bluemusic)-/.test(key)).forEach((key) => void caches.delete(key)))
} else if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((error) => {
      console.warn('No se pudo registrar el service worker', error)
    })
  })
}
