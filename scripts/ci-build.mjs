// Envolve o electron-builder no CI: decide o modo de assinatura de código a partir das variáveis de
// ambiente (que vêm de GitHub Secrets) e deixa claro nos logs o que foi ou não assinado.
// Uso: node scripts/ci-build.mjs [--dry-run] <args do electron-builder...>
//
// Windows (escolha UMA):
//   A) Certificado .pfx/.p12:      WIN_CSC_LINK (base64 ou URL) + WIN_CSC_KEY_PASSWORD
//   B) Azure Trusted Signing:      AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET,
//                                  AZURE_TS_ENDPOINT, AZURE_TS_ACCOUNT, AZURE_TS_PROFILE, AZURE_TS_PUBLISHER
// macOS:
//   Assinatura:                    CSC_LINK (certificado "Developer ID Application", base64) + CSC_KEY_PASSWORD
//   Notarização (opcional):        APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID
// Sem nenhuma dessas variáveis o build sai SEM assinatura (funciona, mas SmartScreen/Gatekeeper avisam).
import { spawnSync } from 'child_process'

const argv = process.argv.slice(2)
const dryRun = argv.includes('--dry-run')
const passthrough = argv.filter((a) => a !== '--dry-run')
const env = process.env
const has = (...names) => names.every((n) => Boolean(env[n] && env[n].trim()))

const isMac = passthrough.includes('--mac')
const isWin = passthrough.includes('--win') || (!isMac && !passthrough.includes('--linux') && process.platform === 'win32')

const extra = []
const notes = []

if (isWin) {
  if (has('AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET', 'AZURE_TS_ENDPOINT', 'AZURE_TS_ACCOUNT', 'AZURE_TS_PROFILE', 'AZURE_TS_PUBLISHER')) {
    extra.push(
      `-c.win.azureSignOptions.endpoint=${env.AZURE_TS_ENDPOINT}`,
      `-c.win.azureSignOptions.codeSigningAccountName=${env.AZURE_TS_ACCOUNT}`,
      `-c.win.azureSignOptions.certificateProfileName=${env.AZURE_TS_PROFILE}`,
      `-c.win.azureSignOptions.publisherName=${env.AZURE_TS_PUBLISHER}`
    )
    notes.push('Windows: assinatura via Azure Trusted Signing.')
  } else if (has('WIN_CSC_LINK')) {
    notes.push('Windows: assinatura via certificado (WIN_CSC_LINK).')
  } else {
    notes.push('Windows: SEM assinatura (nenhum segredo de assinatura configurado) — SmartScreen vai avisar "editor desconhecido".')
  }
}

if (isMac) {
  if (has('CSC_LINK')) {
    notes.push('macOS: assinatura via certificado Developer ID (CSC_LINK).')
    if (has('APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID')) {
      extra.push('-c.mac.notarize=true')
      notes.push('macOS: notarização ativada.')
    } else {
      notes.push('macOS: assinado, mas SEM notarização (APPLE_ID/APPLE_APP_SPECIFIC_PASSWORD/APPLE_TEAM_ID ausentes) — Gatekeeper ainda avisa.')
    }
  } else {
    notes.push('macOS: SEM assinatura — Gatekeeper bloqueia por padrão e o auto-update não funciona em app não assinado.')
  }
}

// Segredos ausentes chegam como string vazia no GitHub Actions; o electron-builder trataria "" como
// valor configurado em alguns caminhos, então removemos pra ele cair no modo "sem assinatura".
for (const name of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD']) {
  if (env[name] !== undefined && !env[name].trim()) delete env[name]
}

const args = ['electron-builder', ...passthrough, ...extra]
for (const note of notes) console.log(`[ci-build] ${note}`)
console.log(`[ci-build] npx ${args.map((a) => (a.includes('=') ? a.split('=')[0] + '=…' : a)).join(' ')}`)

if (dryRun) process.exit(0)
const result = spawnSync('npx', args, { stdio: 'inherit', shell: process.platform === 'win32', env })
process.exit(result.status ?? 1)
