# Deskbox Celular (app companion Android)

App que compartilha a tela do celular com o **Deskbox** (no computador) e, se você permitir, deixa o Deskbox tocar, deslizar e digitar nele. Funciona só na **rede local** (celular e computador no mesmo Wi-Fi). Protocolo completo em [`docs/phone-protocol.md`](../docs/phone-protocol.md).

## Instalar

1. Baixe o artefato **Deskbox-Phone-APK** do workflow *Build Android APK* (GitHub → Actions) e extraia o `app-debug.apk`.
2. Copie para o celular e abra. O Android pedirá para permitir "instalar apps de fontes desconhecidas" para o app que você usou para abrir o arquivo.

> É um APK de *debug* (assinado com a chave de debug do Android). Serve para uso próprio; publicar na Play Store exigiria um keystore de release.

## Permitir o controle (acessibilidade)

Sem isso o Deskbox só **vê** a tela. Para controlar:

1. No app, toque em **Abrir configurações de acessibilidade**.
2. Apps instalados → **Deskbox — controle remoto** → **Ativar**.
3. De volta ao app, a linha "Controle remoto" deve mostrar **ATIVO**.

## Parear e compartilhar

1. No Deskbox: **Adicionar serviço → Celular Android**. Ele mostra o IP, a porta e um código de 6 dígitos (válido por 5 min, uso único) e um QR.
2. No app: **Escanear QR** (ou digite IP, porta e código).
3. Toque em **Iniciar compartilhamento** e aceite o pedido de captura de tela do Android. Escolha **tela inteira** se quiser controlar o aparelho todo.
4. Uma notificação fica visível enquanto compartilha; use **Parar** nela (ou no app) a qualquer momento.

Nas próximas vezes não precisa de código: o app guarda um token do pareamento.

## Compilar

Android Studio (JDK 17) abrindo a pasta `android/`, ou:

```bash
cd android
./gradlew assembleDebug   # saída: app/build/outputs/apk/debug/app-debug.apk
```
