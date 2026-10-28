import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { __setUserData } from 'electron'
import { Store } from '../src/main/store'
import { SyncManager, type SyncHost } from '../src/main/sync/sync-manager'
import { applyPayload } from '../src/main/sync/payload'
import type { ServiceInstance } from '../src/shared/types'

const root = mkdtempSync(join(tmpdir(), 'deskbox-sync-'))
const cleanups: Array<() => void> = []
after(() => {
  cleanups.forEach((fn) => fn())
  rmSync(root, { recursive: true, force: true })
})

function svc(id: string, name: string): ServiceInstance {
  return {
    instanceId: id, catalogId: 'custom', name, url: 'https://example.com', domain: 'example.com',
    partition: `persist:deskbox-${id}`, workspaceId: 'default', order: 0, muted: false, unreadCount: 0,
    hibernated: false, loading: false, pinned: false, iconUrl: null, proxy: null, customCss: '', customJs: '',
    approvedJsHash: null, jsPendingApproval: false
  }
}

interface Device { store: Store; sync: SyncManager; host: FakeHost }
class FakeHost implements SyncHost {
  locked = false
  applied = 0
  constructor(public store: Store) {}
  isLocked(): boolean { return this.locked }
  applyRemote(payload: Parameters<SyncHost['applyRemote']>[0], ts: number): void {
    this.applied++
    this.store.replaceFromRemote(applyPayload(this.store.getState(), payload), ts)
  }
  statusChanged(): void {}
}

function device(name: string): Device {
  const dir = join(root, `ud-${name}`)
  __setUserData(dir)
  const store = new Store()
  const host = new FakeHost(store)
  const sync = new SyncManager(store, host)
  cleanups.push(() => sync.dispose())
  return { store, sync, host }
}
const addService = (d: Device, id: string, name: string): void => {
  d.store.setState((s) => ({ ...s, services: [...s.services, svc(id, name)] }))
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

test('A publica, B (vazio) puxa, mudança em A chega em B', async () => {
  const folder = mkdtempSync(join(root, 'f1-'))
  const a = device('a1')
  addService(a, 'x1', 'Gmail')
  assert.deepEqual(await a.sync.enable(folder, undefined), { ok: true })
  assert.ok(existsSync(join(folder, 'deskbox-sync.json')))
  assert.ok(readFileSync(join(folder, 'deskbox-sync.json'), 'utf-8').includes('Gmail'))

  const b = device('b1')
  assert.deepEqual(await b.sync.enable(folder, undefined), { ok: true })
  assert.equal(b.store.getState().services[0]?.name, 'Gmail')
  assert.equal(b.store.getState().sync?.folder, folder)

  await sleep(5)
  a.store.setState((s) => ({ ...s, services: s.services.map((x) => ({ ...x, name: 'Gmail Trabalho' })) }))
  await a.sync.syncNow()
  await b.sync.syncNow()
  assert.equal(b.store.getState().services[0].name, 'Gmail Trabalho')
  // B aplicou a do remoto: não deve ter re-publicado nada mais novo que A
  assert.equal(b.store.getState().configUpdatedAt, a.store.getState().configUpdatedAt)
})

test('last-writer-wins: o remoto mais antigo não sobrescreve o local mais novo', async () => {
  const folder = mkdtempSync(join(root, 'f2-'))
  const a = device('a2')
  addService(a, 'x1', 'Slack')
  await a.sync.enable(folder, undefined)
  const b = device('b2')
  await b.sync.enable(folder, undefined)

  await sleep(5)
  b.store.setState((s) => ({ ...s, services: s.services.map((x) => ({ ...x, name: 'Slack B' })) }))
  await b.sync.syncNow() // B publica a mais nova
  await a.sync.syncNow()
  assert.equal(a.store.getState().services[0].name, 'Slack B')
  assert.equal(a.host.applied, 1)
})

test('conflito ao ligar numa pasta que já tem config diferente; resolve=remote aplica a da pasta', async () => {
  const folder = mkdtempSync(join(root, 'f3-'))
  const a = device('a3')
  addService(a, 'x1', 'Notion')
  await a.sync.enable(folder, undefined)

  const c = device('c3')
  addService(c, 'y1', 'Trello')
  const first = await c.sync.enable(folder, undefined)
  assert.equal(first.ok, false)
  assert.equal(first.error, 'conflict')
  assert.equal(first.conflict?.services, 1)
  assert.equal(c.store.getState().sync, null, 'não pode ligar o sync antes do usuário resolver')

  assert.deepEqual(await c.sync.enable(folder, undefined, 'remote'), { ok: true })
  assert.deepEqual(c.store.getState().services.map((s) => s.name), ['Notion'])
})

test('conflito com resolve=local sobrescreve a pasta e vence nos outros dispositivos', async () => {
  const folder = mkdtempSync(join(root, 'f4-'))
  const a = device('a4')
  addService(a, 'x1', 'Notion')
  await a.sync.enable(folder, undefined)
  const c = device('c4')
  addService(c, 'y1', 'Trello')
  assert.deepEqual(await c.sync.enable(folder, undefined, 'local'), { ok: true })
  await a.sync.syncNow()
  assert.deepEqual(a.store.getState().services.map((s) => s.name), ['Trello'])
})

test('criptografia: arquivo sem texto em claro; senha errada/ausente recusadas; certa funciona', async () => {
  const folder = mkdtempSync(join(root, 'f5-'))
  const a = device('a5')
  addService(a, 'x1', 'ServicoSecreto')
  assert.deepEqual(await a.sync.enable(folder, 'senha forte'), { ok: true })
  assert.ok(!readFileSync(join(folder, 'deskbox-sync.json'), 'utf-8').includes('ServicoSecreto'))
  assert.equal(a.sync.getView()?.encrypted, true)

  const b = device('b5')
  const none = await b.sync.enable(folder, undefined)
  assert.equal(none.ok, false)
  assert.match(none.error ?? '', /criptografado/)
  const wrong = await b.sync.enable(folder, 'errada')
  assert.equal(wrong.ok, false)
  assert.match(wrong.error ?? '', /incorreta/)
  assert.equal(b.store.getState().sync, null)

  assert.deepEqual(await b.sync.enable(folder, 'senha forte'), { ok: true })
  assert.equal(b.store.getState().services[0].name, 'ServicoSecreto')
  // a senha foi guardada cifrada pelo cofre do SO, nunca em texto puro
  const saved = b.store.getState().sync?.passphraseEnc ?? ''
  assert.ok(saved.length > 0, 'a senha deveria ter sido guardada (cifrada)')
  assert.notEqual(saved, 'senha forte')
  assert.ok(!JSON.stringify(b.store.getState().sync).includes('senha forte'), 'senha em texto puro no config')
})

test('reinício: sem a senha em memória o status vira needs-passphrase; providePassphrase retoma', async () => {
  const folder = mkdtempSync(join(root, 'f6-'))
  const a = device('a6')
  addService(a, 'x1', 'Calendar')
  await a.sync.enable(folder, 'pw-6')

  // "reinicia" o app B: novo SyncManager sobre a mesma config, mas sem cofre (passphraseEnc nulo)
  const b = device('b6')
  await b.sync.enable(folder, 'pw-6')
  b.store.setState((s) => ({ ...s, sync: { folder, passphraseEnc: null } }))
  const reborn = new SyncManager(b.store, b.host)
  cleanups.push(() => reborn.dispose())
  reborn.start()
  await sleep(150)
  assert.equal(reborn.getView()?.status, 'needs-passphrase')
  const wrong = await reborn.providePassphrase('nope')
  assert.equal(wrong.ok, false)
  assert.deepEqual(await reborn.providePassphrase('pw-6'), { ok: true })
  assert.equal(reborn.getView()?.status, 'idle')
})

test('app trancado: nada sincroniza', async () => {
  const folder = mkdtempSync(join(root, 'f7-'))
  const a = device('a7')
  addService(a, 'x1', 'Zoom')
  await a.sync.enable(folder, undefined)
  const b = device('b7')
  await b.sync.enable(folder, undefined)
  a.store.setState((s) => ({ ...s, services: s.services.map((x) => ({ ...x, name: 'Zoom 2' })) }))
  await a.sync.syncNow()
  b.host.locked = true
  await b.sync.syncNow()
  assert.equal(b.store.getState().services[0].name, 'Zoom')
  b.host.locked = false
  await b.sync.syncNow()
  assert.equal(b.store.getState().services[0].name, 'Zoom 2')
})

test('desativar remove a config local mas não apaga o arquivo da pasta', async () => {
  const folder = mkdtempSync(join(root, 'f8-'))
  const a = device('a8')
  addService(a, 'x1', 'Teams')
  await a.sync.enable(folder, undefined)
  a.sync.disable()
  assert.equal(a.store.getState().sync, null)
  assert.equal(a.sync.getView(), null)
  assert.ok(existsSync(join(folder, 'deskbox-sync.json')))
})

test('pasta inexistente / arquivo corrompido', async () => {
  const a = device('a9')
  assert.equal((await a.sync.enable(join(root, 'nao-existe'), undefined)).ok, false)
  const folder = mkdtempSync(join(root, 'f9-'))
  require('fs').writeFileSync(join(folder, 'deskbox-sync.json'), '{lixo', 'utf-8')
  const res = await a.sync.enable(folder, undefined)
  assert.equal(res.ok, false)
  assert.match(res.error ?? '', /corrompido|ilegível/)
})

test('carimbo no futuro (relógio errado / arquivo hostil) é recusado e não vence o last-writer-wins', async () => {
  const folder = mkdtempSync(join(root, 'fa-'))
  const a = device('aa')
  addService(a, 'x1', 'Original')
  await a.sync.enable(folder, undefined)
  const file = join(folder, 'deskbox-sync.json')
  const env = JSON.parse(readFileSync(file, 'utf-8'))
  env.updatedAt = Date.now() + 3 * 24 * 3600 * 1000
  env.payload.services[0].name = 'HOSTIL'
  require('fs').writeFileSync(file, JSON.stringify(env), 'utf-8')

  await a.sync.syncNow()
  assert.equal(a.store.getState().services[0].name, 'Original')
  assert.equal(a.sync.getView()?.status, 'error')
  assert.match(a.sync.getView()?.error ?? '', /futuro/)

  const b = device('ab')
  const res = await b.sync.enable(folder, undefined)
  assert.equal(res.ok, false)
  assert.match(res.error ?? '', /futuro/)
})

test('edição local depois de receber carimbo adiantado (< 1 dia) ainda vence: carimbo é monotônico', async () => {
  const folder = mkdtempSync(join(root, 'fb-'))
  const a = device('ba')
  addService(a, 'x1', 'V1')
  await a.sync.enable(folder, undefined)
  const b = device('bb')
  await b.sync.enable(folder, undefined)

  // A publica com relógio 1h adiantado
  const file = join(folder, 'deskbox-sync.json')
  const env = JSON.parse(readFileSync(file, 'utf-8'))
  env.updatedAt = Date.now() + 3600 * 1000
  env.payload.services[0].name = 'V2-do-futuro'
  require('fs').writeFileSync(file, JSON.stringify(env), 'utf-8')
  await b.sync.syncNow()
  assert.equal(b.store.getState().services[0].name, 'V2-do-futuro')

  // B edita logo depois: o carimbo tem que passar o recebido, senão a edição seria sobrescrita no próximo ciclo
  b.store.setState((s) => ({ ...s, services: s.services.map((x) => ({ ...x, name: 'V3-editado-em-B' })) }))
  assert.ok(b.store.getState().configUpdatedAt > env.updatedAt)
  await b.sync.syncNow()
  await b.sync.syncNow()
  assert.equal(b.store.getState().services[0].name, 'V3-editado-em-B')
  await a.sync.syncNow()
  assert.equal(a.store.getState().services[0].name, 'V3-editado-em-B')
})
