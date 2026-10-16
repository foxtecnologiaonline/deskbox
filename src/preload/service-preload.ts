import { ipcRenderer } from 'electron'
import { IPC } from '@shared/ipc'

// Muitos apps de mensagem mostram a contagem de não lidos no título da aba,
// ex.: "(3) WhatsApp" ou "Slack (12)". Observamos o título e repassamos o
// número para o processo principal, que agrega e exibe como badge.
function extractUnreadCount(title: string): number {
  const match = title.match(/\((\d+)\)/)
  if (!match) return 0
  const value = Number(match[1])
  return Number.isFinite(value) ? value : 0
}

let lastSent = -1

function reportUnreadFromTitle(): void {
  const count = extractUnreadCount(document.title)
  if (count !== lastSent) {
    lastSent = count
    ipcRenderer.send(IPC.SERVICE_UNREAD, count)
  }
}

function observeTitle(): void {
  reportUnreadFromTitle()
  const titleEl = document.querySelector('head > title')
  const target = titleEl ?? document.head
  const observer = new MutationObserver(() => reportUnreadFromTitle())
  observer.observe(target, { subtree: true, characterData: true, childList: true })
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', observeTitle)
} else {
  observeTitle()
}
