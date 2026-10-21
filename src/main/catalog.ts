import type { CatalogEntry } from '@shared/types'

function entry(id: string, name: string, url: string, domain: string, category: string): CatalogEntry {
  return { id, name, url, domain, category }
}

export const CATALOG: CatalogEntry[] = [
  entry('whatsapp', 'WhatsApp', 'https://web.whatsapp.com', 'web.whatsapp.com', 'Mensagens'),
  entry('whatsapp-business', 'WhatsApp Business', 'https://web.whatsapp.com', 'web.whatsapp.com', 'Mensagens'),
  entry('telegram', 'Telegram', 'https://web.telegram.org/a/', 'web.telegram.org', 'Mensagens'),
  entry('messenger', 'Messenger', 'https://www.messenger.com', 'www.messenger.com', 'Mensagens'),
  entry('discord', 'Discord', 'https://discord.com/app', 'discord.com', 'Mensagens'),
  entry('slack', 'Slack', 'https://app.slack.com/client', 'app.slack.com', 'Mensagens'),
  entry('instagram', 'Instagram Direct', 'https://www.instagram.com/direct/inbox/', 'www.instagram.com', 'Mensagens'),
  entry('x', 'X (Twitter)', 'https://x.com/messages', 'x.com', 'Mensagens'),
  entry('linkedin', 'LinkedIn', 'https://www.linkedin.com/messaging/', 'www.linkedin.com', 'Mensagens'),
  entry('skype', 'Skype', 'https://web.skype.com', 'web.skype.com', 'Mensagens'),
  entry('gmail', 'Gmail', 'https://mail.google.com', 'mail.google.com', 'E-mail'),
  entry('outlook', 'Outlook', 'https://outlook.office.com/mail/', 'outlook.office.com', 'E-mail'),
  entry('claude', 'Claude', 'https://claude.ai', 'claude.ai', 'IA'),
  entry('chatgpt', 'ChatGPT', 'https://chat.openai.com', 'chat.openai.com', 'IA'),
  entry('gemini', 'Gemini', 'https://gemini.google.com/app', 'gemini.google.com', 'IA'),
  entry('perplexity', 'Perplexity', 'https://www.perplexity.ai', 'www.perplexity.ai', 'IA'),
  entry('teams', 'Microsoft Teams', 'https://teams.microsoft.com', 'teams.microsoft.com', 'Produtividade'),
  entry('notion', 'Notion', 'https://www.notion.so', 'www.notion.so', 'Produtividade'),
  entry('trello', 'Trello', 'https://trello.com', 'trello.com', 'Produtividade'),
  entry('asana', 'Asana', 'https://app.asana.com', 'app.asana.com', 'Produtividade'),
  entry('clickup', 'ClickUp', 'https://app.clickup.com', 'app.clickup.com', 'Produtividade'),
  entry('google-calendar', 'Google Calendar', 'https://calendar.google.com', 'calendar.google.com', 'Produtividade'),
  entry('google-drive', 'Google Drive', 'https://drive.google.com', 'drive.google.com', 'Produtividade'),
  entry('zoom', 'Zoom', 'https://app.zoom.us/wc', 'app.zoom.us', 'Produtividade'),
  entry('github', 'GitHub', 'https://github.com', 'github.com', 'Produtividade'),
  entry('figma', 'Figma', 'https://www.figma.com/files', 'www.figma.com', 'Produtividade'),
  entry('canva', 'Canva', 'https://www.canva.com', 'www.canva.com', 'Produtividade'),
  entry('spotify', 'Spotify', 'https://open.spotify.com', 'open.spotify.com', 'Mídia'),
  entry('youtube', 'YouTube', 'https://www.youtube.com', 'www.youtube.com', 'Mídia'),
  entry('twitch', 'Twitch', 'https://www.twitch.tv', 'www.twitch.tv', 'Mídia'),
  entry('reddit', 'Reddit', 'https://www.reddit.com', 'www.reddit.com', 'Mídia')
]

export function findCatalogEntry(id: string): CatalogEntry | undefined {
  return CATALOG.find((item) => item.id === id)
}
