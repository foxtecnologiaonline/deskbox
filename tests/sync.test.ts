import test from 'node:test'
import assert from 'node:assert/strict'
import { encodeEnvelope, decodeEnvelope } from '../src/main/sync/codec'
import { applyPayload, parseSyncPayload, syncSignature, syncableEqual, toSyncPayload, isHttpUrl } from '../src/main/sync/payload'
import type { DeskboxState, ServiceInstance } from '../src/shared/types'

function service(over: Partial<ServiceInstance> = {}): ServiceInstance {
  return {
    instanceId: 'a',
    catalogId: 'gmail',
    name: 'Gmail',
    url: 'https://mail.google.com',
    domain: 'mail.google.com',
    partition: 'persist:deskbox-a',
    workspaceId: 'w1',
    order: 0,
    muted: false,
    unreadCount: 0,
    hibernated: false,
    loading: false,
    pinned: false,
    iconUrl: null,
    proxy: null,
    customCss: '',
    customJs: '',
    approvedJsHash: null,
    jsPendingApproval: false,
    ...over
  }
}

function state(over: Partial<DeskboxState> = {}): DeskboxState {
  return {
    services: [service()],
    workspaces: [{ id: 'w1', name: 'Geral' }],
    activeWorkspaceId: 'w1',
    activeInstanceId: 'a',
    theme: 'dark',
    passwordHash: 'secret-hash',
    proxy: { rules: 'http=corp:8080' },
    hibernateAfterMinutes: 10,
    onboardingDismissed: true,
    sidebarDensity: 'compact',
    notificationsEnabled: true,
    minimizeToTray: true,
    launchAtLogin: true,
    startMinimized: true,
    autoUpdate: true,
    configUpdatedAt: 1000,
    sync: { folder: '/x', passphraseEnc: 'enc' },
    ...over
  }
}

test('payload sincronizável não vaza segredos nem preferências de dispositivo', () => {
  const json = JSON.stringify(toSyncPayload(state({ services: [service({ proxy: { rules: 'p:1' }, approvedJsHash: 'h' })] })))
  for (const forbidden of ['secret-hash', 'corp:8080', 'p:1', 'passphraseEnc', 'minimizeToTray', 'approvedJsHash', 'unreadCount']) {
    assert.ok(!json.includes(forbidden), `vazou: ${forbidden}`)
  }
})

test('assinatura ignora unread/hibernação/loading mas muda com nome, CSS e JS', () => {
  const base = state()
  const same = state({ services: [service({ unreadCount: 9, hibernated: true, loading: true })] })
  assert.equal(syncSignature(base), syncSignature(same))
  assert.notEqual(syncSignature(base), syncSignature(state({ services: [service({ name: 'Outro' })] })))
  assert.notEqual(syncSignature(base), syncSignature(state({ services: [service({ customCss: 'a{}' })] })))
  assert.notEqual(syncSignature(base), syncSignature(state({ services: [service({ customJs: '1' })] })))
})

test('round-trip sem senha', async () => {
  const payload = toSyncPayload(state())
  const text = await encodeEnvelope(payload, 42, 'dev1', null)
  const res = await decodeEnvelope(text, null)
  assert.ok(res.ok)
  if (res.ok) {
    assert.equal(res.envelope.updatedAt, 42)
    assert.equal(res.envelope.encrypted, false)
    assert.deepEqual(res.envelope.payload, payload)
  }
})

test('round-trip criptografado + senha errada + sem senha', async () => {
  const payload = toSyncPayload(state({ services: [service({ name: 'NomeSecreto' })] }))
  const text = await encodeEnvelope(payload, 7, 'dev1', 'correct horse')
  assert.ok(!text.includes('NomeSecreto'), 'conteúdo em claro no arquivo criptografado')
  const ok = await decodeEnvelope(text, 'correct horse')
  assert.ok(ok.ok)
  const bad = await decodeEnvelope(text, 'wrong')
  assert.deepEqual(bad, { ok: false, error: 'bad-passphrase' })
  const none = await decodeEnvelope(text, null)
  assert.deepEqual(none, { ok: false, error: 'needs-passphrase' })
})

test('adulterar updatedAt/deviceId invalida a autenticação (AAD)', async () => {
  const text = await encodeEnvelope(toSyncPayload(state()), 100, 'dev1', 'pw')
  const tampered = JSON.stringify({ ...JSON.parse(text), updatedAt: 999999 })
  assert.deepEqual(await decodeEnvelope(tampered, 'pw'), { ok: false, error: 'bad-passphrase' })
  const tampered2 = JSON.stringify({ ...JSON.parse(text), deviceId: 'evil' })
  assert.deepEqual(await decodeEnvelope(tampered2, 'pw'), { ok: false, error: 'bad-passphrase' })
})

test('KDF malicioso (N enorme) é recusado em vez de estourar memória', async () => {
  const obj = JSON.parse(await encodeEnvelope(toSyncPayload(state()), 1, 'd', 'pw'))
  obj.kdf.N = 1 << 24
  assert.deepEqual(await decodeEnvelope(JSON.stringify(obj), 'pw'), { ok: false, error: 'corrupt' })
})

test('arquivo corrompido / formato errado', async () => {
  assert.deepEqual(await decodeEnvelope('não é json', null), { ok: false, error: 'corrupt' })
  assert.deepEqual(await decodeEnvelope('{"format":"outro"}', null), { ok: false, error: 'corrupt' })
  assert.deepEqual(await decodeEnvelope('{"format":"deskbox-sync","version":99}', null), { ok: false, error: 'unsupported' })
})

test('URLs não-http(s) são recusadas (file:, javascript:, data:)', () => {
  assert.ok(isHttpUrl('https://a.com'))
  assert.ok(isHttpUrl('http://a.com'))
  for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hi', 'ftp://x', '', 'x', null, 5]) {
    assert.ok(!isHttpUrl(bad), String(bad))
  }
  const evil = toSyncPayload(state())
  evil.services[0].url = 'file:///etc/passwd'
  assert.equal(parseSyncPayload(evil), null)
})

test('payload remoto malformado é recusado inteiro', () => {
  assert.equal(parseSyncPayload(null), null)
  assert.equal(parseSyncPayload({ services: [], workspaces: [] }), null)
  assert.equal(parseSyncPayload({ services: [{}], workspaces: [{ id: 'w', name: 'n' }] }), null)
  const good = toSyncPayload(state())
  assert.ok(parseSyncPayload(good))
  const huge = toSyncPayload(state({ services: [service({ customJs: 'x'.repeat(200_001) })] }))
  assert.equal(parseSyncPayload(huge), null)
})

test('applyPayload preserva o que é só do dispositivo e nunca aprova JS vindo de fora', () => {
  const local = state({
    services: [service({ proxy: { rules: 'local:1' }, unreadCount: 3, approvedJsHash: 'abc', customJs: 'old' })],
    activeInstanceId: 'a'
  })
  const remote = toSyncPayload(
    state({
      services: [service({ name: 'Renomeado', customJs: 'novo()' }), service({ instanceId: 'b', partition: 'persist:deskbox-b' })],
      theme: 'light'
    })
  )
  const next = applyPayload(local, remote)
  const a = next.services.find((s) => s.instanceId === 'a')!
  const b = next.services.find((s) => s.instanceId === 'b')!
  assert.equal(a.name, 'Renomeado')
  assert.deepEqual(a.proxy, { rules: 'local:1' })
  assert.equal(a.unreadCount, 3)
  assert.equal(a.customJs, 'novo()')
  assert.equal(a.approvedJsHash, 'abc')
  assert.equal(b.approvedJsHash, null)
  assert.equal(next.theme, 'light')
  assert.equal(next.passwordHash, 'secret-hash')
  assert.equal(next.minimizeToTray, true)
  assert.equal(next.activeInstanceId, 'a')
})

test('applyPayload zera o serviço ativo se ele foi removido no remoto', () => {
  const local = state({ activeInstanceId: 'a' })
  const remote = toSyncPayload(state({ services: [service({ instanceId: 'z', partition: 'persist:deskbox-z' })] }))
  assert.equal(applyPayload(local, remote).activeInstanceId, null)
})

test('celular com workspace inexistente no remoto é movido pro primeiro workspace, nunca descartado', () => {
  const phone = service({ instanceId: 'ph', catalogId: 'android-phone', url: 'deskbox-phone://dev', workspaceId: 'w-local' })
  const local = state({ services: [service(), phone], workspaces: [{ id: 'w1', name: 'Geral' }, { id: 'w-local', name: 'Local' }] })
  const remote = toSyncPayload(state({ workspaces: [{ id: 'w1', name: 'Geral' }] }))
  const next = applyPayload(local, remote)
  const moved = next.services.find((s) => s.instanceId === 'ph')
  assert.ok(moved, 'celular sumiu')
  assert.equal(moved!.workspaceId, 'w1')
})

test('serviço com URL inválida não entra no payload (não quebra o arquivo de sync)', () => {
  const bad = state({ services: [service(), service({ instanceId: 'bad', url: 'https://bad host' }), service({ instanceId: 'ftp', url: 'ftp://x' })] })
  const payload = toSyncPayload(bad)
  assert.deepEqual(payload.services.map((s) => s.instanceId), ['a'])
  assert.ok(parseSyncPayload(payload), 'o payload gerado tem que ser sempre aceito pelo parse')
})

test('syncableEqual concorda com a comparação por assinatura', () => {
  const base = state()
  const cases: DeskboxState[] = [
    state(),
    state({ services: [service({ unreadCount: 7, hibernated: true })] }),
    state({ services: [service({ proxy: { rules: 'x' }, approvedJsHash: 'h' })] }),
    state({ passwordHash: 'outro', minimizeToTray: false }),
    state({ services: [service({ name: 'Outro' })] }),
    state({ services: [service({ customCss: 'a{}' })] }),
    state({ services: [service({ customJs: 'x' })] }),
    state({ services: [service({ order: 3 })] }),
    state({ services: [service(), service({ instanceId: 'b', partition: 'p' })] }),
    state({ services: [] }),
    state({ theme: 'light' }),
    state({ workspaces: [{ id: 'w1', name: 'Renomeado' }] }),
    state({ sidebarDensity: 'comfortable' }),
    state({ services: [service(), service({ instanceId: 'ph', catalogId: 'android-phone', url: 'deskbox-phone://x' })] }),
    state({ services: [service(), service({ instanceId: 'bad', url: 'nope' })] })
  ]
  for (const [i, next] of cases.entries()) {
    assert.equal(syncableEqual(base, next), syncSignature(base) === syncSignature(next), `caso ${i}`)
  }
})
