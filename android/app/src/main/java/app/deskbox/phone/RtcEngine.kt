package app.deskbox.phone

import android.content.Context
import android.content.Intent
import android.media.projection.MediaProjection
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.DefaultVideoEncoderFactory
import org.webrtc.EglBase
import org.webrtc.PeerConnectionFactory
import org.webrtc.ScreenCapturerAndroid
import org.webrtc.SurfaceTextureHelper
import org.webrtc.VideoSource
import org.webrtc.VideoTrack

/**
 * Dono da captura de tela (MediaProjection) e da fábrica WebRTC. A captura roda uma única vez enquanto o
 * compartilhamento está ativo — no Android 14+ o token do MediaProjection só vale uma vez e um segundo
 * `createVirtualDisplay` no mesmo MediaProjection lança SecurityException. Por isso o formato da captura
 * NÃO muda quando a tela gira (ver [FrameGeometry], que compensa o letterbox no mapeamento de toques), e
 * cada [PeerSession] (um viewer) apenas anexa a mesma [videoTrack].
 */
class RtcEngine(
    appContext: Context,
    projectionData: Intent,
    onProjectionStopped: () -> Unit
) {
    val eglBase: EglBase
    val factory: PeerConnectionFactory
    val videoTrack: VideoTrack

    private val videoSource: VideoSource
    private val helper: SurfaceTextureHelper
    private val capturer: ScreenCapturerAndroid

    val captureWidth: Int
    val captureHeight: Int

    init {
        // Tudo que for criado fica em locais para poder ser descartado se algo lançar no meio do init.
        val egl = EglBase.create()
        var createdFactory: PeerConnectionFactory? = null
        var createdSource: VideoSource? = null
        var createdTrack: VideoTrack? = null
        var createdHelper: SurfaceTextureHelper? = null
        var createdCapturer: ScreenCapturerAndroid? = null
        var capturing = false
        val width: Int
        val height: Int
        try {
            PeerConnectionFactory.initialize(
                PeerConnectionFactory.InitializationOptions.builder(appContext).createInitializationOptions()
            )
            val newFactory = PeerConnectionFactory.builder()
                .setVideoEncoderFactory(DefaultVideoEncoderFactory(egl.eglBaseContext, true, true))
                .setVideoDecoderFactory(DefaultVideoDecoderFactory(egl.eglBaseContext))
                .createPeerConnectionFactory()
            createdFactory = newFactory
            val source = newFactory.createVideoSource(true)
            createdSource = source
            createdTrack = newFactory.createVideoTrack("deskbox-screen", source)
            val textureHelper = SurfaceTextureHelper.create("DeskboxCapture", egl.eglBaseContext)
            createdHelper = textureHelper
            val screenCapturer = ScreenCapturerAndroid(projectionData, object : MediaProjection.Callback() {
                override fun onStop() {
                    onProjectionStopped()
                }
            })
            createdCapturer = screenCapturer
            screenCapturer.initialize(textureHelper, appContext, source.capturerObserver)

            val (realWidth, realHeight) = Screen.realSize(appContext)
            val (captureW, captureH) = Screen.captureSize(realWidth, realHeight)
            width = captureW
            height = captureH
            source.adaptOutputFormat(width, height, FPS)
            screenCapturer.startCapture(width, height, FPS)
            capturing = true
        } catch (t: Throwable) {
            if (capturing) runCatching { createdCapturer?.stopCapture() }
            runCatching { createdCapturer?.dispose() }
            runCatching { createdHelper?.dispose() }
            runCatching { createdTrack?.dispose() }
            runCatching { createdSource?.dispose() }
            runCatching { createdFactory?.dispose() }
            runCatching { egl.release() }
            throw t
        }
        eglBase = egl
        factory = checkNotNull(createdFactory)
        videoSource = checkNotNull(createdSource)
        videoTrack = checkNotNull(createdTrack)
        helper = checkNotNull(createdHelper)
        capturer = checkNotNull(createdCapturer)
        captureWidth = width
        captureHeight = height
        FrameGeometry.captureWidth = width
        FrameGeometry.captureHeight = height
    }

    fun dispose() {
        FrameGeometry.captureWidth = 0
        FrameGeometry.captureHeight = 0
        runCatching { capturer.stopCapture() }
        runCatching { capturer.dispose() }
        runCatching { helper.dispose() }
        runCatching { videoTrack.dispose() }
        runCatching { videoSource.dispose() }
        runCatching { factory.dispose() }
        runCatching { eglBase.release() }
    }

    companion object {
        const val FPS = 30
    }
}
