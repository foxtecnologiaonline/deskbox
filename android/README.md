# Deskbox Celular (app companion Android)

App que compartilha a tela do celular com o **Deskbox** (no computador) e, se você permitir, deixa o Deskbox tocar, deslizar e digitar nele. Funciona só na **rede local** (celular e computador no mesmo Wi-Fi). Protocolo completo em [`docs/phone-protocol.md`](../docs/phone-protocol.md).

> ⚠️ **Use apenas em redes confiáveis.** A sinalização com o Deskbox é `ws://` (sem TLS): o código de pareamento e o token trafegam em texto claro dentro do Wi-Fi. Por isso o app só conecta em endereços de rede local (IP privado `10.x`, `172.16–31.x`, `192.168.x`, link-local `169.254.x`, loopback ou nome `.local`) e recusa qualquer outro host. Não pareie em Wi-Fi público ou compartilhado com estranhos; o vídeo e os comandos de controle (WebRTC) são criptografados.

## Instalar (uma vez)

1. Baixe o **`Deskbox-Phone.apk`**:
   - pela página de *Releases* do GitHub (o Deskbox tem um QR para isso em **Adicionar serviço → Celular Android → QR para baixar o app**), ou
   - pelo artefato **Deskbox-Phone-APK** do workflow *Build Android APK* (GitHub → Actions).
2. Abra o arquivo no celular. O Android pede para permitir **"instalar apps desconhecidos"** para o navegador/gerenciador de arquivos que você usou — permita só para ele.
3. Se o **Play Protect** avisar de "app não verificado", toque em *Mais detalhes → Instalar assim mesmo* (é um app seu, fora da Play Store).

> APK assinado com a chave própria (segredo `ANDROID_KEYSTORE_BASE64` no CI) atualiza por cima da versão anterior. O APK de debug (sem esse segredo) muda de assinatura a cada build: para atualizar, desinstale o antigo antes.

## Permitir o controle (acessibilidade)

Sem isso o Deskbox só **vê** a tela. Para controlar:

1. No app, toque em **Abrir configurações de acessibilidade**.
2. **Apps instalados** (ou "Serviços baixados") → **Deskbox — controle remoto** → **Ativar**.
3. **Android 13 ou mais novo**: se a opção estiver cinza com **"Configuração restrita"**, é a proteção do Android para apps instalados por APK. Toque em **Abrir informações do app** → menu **⋮** (canto superior direito) → **Permitir configurações restritas**, confirme, e volte ao passo 1.
4. De volta ao app, "Controle remoto" deve mostrar **ATIVO**.

## Conectar ao Deskbox

Celular e computador na **mesma rede Wi-Fi** (ou o computador conectado no hotspot do celular).

### Jeito 1 — QR (o celular conecta no computador)

1. No Deskbox: **Adicionar serviço → Celular Android** (aba *Escanear QR*).
2. No app: **Escanear QR do Deskbox** → **Iniciar compartilhamento** → aceite a captura e escolha **Tela inteira**.
3. Se o Windows perguntar, permita o Deskbox no firewall.

### Jeito 2 — "Conectar pelo celular" (o computador conecta no celular)

Use quando o Jeito 1 não conecta — quase sempre é o firewall do computador: **Deskbox portátil** sem administrador, rede marcada como **Pública** no Windows, ou firewall da empresa.

1. No app: deixe o **IP do computador vazio** e toque em **Iniciar compartilhamento** (aceite a captura, **Tela inteira**).
2. O app mostra **"Conectar pelo computador"** com o **endereço** (ex.: `192.168.0.23:47891`) e um **código**.
3. No Deskbox: **Adicionar serviço → Celular Android → aba Conectar pelo celular** → digite endereço e código → **Conectar**.

Os dois jeitos ficam ativos ao mesmo tempo: mesmo começando pelo QR, o app também mostra o endereço/código do jeito 2.

### Depois do primeiro pareamento

Não precisa de código de novo. Abra o app, toque em **Iniciar compartilhamento** e abra o serviço do celular no Deskbox — no jeito 2 é o Deskbox que procura o celular sozinho (a cada 3 s com a tela do celular aberta). Uma notificação fica visível enquanto compartilha; use **Parar** nela (ou no app) a qualquer momento. **Esquecer computadores pareados** apaga os pareamentos.

### Usar no Deskbox

Clique/arraste na tela do celular para tocar e deslizar; roda do mouse rola; botão direito = Voltar. **Clique na tela e digite** para escrever no campo selecionado do celular (Enter envia, Backspace apaga, Esc volta, Ctrl+V cola). Barra de baixo: Voltar, Início, Recentes, Notificações, ⌫ e ⏎.

## Compilar

Android Studio (JDK 17) abrindo a pasta `android/`, ou:

```bash
cd android
./gradlew assembleDebug   # saída: app/build/outputs/apk/debug/app-debug.apk
```
