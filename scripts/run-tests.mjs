// Runner mínimo: empacota cada tests/*.test.ts com esbuild (resolve os aliases @shared e o TS)
// e executa com o test runner nativo do Node. Sem dependência de framework de teste.
import { build } from 'esbuild'
import { readdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { spawnSync } from 'child_process'

const root = resolve(import.meta.dirname, '..')
const testsDir = join(root, 'tests')
const files = readdirSync(testsDir).filter((f) => f.endsWith('.test.ts'))
const out = mkdtempSync(join(tmpdir(), 'deskbox-tests-'))

try {
  const outfiles = []
  for (const file of files) {
    const outfile = join(out, file.replace(/\.ts$/, '.cjs'))
    await build({
      entryPoints: [join(testsDir, file)],
      outfile,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: ['bufferutil', 'utf-8-validate'],
      // "electron" vira um stub: dá pra testar Store/SyncManager sem abrir o Electron.
      alias: { '@shared': join(root, 'src/shared'), electron: join(testsDir, 'stubs/electron.ts') },
      logLevel: 'error'
    })
    outfiles.push(outfile)
  }
  const result = spawnSync(process.execPath, ['--test', ...outfiles], { stdio: 'inherit' })
  process.exitCode = result.status ?? 1
} finally {
  rmSync(out, { recursive: true, force: true })
}
