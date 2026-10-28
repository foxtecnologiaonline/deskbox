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
import android.widget.TextView
import android.widget.Toast
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
        val host = inputHost.text.toString().trim()
        val port = inputPort.text.toString().trim().toIntOrNull()
        val code = inputCode.text.toString().trim()
        if (host.isEmpty() || port == null || port !in 1..65535) {
            Toast.makeText(this, "Informe o IP e a porta do computador", Toast.LENGTH_SHORT).show()
            return
        }
        if (code.isEmpty() && prefs.token.isNullOrEmpty()) {
            Toast.makeText(this, "Informe o código de 6 dígitos mostrado no Deskbox", Toast.LENGTH_SHORT).show()
            return
        }
        prefs.host = host
        prefs.port = port
        // Um código novo significa pareamento novo: descarta o token antigo.
        if (code.isNotEmpty()) prefs.token = null

        val manager = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        projectionLauncher.launch(manager.createScreenCaptureIntent())
    }

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
        inputHost.setText(host)
        uri.getQueryParameter("port")?.let { inputPort.setText(it) }
        uri.getQueryParameter("code")?.let { inputCode.setText(it) }
        Toast.makeText(this, "QR lido — toque em Iniciar compartilhamento", Toast.LENGTH_SHORT).show()
    }
}
