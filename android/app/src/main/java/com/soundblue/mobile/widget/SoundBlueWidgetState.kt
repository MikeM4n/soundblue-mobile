package com.soundblue.mobile.widget

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import androidx.glance.appwidget.updateAll
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * Lo que muestra el widget. `title == null`: nunca ha sonado nada. `active`: el reproductor tiene cargada esta canción y
 * los botones la controlan; si no, es la última que sonó (guardada) y ▶ la vuelve a poner a sonar, sin abrir la app.
 */
data class WidgetSnapshot(
    val id: String? = null,
    val title: String? = null,
    val artist: String? = null,
    val playing: Boolean = false,
    val liked: Boolean = false, // está en Tus me gusta (lo dice la app)
    val artwork: Bitmap? = null,
    val active: Boolean = false,
    val likeable: Boolean = false, // la app está abierta (en primer o segundo plano) para guardar el ♥
)

/**
 * Estado del widget. Lo publica PlaybackService (Java) cada vez que cambia la canción, se pausa o llega la carátula; el
 * widget lo observa mientras su sesión está abierta y, por si estaba cerrada, se le pide redibujarse. La última canción
 * (título, artista, ♥ y carátula) se guarda en SharedPreferences y en un archivo: aunque el reproductor se detenga o
 * Android cierre la app, el widget la sigue mostrando.
 */
object SoundBlueWidgetState {
    private const val PREFS = "soundblue_widget"
    private const val ARTWORK_FILE = "widget_artwork.png"

    private val state = MutableStateFlow(WidgetSnapshot())
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private var restored = false // ya se leyó la última canción guardada (o ya sonó algo en este proceso)
    private var remembered = "" // id|título|artista|♥ ya guardados
    private var savedArtwork: Bitmap? = null // la carátula que ya está en el archivo

    val snapshot: StateFlow<WidgetSnapshot> = state.asStateFlow()

    /** Lo que suena: el reproductor la tiene cargada. Se guarda para mostrarla aunque el reproductor se detenga. */
    @JvmStatic
    fun publish(
        context: Context,
        id: String,
        title: String,
        artist: String,
        playing: Boolean,
        liked: Boolean,
        likeable: Boolean,
        artwork: Bitmap?,
    ) {
        restored = true
        val next = WidgetSnapshot(id, title, artist, playing, liked, artwork, active = true, likeable = likeable)
        if (next != state.value) update(context, next)
        remember(context, next)
    }

    /** El reproductor no tiene nada cargado (se detuvo o recién arranca): queda la última canción, en pausa. */
    @JvmStatic
    fun idle(context: Context) {
        restore(context)
        update(context, state.value.copy(playing = false, active = false, likeable = false)) // siempre: quita los controles de antes
    }

    /** Al dibujar el widget en un proceso nuevo (Android cerró la app): la última canción guardada. */
    fun restore(context: Context) {
        if (restored) return
        restored = true
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val id = prefs.getString("id", null) ?: return
        val file = File(context.filesDir, ARTWORK_FILE)
        val artwork = if (prefs.getString("artworkId", null) == id && file.exists()) BitmapFactory.decodeFile(file.path) else null
        savedArtwork = artwork
        val snapshot = WidgetSnapshot(id, prefs.getString("title", null), prefs.getString("artist", ""), false, prefs.getBoolean("liked", false), artwork)
        remembered = key(snapshot)
        state.value = snapshot
    }

    private fun update(context: Context, next: WidgetSnapshot) {
        state.value = next
        val app = context.applicationContext
        scope.launch { SoundBlueWidget().updateAll(app) }
    }

    private fun remember(context: Context, snapshot: WidgetSnapshot) {
        val app = context.applicationContext
        val prefs = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val key = key(snapshot)
        if (key != remembered) {
            remembered = key
            prefs.edit()
                .putString("id", snapshot.id)
                .putString("title", snapshot.title)
                .putString("artist", snapshot.artist)
                .putBoolean("liked", snapshot.liked)
                .apply()
        }
        val artwork = snapshot.artwork ?: return
        if (artwork === savedArtwork) return
        savedArtwork = artwork
        val id = snapshot.id
        scope.launch(Dispatchers.IO) {
            // Primero a un temporal: si se corta a medias, no queda una carátula rota.
            val temp = File(app.filesDir, "$ARTWORK_FILE.tmp")
            temp.outputStream().use { artwork.compress(Bitmap.CompressFormat.PNG, 100, it) }
            if (temp.renameTo(File(app.filesDir, ARTWORK_FILE))) prefs.edit().putString("artworkId", id).apply()
        }
    }

    private fun key(snapshot: WidgetSnapshot) = listOf(snapshot.id, snapshot.title, snapshot.artist, snapshot.liked).joinToString("|")
}
