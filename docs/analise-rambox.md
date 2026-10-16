# Análise do Rambox (rambox.app)

> Nota: o acesso de rede deste sandbox está bloqueando `rambox.app` (política de rede do ambiente recusou a conexão). Esta análise foi feita a partir de conhecimento consolidado sobre o produto (é uma ferramenta madura e amplamente documentada), não de uma raspagem ao vivo do site. Se quiser validação 1:1 com a página atual, libere `rambox.app` em Network access do ambiente, ou cole aqui o conteúdo da home/pricing.

## 1. O que é

Rambox é um aplicativo **desktop (Electron)** que reúne dezenas/centenas de apps web (WhatsApp, Gmail, Slack, Telegram, Messenger, Discord, Outlook, Teams, Notion, Trello, etc.) dentro de uma única janela, cada um rodando como uma sessão isolada. Em vez de abrir 15 abas do navegador ou 15 apps separados, o usuário monta uma barra lateral com os serviços que usa e alterna entre eles com um clique.

Proposta de valor central: **"organize todos os seus apps de mensagem/produtividade em um só lugar, sem perder foco nem RAM com dezenas de abas abertas."**

## 2. Estrutura do produto

### 2.1 Conceito-chave: "Serviços" (Services)
- Um catálogo pré-configurado com centenas de apps conhecidos (cada um com ícone, URL padrão, nome).
- O usuário "adiciona" um serviço à sua barra lateral a partir desse catálogo, com busca por nome.
- Também é possível adicionar um **site customizado** (qualquer URL) como serviço genérico.
- É possível adicionar o **mesmo serviço mais de uma vez** (ex.: 2 contas de Gmail, 3 contas de WhatsApp), cada instância com sessão (cookies/local storage) completamente isolada — tecnicamente via partições de sessão separadas no Electron.

### 2.2 Workspaces (espaços de trabalho)
- Os serviços podem ser agrupados em "workspaces" nomeados (ex.: "Trabalho", "Pessoal", "Cliente X").
- Permite alternar o contexto inteiro (grupo de apps visíveis) em vez de cada app individualmente.

### 2.3 Sidebar / navegação
- Barra lateral vertical com ícones dos serviços adicionados.
- Drag-and-drop para reordenar.
- Badge de contagem de não lidos por serviço (agregado também no ícone do app na barra de tarefas/dock do SO).
- Atalhos de teclado para pular entre serviços (Ctrl/Cmd + número, Ctrl+Tab, etc.).
- Busca rápida / quick switcher para apps.

### 2.4 Notificações
- Notificações nativas do SO repassadas de cada serviço.
- Agregação de contador de não lidos (ex.: ícone na dock mostra "12" somando todos os apps).
- Modo "Não perturbe" (Do Not Disturb) global ou por serviço.
- Som de notificação configurável.

### 2.5 Gestão de recursos
- "Hibernar" serviços inativos (descarrega a sessão da memória depois de X minutos sem uso) para economizar RAM/CPU — ponto de dor real de apps como esse (Electron com muitas webviews consome muita memória).
- Opção de iniciar com o sistema operacional, iniciar minimizado na bandeja/tray.

### 2.6 Personalização por serviço
- Zoom por serviço.
- Corretor ortográfico (idioma configurável).
- Proxy configurável (global, e por serviço no plano pago).
- Injeção de CSS/JS customizado por serviço (recurso pago) — permite, por ex., forçar modo escuro em serviços que não suportam, ou remover elementos de distração.
- Mudar User-Agent.

### 2.7 Segurança / privacidade
- Bloqueio do app com senha mestre (lock screen).
- Armazenamento local criptografado (plano pago).
- Sessões isoladas por serviço (sandboxing via partições do Electron) — um serviço não vê cookies/local storage de outro.

### 2.8 Sincronização e colaboração (recursos pagos)
- Conta Rambox para sincronizar a configuração (lista de serviços, workspaces, ordem) entre vários computadores.
- **Rambox Teams/Business**: administrador define uma configuração padrão (conjunto de serviços obrigatórios) e distribui para a equipe; gestão centralizada, SSO, políticas.

### 2.9 Temas
- Tema claro/escuro da própria interface do Rambox (sidebar, menus), independente do conteúdo de cada serviço.

## 3. Modelo de monetização (freemium)

| Camada | Características típicas |
|---|---|
| **Free** | Todos os serviços do catálogo, mas com **anúncios** na interface, limite de contas abertas simultaneamente em alguns casos, sem recursos avançados (CSS/JS custom, criptografia local, ad-block). |
| **Pro** (assinatura mensal/anual, valor baixo, ~US$ 2–3/mês na faixa histórica) | Remove anúncios, libera instâncias ilimitadas de cada serviço, bloqueador de anúncios/trackers dentro dos serviços, CSS/JS customizado, criptografia de dados locais, senha mestra, sincronização entre dispositivos via conta. |
| **Business/Enterprise** | Gestão centralizada de configuração para times, políticas corporativas, suporte prioritário, faturamento por assento. |

Modelo é **open-core**: o Rambox Community Edition tem repositório open-source (Electron + React), e a Pro agrega serviço de nuvem (sync, licenciamento) e alguns recursos fechados.

## 4. Plataformas suportadas
- Windows (exe/msi), macOS (dmg, Intel + Apple Silicon), Linux (deb, rpm, AppImage, snap).
- Não há versão mobile — é um produto estritamente desktop.

## 5. Stack técnica (conhecida publicamente)
- **Electron** como shell desktop multiplataforma.
- Front-end em **React** (versões mais recentes) — versões antigas usavam outras libs.
- Cada serviço roda em um **`<webview>` / `BrowserView`** com `partition` própria (`persist:<serviceId>-<instanceId>`) para isolar cookies e local storage.
- "Recipes" (receitas) por serviço: pequenos scripts/configurações (URL, seletor de badge de não lido, user-agent recomendado, regras de bloqueio de popups) — é assim que escalam para centenas de serviços sem reescrever lógica para cada um.
- Armazenamento de config local em JSON/DB local (ex.: NeDB/lowdb em versões passadas).
- Auto-update via Electron (Squirrel/electron-updater).

## 6. Pontos fortes (o que vale copiar)
1. **Catálogo grande + busca** — baixa fricção para adicionar um app nunca visto antes.
2. **Isolamento de sessão por serviço/instância** — permite múltiplas contas do mesmo serviço sem logout/login.
3. **Hibernação de apps inativos** — resposta direta ao maior ponto fraco da categoria (consumo de memória).
4. **Notificação agregada** — um só badge no ícone do SO em vez de N apps gritando notificação.
5. **Workspaces** — útil para quem separa contextos (trabalho/pessoal/projetos).
6. **Simplicidade de interface** — sidebar fina + área de conteúdo cheia, sem curva de aprendizado.
7. **Modelo freemium honesto** — free já é funcional (todos os apps), paywall é conveniência/escala, não funcionalidade básica.

## 7. Pontos fracos / oportunidades de diferenciação para o Deskbox
1. **Consumo de memória** ainda é alto mesmo com hibernação (Electron + N webviews). Oportunidade: hibernação mais agressiva por padrão, ou usar `BrowserView` com descarte real de processo, métricas de uso de RAM visíveis ao usuário por serviço.
2. **Anúncios no free** incomodam parte dos usuários — oportunidade: free mais limpo com um teto razoável (ex.: N serviços simultâneos) em vez de anúncios, se o modelo de negócio do Deskbox permitir.
3. **Falta de busca unificada de mensagens** entre serviços (cada app continua sendo uma ilha para busca de conteúdo).
4. **Sem automações/integrações** (ex.: regras tipo "quando chegar mensagem X no Slack, notificar diferente", ou webhooks).
5. **UI um pouco datada** em algumas versões — oportunidade de design mais moderno, atalhos de teclado mais ricos, "command palette" estilo VS Code/Raycast para pular entre apps e ações.
6. **Sem versão web/PWA** — Deskbox poderia oferecer uma versão PWA leve além do desktop, para quem não quer instalar nada.
7. **Backup/exportação de configuração** pouco visível — oportunidade de export/import simples em JSON e integração com dotfiles.

## 8. Resumo para briefing do Deskbox
Deskbox = um "hub" desktop (Electron ou alternativa mais leve como Tauri) que:
- mantém um catálogo de serviços populares + opção de site customizado;
- isola cada serviço/instância em sessão própria;
- organiza em sidebar + workspaces;
- agrega notificações e permite hibernar apps ociosos para economizar recursos;
- tem tema claro/escuro, atalhos de teclado e busca rápida entre apps;
- segue modelo freemium: free funcional e completo nos recursos essenciais, pago destrava conveniência (sync entre dispositivos, CSS/JS custom, instâncias ilimitadas, times/empresas).
