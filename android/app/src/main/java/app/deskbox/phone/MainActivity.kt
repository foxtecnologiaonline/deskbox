package app.deskbox.phone

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.projection.MediaProjectionManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.widget.Button
import android.widget.EditText
import android.view.View
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions

class MainActivity : AppCompatActivity() {

    private lateinit var prefs: Prefs
    private lateinit var inputHost: EditText
    private lateinit var inputPort: EditText
    private lateinit var inputCode: EditText
    private lateinit var buttonStartStop: Button
    private lateinit var textStatus: TextView
    private lateinit var textLink: TextView
    private lateinit var textA11y: TextView

    private val a11yListener: (Boolean) -> Unit = { runOnUiThread { renderA11y() } }

    private val scanLauncher = registerForActivityResult(ScanContract()) { result ->
        result.contents?.let { handleQr(it) }
    }

    private val projectionLauncher =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            val data = result.data
            if (result.resultCode == Activity.RESULT_OK && data != null) {
                startShare(data)
            } else {
                textStatus.text = "Permissão de captura de tela negada"
            }
        }

    private val notificationLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        prefs = Prefs(this)

        inputHost = findViewById(R.id.inputHost)
        inputPort = findViewById(R.id.inputPort)
        inputCode = findViewById(R.id.inputCode)
        buttonStartStop = findViewById(R.id.buttonStartStop)
        textStatus = findViewById(R.id.textStatus)
        textLink = findViewById(R.id.textLink)
        textA11y = findViewById(R.id.textA11y)

        inputHost.setText(prefs.host)
        inputPort.setText(prefs.port.toString())

        findViewById<Button>(R.id.buttonScan).setOnClickListener {
            scanLauncher.launch(
                ScanOptions()
                    .setDesiredBarcodeFormats(listOf("QR_CODE"))
                    .setPrompt("Aponte para o QR exibido no Deskbox")
                    .setBeepEnabled(false)
                    .setOrientationLocked(false)
            )
        }
        findViewById<Button>(R.id.buttonA11y).setOnClickListener {
            startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
        }
        // Android 13+: app instalado por APK (fora da Play Store) tem a acessibilidade bloqueada como
        // "configuração restrita" até o usuário liberar em Informações do app → ⋮ → Permitir configurações restritas.
        val restricted = Build.VERSION.SDK_INT >= 33
        findViewById<View>(R.id.restrictedHelp).visibility = if (restricted) View.VISIBLE else View.GONE
        findViewById<Button>(R.id.buttonAppInfo).apply {
            visibility = if (restricted) View.VISIBLE else View.GONE
            setOnClickListener {
                startActivity(
                    Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName"))
                )
            }
        }
        findViewById<Button>(R.id.buttonForget).setOnClickListener { confirmForget() }
        buttonStartStop.setOnClickListener { onStartStopClicked() }

        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            notificationLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    override fun onStart() {
        super.onStart()
        ShareStatus.listener = { renderStatus() }
        A11yState.addListener(a11yListener)
        renderStatus()
        renderA11y()
    }

    override fun onStop() {
        ShareStatus.listener = null
        A11yState.removeListener(a11yListener)
        super.onStop()
    }

    private fun renderStatus() {
        textStatus.text = ShareStatus.message
        buttonStartStop.text =
            if (ShareStatus.running) "Parar compartilhamento" else "Iniciar compartilhamento"
        val link = ShareStatus.link
        textLink.visibility = if (ShareStatus.running && link != null) View.VISIBLE else View.GONE
        if (link != null) {
            val addresses = link.addresses.take(2).joinToString("  ou  ") { "$it:${link.port}" }
                .ifEmpty { "(sem Wi-Fi — conecte a uma rede)" }
            textLink.text = buildString {
                append("Conectar pelo computador (se o Deskbox não achar o celular sozinho):\n")
                append("No Deskbox → Adicionar serviço → Celular Android → Conectar pelo celular\n\n")
                append("Endereço:  ").append(addresses).append('\n')
                if (link.code != null) append("Código:  ").append(link.code)
                else append("Código bloqueado por excesso de tentativas — pare e inicie de novo.")
                if (link.linked) append("\n\nEste celular já está pareado com um computador: ele reconecta sozinho.")
            }
        }
    }

    private fun confirmForget() {
        AlertDialog.Builder(this)
            .setTitle("Esquecer computadores pareados?")
            .setMessage("O Deskbox vai precisar de um código novo para conectar neste celular de novo.")
            .setPositiveButton("Esquecer") { _, _ ->
                if (ShareStatus.running) {
                    startService(Intent(this, ScreenShareService::class.java).setAction(ScreenShareService.ACTION_STOP))
                }
                prefs.forgetPairings()
                Toast.makeText(this, "Pareamentos apagados", Toast.LENGTH_SHORT).show()
            }
            .setNegativeButton("Cancelar", null)
            .show()
    }

    private fun renderA11y() {
        textA11y.text = if (A11yState.enabled) {
            "Controle remoto: ATIVO (o Deskbox pode tocar, deslizar e digitar)"
        } else {
            "Controle remoto: DESATIVADO — o Deskbox só verá a tela (somente visualização)"
        }
    }

    private fun onStartStopClicked() {
        if (ShareStatus.running) {
            startService(Intent(this, ScreenShareService::class.java).setAction(ScreenShareService.ACTION_STOP))
            return
        }
        // Vazio = só o caminho reverso (o computador conecta no celular pelo endereço/código mostrados aqui).
        val hosts = parseHosts(inputHost.text.toString())
        val port = inputPort.text.toString().trim().toIntOrNull()
        val code = inputCode.text.toString().trim()
        if (hosts.isNotEmpty()) {
            if (port == null || port !in 1..65535) {
                Toast.makeText(this, "Porta inválida", Toast.LENGTH_SHORT).show()
                return
            }
            if (code.isEmpty() && prefs.token.isNullOrEmpty()) {
                Toast.makeText(
                    this,
                    "Informe o código do Deskbox — ou apague o IP para o computador conectar no celular",
                    Toast.LENGTH_LONG
                ).show()
                return
            }
            // Antes de pedir a captura de tela e antes de qualquer código/token sair do aparelho: só rede local.
            if (hosts.any { !HostPolicy.isLocalHost(it) }) {
                Toast.makeText(this, HostPolicy.MESSAGE, Toast.LENGTH_LONG).show()
                return
            }
            prefs.port = port
        }
        prefs.host = hosts.joinToString(", ")
        // O token antigo NÃO é apagado aqui: se a captura for negada ou o código estiver errado, o pareamento
        // anterior continua valendo. Ele só é substituído quando o Deskbox responde `paired`.

        val manager = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        projectionLauncher.launch(manager.createScreenCaptureIntent())
    }

    private fun parseHosts(text: String): List<String> =
        text.split(',', ' ', ';').map { it.trim() }.filter { it.isNotEmpty() }.distinct()

    private fun startShare(projectionData: Intent) {
        val intent = Intent(this, ScreenShareService::class.java)
            .setAction(ScreenShareService.ACTION_START)
            .putExtra(ScreenShareService.EXTRA_RESULT_DATA, projectionData)
            .putExtra(ScreenShareService.EXTRA_HOST, prefs.host)
            .putExtra(ScreenShareService.EXTRA_PORT, prefs.port)
            .putExtra(ScreenShareService.EXTRA_CODE, inputCode.text.toString().trim().takeIf { it.isNotEmpty() })
        ContextCompat.startForegroundService(this, intent)
        inputCode.text.clear()
    }

    private fun handleQr(contents: String) {
        val uri = Uri.parse(contents)
        val host = uri.getQueryParameter("host")
        if (uri.scheme != "deskbox" || uri.host != "pair" || host.isNullOrEmpty()) {
            Toast.makeText(this, "QR inválido (não é do Deskbox)", Toast.LENGTH_SHORT).show()
            return
        }
        if (!HostPolicy.isLocalHost(host)) {
            Toast.makeText(this, HostPolicy.MESSAGE, Toast.LENGTH_LONG).show()
            return
        }
        // `alt`: outros endereços do computador (cabo + Wi-Fi, VPN...). O app tenta um por um até conectar.
        val alternates = parseHosts(uri.getQueryParameter("alt").orEmpty()).filter { HostPolicy.isLocalHost(it) }
        inputHost.setText((listOf(host) + alternates).distinct().joinToString(", "))
        uri.getQueryParameter("port")?.let { inputPort.setText(it) }
        uri.getQueryParameter("code")?.let { inputCode.setText(it) }
        Toast.makeText(this, "QR lido — toque em Iniciar compartilhamento", Toast.LENGTH_SHORT).show()
    }
}
