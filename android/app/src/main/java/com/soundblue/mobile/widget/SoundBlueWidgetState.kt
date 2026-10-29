package com.soundblue.mobile.widget

import android.content.Context
import android.graphics.Bitmap
import androidx.glance.appwidget.updateAll
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/** Lo que muestra el widget. `title == null`: no hay nada cargado (el widget invita a abrir la app). */
data class WidgetSnapshot(
    val title: String? = null,
    val artist: String? = null,
    val playing: Boolean = false,
    val artwork: Bitmap? = null,
)

/**
 * Estado del widget. Lo publica PlaybackService (Java) cada vez que cambia la canción, se pausa o llega la carátula;
 * el widget lo observa mientras su sesión está abierta y, por si estaba cerrada, se le pide redibujarse.
 */
object SoundBlueWidgetState {
    private val state = MutableStateFlow(WidgetSnapshot())
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    val snapshot: StateFlow<WidgetSnapshot> = state.asStateFlow()

    @JvmStatic
    fun publish(context: Context, title: String?, artist: String?, playing: Boolean, artwork: Bitmap?) {
        val next = WidgetSnapshot(title, artist, playing, artwork)
        if (next == state.value) return
        state.value = next
        val app = context.applicationContext
        scope.launch { SoundBlueWidget().updateAll(app) }
    }
}
