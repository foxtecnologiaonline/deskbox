package app.deskbox.phone

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import org.json.JSONObject
import org.webrtc.DataChannel
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.PeerConnection
import org.webrtc.RtpSender
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import java.nio.ByteBuffer
import java.util.concurrent.atomic.AtomicBoolean

/** SdpObserver com todos os callbacks vazios, pra sobrescrever só o que interessa. */
open class SimpleSdpObserver : SdpObserver {
    override fun onCreateSuccess(description: SessionDescription?) {}
    override fun onSetSuccess() {}
    override fun onCreateFailure(error: String?) {}
    override fun onSetFailure(error: String?) {}
}

/**
 * Uma sessão de visualização (um viewer do Deskbox). O celular é quem oferta: cria o PeerConnection ao
 * receber `start`, anexa a faixa de vídeo da [RtcEngine] e abre o DataChannel `control`.
 * [sendSignal] envia JSON ao servidor de sinalização; [onClosed] avisa (na thread principal) quando a
 * conexão cai por conta própria.
 *
 * Threads: os callbacks do WebRTC chegam na thread de sinalização e NUNCA fecham/descartam o
 * PeerConnection por conta própria — pedem à thread principal ([fail]/[close]), que faz o teardown.
 * Depois de [close] uma sessão não emite mais offer/ice/controle.
 */
class PeerSession(
    private val context: Context,
    private val engine: RtcEngine,
    private val sendSignal: (JSONObject) -> Unit,
    private val onClosed: () -> Unit
) {
    private val main = Handler(Looper.getMainLooper())
    private val lock = Any()

    @Volatile
    private var connection: PeerConnection? = null

    @Volatile
    private var channel: DataChannel? = null

    // Protegidos por [lock].
    private var remoteDescriptionSet = false
    private var offerSent = false
    private val pendingRemote = mutableListOf<IceCandidate>()
    private val pendingLocal = mutableListOf<IceCandidate>()

    private val closed = AtomicBoolean(false)

    private val a11yListener: (Boolean) -> Unit = { sendA11y() }

    fun start() {
        if (closed.get()) return
        val config = PeerConnection.RTCConfiguration(emptyList()).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
        }
        val pc = engine.factory.createPeerConnection(config, peerObserver)
        if (pc == null) {
            Log.e(TAG, "createPeerConnection retornou null")
            fail()
            return
        }
        connection = pc

        val sender = pc.addTrack(engine.videoTrack, listOf("deskbox-stream"))
        tuneSender(sender)

        val channelInit = DataChannel.Init().apply { ordered = true }
        channel = pc.createDataChannel("control", channelInit)?.also { it.registerObserver(channelObserver) }
        A11yState.addListener(a11yListener)

        pc.createOffer(object : SimpleSdpObserver() {
            override fun onCreateSuccess(description: SessionDescription?) {
                val offer = description ?: return
                if (closed.get()) return
                try {
                    pc.setLocalDescription(object : SimpleSdpObserver() {
                        override fun onSetSuccess() {
                            sendOffer(offer)
                        }

                        override fun onSetFailure(error: String?) {
                            Log.e(TAG, "setLocalDescription falhou: $error")
                            fail()
                        }
                    }, offer)
                } catch (e: IllegalStateException) {
                    Log.w(TAG, "PeerConnection já descartado ao definir a oferta")
                }
            }

            override fun onCreateFailure(error: String?) {
                Log.e(TAG, "createOffer falhou: $error")
                fail()
            }
        }, MediaConstraints())
    }

    fun onRemoteAnswer(sdp: String) {
        if (closed.get()) return
        val pc = connection ?: return
        try {
            // Só aceita `answer` depois de a oferta local ter sido aplicada (e uma única vez).
            if (pc.signalingState() != PeerConnection.SignalingState.HAVE_LOCAL_OFFER) {
                Log.w(TAG, "answer ignorado: signalingState=${pc.signalingState()}")
                return
            }
            pc.setRemoteDescription(object : SimpleSdpObserver() {
                override fun onSetSuccess() {
                    if (closed.get()) return
                    val toAdd = synchronized(lock) {
                        remoteDescriptionSet = true
                        val copy = pendingRemote.toList()
                        pendingRemote.clear()
                        copy
                    }
                    toAdd.forEach { candidate ->
                        runCatching { if (!closed.get()) pc.addIceCandidate(candidate) }
                    }
                }

                override fun onSetFailure(error: String?) {
                    Log.e(TAG, "setRemoteDescription falhou: $error")
                    fail()
                }
            }, SessionDescription(SessionDescription.Type.ANSWER, sdp))
        } catch (e: IllegalStateException) {
            Log.w(TAG, "PeerConnection já descartado ao receber a answer")
        }
    }

    fun onRemoteIce(candidate: JSONObject) {
        if (closed.get()) return
        val ice = IceCandidate(
            candidate.optString("sdpMid").takeIf { it.isNotEmpty() },
            candidate.optInt("sdpMLineIndex", 0),
            candidate.optString("candidate")
        )
        val pc = connection ?: return
        val ready = synchronized(lock) {
            if (!remoteDescriptionSet) {
                pendingRemote.add(ice)
                false
            } else {
                true
            }
        }
        if (ready) runCatching { pc.addIceCandidate(ice) }
    }

    /** Envia largura/altura reais e rotação pelo DataChannel (ao abrir e a cada mudança de tela/rotação). */
    fun sendInfo() {
        val (width, height) = Screen.realSize(context)
        sendControl(
            JSONObject()
                .put("t", "info")
                .put("width", width)
                .put("height", height)
                .put("rotation", Screen.rotationDegrees(context))
        )
    }

    fun sendA11y() {
        sendControl(JSONObject().put("t", "a11y").put("enabled", A11yState.enabled))
    }

    /** Pode ser chamado de qualquer thread; o descarte do WebRTC sempre acontece na thread principal. */
    fun close() {
        if (!closed.compareAndSet(false, true)) return
        A11yState.removeListener(a11yListener)
        if (Looper.myLooper() == Looper.getMainLooper()) teardown() else main.post { teardown() }
    }

    private fun teardown() {
        val dc = channel
        val pc = connection
        channel = null
        connection = null
        runCatching { dc?.unregisterObserver() }
        runCatching { dc?.close() }
        runCatching { dc?.dispose() }
        runCatching { pc?.close() }
        runCatching { pc?.dispose() }
    }

    /** Falha detectada num callback do WebRTC: o teardown e o aviso saem da thread de sinalização. */
    private fun fail() {
        main.post {
            if (closed.get()) return@post
            close()
            onClosed()
        }
    }

    private fun sendOffer(offer: SessionDescription) {
        if (closed.get()) return
        val toSend = synchronized(lock) {
            offerSent = true
            val copy = pendingLocal.toList()
            pendingLocal.clear()
            copy
        }
        sendSignal(JSONObject().put("type", "offer").put("sdp", offer.description))
        toSend.forEach { sendCandidate(it) }
    }

    private fun sendCandidate(candidate: IceCandidate) {
        if (closed.get()) return
        sendSignal(
            JSONObject()
                .put("type", "ice")
                .put(
                    "candidate",
                    JSONObject()
                        .put("candidate", candidate.sdp)
                        .put("sdpMid", candidate.sdpMid)
                        .put("sdpMLineIndex", candidate.sdpMLineIndex)
                )
        )
    }

    private fun sendControl(message: JSONObject) {
        if (closed.get()) return
        val dc = channel ?: return
        try {
            if (dc.state() != DataChannel.State.OPEN) return
            val bytes = message.toString().toByteArray(Charsets.UTF_8)
            dc.send(DataChannel.Buffer(ByteBuffer.wrap(bytes), false))
        } catch (e: IllegalStateException) {
            // Canal descartado entre a checagem e o envio.
        }
    }

    /** Limita bitrate (~2,5 Mbps) e fps (30) no emissor, além do que a captura já respeita. */
    private fun tuneSender(sender: RtpSender?) {
        if (sender == null) return
        runCatching {
            val params = sender.parameters
            for (encoding in params.encodings) {
                encoding.maxBitrateBps = MAX_BITRATE_BPS
                encoding.maxFramerate = RtcEngine.FPS
            }
            sender.setParameters(params)
        }.onFailure { Log.w(TAG, "Não foi possível ajustar o bitrate: ${it.message}") }
    }

    private val peerObserver = object : PeerConnection.Observer {
        override fun onSignalingChange(state: PeerConnection.SignalingState?) {}
        override fun onIceConnectionChange(state: PeerConnection.IceConnectionState?) {}
        override fun onIceConnectionReceivingChange(receiving: Boolean) {}
        override fun onIceGatheringChange(state: PeerConnection.IceGatheringState?) {}

        override fun onIceCandidate(candidate: IceCandidate?) {
            val ice = candidate ?: return
            if (closed.get()) return
            val sendNow = synchronized(lock) {
                if (!offerSent) {
                    pendingLocal.add(ice)
                    false
                } else {
                    true
                }
            }
            if (sendNow) sendCandidate(ice)
        }

        override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>?) {}
        override fun onAddStream(stream: MediaStream?) {}
        override fun onRemoveStream(stream: MediaStream?) {}
        override fun onDataChannel(dataChannel: DataChannel?) {}
        override fun onRenegotiationNeeded() {}

        override fun onConnectionChange(newState: PeerConnection.PeerConnectionState?) {
            if (newState == PeerConnection.PeerConnectionState.FAILED) fail()
        }
    }

    private val channelObserver = object : DataChannel.Observer {
        override fun onBufferedAmountChange(previousAmount: Long) {}

        override fun onStateChange() {
            if (closed.get()) return
            val open = try {
                channel?.state() == DataChannel.State.OPEN
            } catch (e: IllegalStateException) {
                false
            }
            if (open) {
                sendInfo()
                sendA11y()
            }
        }

        override fun onMessage(buffer: DataChannel.Buffer?) {
            if (closed.get()) return
            val received = buffer ?: return
            if (received.binary) return
            val data = received.data
            val bytes = ByteArray(data.remaining())
            data.get(bytes)
            val message = try {
                JSONObject(String(bytes, Charsets.UTF_8))
            } catch (e: Exception) {
                return
            }
            DeskboxAccessibilityService.dispatchControl(message)
        }
    }

    companion object {
        private const val TAG = "PeerSession"
        private const val MAX_BITRATE_BPS = 2_500_000
    }
}
