# Publicar versões, auto-update e assinatura de código

## Como publicar uma versão

1. Suba a versão em `package.json` (`"version": "0.2.0"`) e faça commit.
2. Crie e envie a tag **igual** à versão, com `v` na frente:
   ```bash
   git tag v0.2.0 && git push origin v0.2.0
   ```
3. O workflow **Release** (`.github/workflows/release.yml`) roda nos 3 sistemas, confere tag × versão, roda os testes (`npm test`), compila e **publica no GitHub Releases** (instaladores + `latest.yml`/`latest-mac.yml`/`latest-linux.yml`).
4. Quem já tem o Deskbox instalado recebe a atualização sozinho (ver abaixo).

Rodar o workflow **Release** manualmente (botão "Run workflow") faz um **ensaio**: compila tudo e sobe como artefatos, sem publicar nada.
O workflow **Build Windows installer** continua existindo para gerar só os `.exe` (instalador `Deskbox-Setup` e `Deskbox-Portable`) em testes.

## Auto-update — o que precisa estar de pé

| Plataforma | Atualiza sozinho? | Observação |
|---|---|---|
| Windows (instalador NSIS) | Sim | Baixa em segundo plano e instala ao reiniciar. Usa o `.blockmap` (download diferencial). |
| Windows (**portátil**) | Não | É um `.exe` avulso, não dá pra se auto-substituir. O app só **avisa** da versão nova e abre a página da release. |
| Linux (AppImage) | Sim | `.deb` não se atualiza sozinho (use o gerenciador de pacotes). |
| macOS | Só com app **assinado e notarizado** | Exigência do Squirrel.Mac. Sem assinatura, a checagem falha. |

- O feed é o **GitHub Releases** do repositório (`build.publish` no `package.json`). **O repositório precisa ser público** (ou o app precisaria de um token embutido — não recomendado). Se for privado, o Deskbox mostra "Nenhuma versão publicada encontrada" nas Configurações.
- Só versões publicadas como **release** (não draft/pré-release) são oferecidas.
- Não dá pra testar o auto-update ponta a ponta sem uma primeira release publicada: o primeiro teste real é instalar a `v0.x` e publicar a `v0.(x+1)`.

## Assinatura de código

Sem assinatura o app **funciona**, mas o Windows SmartScreen mostra "editor desconhecido" e o macOS bloqueia pelo Gatekeeper. O script `scripts/ci-build.mjs` escolhe o modo de assinatura pelos **segredos do repositório** (Settings → Secrets and variables → Actions) e imprime no log o que foi usado. Não precisa mudar nenhum workflow: basta cadastrar os segredos.

### Windows — escolha **uma** das opções

**A) Certificado de assinatura de código (arquivo `.pfx`)** — compra numa autoridade (Sectigo, DigiCert, SSL.com…). Certificados **EV** removem o aviso do SmartScreen imediatamente; os OV comuns precisam "ganhar reputação" com o tempo.

| Segredo | Valor |
|---|---|
| `WIN_CSC_LINK` | o `.pfx` em **base64** (`base64 -w0 cert.pfx`) ou uma URL https para ele |
| `WIN_CSC_KEY_PASSWORD` | senha do `.pfx` |

**B) Azure Trusted Signing** (assinatura gerenciada, bem mais barata que EV; exige conta Azure com verificação de identidade da organização/indivíduo):

| Segredo | Valor |
|---|---|
| `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` | credenciais do app registrado com a função "Trusted Signing Certificate Profile Signer" |
| `AZURE_TS_ENDPOINT` | ex.: `https://eus.codesigning.azure.net` |
| `AZURE_TS_ACCOUNT` | nome da conta de assinatura |
| `AZURE_TS_PROFILE` | nome do perfil de certificado |
| `AZURE_TS_PUBLISHER` | nome do publicador exatamente como no certificado |

### macOS

| Segredo | Valor |
|---|---|
| `CSC_LINK` | certificado **Developer ID Application** (`.p12`) em base64 |
| `CSC_KEY_PASSWORD` | senha do `.p12` |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | para **notarizar** (opcional, mas necessário para o Gatekeeper não avisar). Requer conta Apple Developer (US$ 99/ano). |

Os entitlements (JIT, memória executável, câmera/microfone) estão em `build/entitlements.mac.plist`.

### Conferindo

- Os workflows do Windows rodam `Get-AuthenticodeSignature` nos `.exe` e mostram o status no log.
- Marque **"Falhar se os binários não saírem assinados"** (`require_signature`) ao disparar o workflow manualmente para travar o build quando a assinatura falhar.
- Localmente: `node scripts/ci-build.mjs --dry-run --win` mostra qual modo seria usado, sem compilar.

> O que **eu não consigo fazer por você**: comprar/emitir o certificado e cadastrar os segredos. Sem eles, os builds saem sem assinatura (com aviso amarelo no log do CI).
