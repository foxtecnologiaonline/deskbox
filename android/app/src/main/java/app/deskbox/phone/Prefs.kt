package app.deskbox.phone

import android.content.Context
import java.util.UUID

class Prefs(context: Context) {
    private val sp = context.applicationContext.getSharedPreferences("deskbox_phone", Context.MODE_PRIVATE)

    /** UUID estável deste celular (o servidor do Deskbox identifica o aparelho por ele). */
    val deviceId: String
        get() = sp.getString(KEY_DEVICE_ID, null) ?: UUID.randomUUID().toString().also {
            sp.edit().putString(KEY_DEVICE_ID, it).apply()
        }

    /** Token devolvido pelo servidor após o 1º pareamento; usado nas reconexões sem código. */
    var token: String?
        get() = sp.getString(KEY_TOKEN, null)
        set(value) {
            sp.edit().putString(KEY_TOKEN, value).apply()
        }

    var host: String
        get() = sp.getString(KEY_HOST, "") ?: ""
        set(value) {
            sp.edit().putString(KEY_HOST, value).apply()
        }

    var port: Int
        get() = sp.getInt(KEY_PORT, DEFAULT_PORT)
        set(value) {
            sp.edit().putInt(KEY_PORT, value).apply()
        }

    companion object {
        const val DEFAULT_PORT = 47890
        private const val KEY_DEVICE_ID = "device_id"
        private const val KEY_TOKEN = "token"
        private const val KEY_HOST = "host"
        private const val KEY_PORT = "port"
    }
}
