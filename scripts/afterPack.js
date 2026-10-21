const fs = require('fs')
const path = require('path')

// O Electron empacota ~55 arquivos de idioma do Chromium (menus de contexto
// nativos, diálogos do sistema) por padrão — só os dois que o Deskbox
// realmente pode mostrar (interface em pt-BR; en-US é o fallback universal
// do próprio Chromium) precisam sobreviver. Isso sozinho corta ~39MB do
// instalador final sem perder nada visível no app.
const KEEP_LOCALES = new Set(['en-US.pak', 'pt-BR.pak'])

// Arquivo só de texto legal (atribuições de licença open-source do Chromium),
// sem nenhum efeito em runtime — ~8.8MB no total empacotado. O texto
// completo continua público em https://www.chromium.org/chromium-os/licenses
// (ou embutido no binário via chrome://credits em qualquer Chromium/Electron),
// então removê-lo daqui não tira o acesso à atribuição, só o PDF/HTML
// duplicado dentro do pacote.
const EXTRA_FILES_TO_REMOVE = ['LICENSES.chromium.html']

/** @type {import('electron-builder').AfterPackContext} */
exports.default = async function afterPack(context) {
  let removed = 0
  let freedBytes = 0

  const localesDir = path.join(context.appOutDir, 'locales')
  if (fs.existsSync(localesDir)) {
    for (const file of fs.readdirSync(localesDir)) {
      if (file.endsWith('.pak') && !KEEP_LOCALES.has(file)) {
        const filePath = path.join(localesDir, file)
        freedBytes += fs.statSync(filePath).size
        fs.unlinkSync(filePath)
        removed++
      }
    }
  }

  for (const name of EXTRA_FILES_TO_REMOVE) {
    const filePath = path.join(context.appOutDir, name)
    if (fs.existsSync(filePath)) {
      freedBytes += fs.statSync(filePath).size
      fs.unlinkSync(filePath)
      removed++
    }
  }

  if (removed > 0) {
    console.log(`[afterPack] Removidos ${removed} arquivos não usados (${(freedBytes / 1024 / 1024).toFixed(1)} MB)`)
  }
}
