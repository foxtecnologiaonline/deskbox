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

    /**
     * SHA-256 do segredo que este celular emitiu para o computador na conexão reversa (o computador guarda o
     * segredo; aqui fica só o hash). Nulo = nenhum computador pareado nesse modo.
     */
    var linkTokenHash: String?
        get() = sp.getString(KEY_LINK_TOKEN_HASH, null)
        set(value) {
            sp.edit().putString(KEY_LINK_TOKEN_HASH, value).apply()
        }

    /** IP(s) do computador para o modo direto, separados por vírgula (o QR pode trazer alternativos). */
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

    /** Esquece os pareamentos (os dois modos): o Deskbox precisa de um código novo para voltar a conectar. */
    fun forgetPairings() {
        sp.edit().remove(KEY_TOKEN).remove(KEY_LINK_TOKEN_HASH).apply()
    }

    companion object {
        const val DEFAULT_PORT = 47890
        private const val KEY_DEVICE_ID = "device_id"
        private const val KEY_TOKEN = "token"
        private const val KEY_HOST = "host"
        private const val KEY_PORT = "port"
        private const val KEY_LINK_TOKEN_HASH = "link_token_hash"
    }
}
