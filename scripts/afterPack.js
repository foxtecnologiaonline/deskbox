const fs = require('fs')
const path = require('path')

// O Electron empacota ~55 arquivos de idioma do Chromium (menus de contexto
// nativos, diálogos do sistema) por padrão — só os dois que o Deskbox
// realmente pode mostrar (interface em pt-BR; en-US é o fallback universal
// do próprio Chromium) precisam sobreviver. Isso sozinho corta ~39MB do
// instalador final sem perder nada visível no app.
const KEEP_LOCALES = new Set(['en-US.pak', 'pt-BR.pak'])

/** @type {import('electron-builder').AfterPackContext} */
exports.default = async function afterPack(context) {
  const localesDir = path.join(context.appOutDir, 'locales')
  if (!fs.existsSync(localesDir)) return

  let removed = 0
  let freedBytes = 0
  for (const file of fs.readdirSync(localesDir)) {
    if (file.endsWith('.pak') && !KEEP_LOCALES.has(file)) {
      const filePath = path.join(localesDir, file)
      freedBytes += fs.statSync(filePath).size
      fs.unlinkSync(filePath)
      removed++
    }
  }
  if (removed > 0) {
    console.log(`[afterPack] Removidos ${removed} locales não usados (${(freedBytes / 1024 / 1024).toFixed(1)} MB)`)
  }
}
