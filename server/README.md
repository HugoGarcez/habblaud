# Servidor do CodeTown

Node puro (sem dependências de runtime). Observa as sessões **abertas** do Claude Code em todas as
contas da máquina, mantém o modelo do escritório e transmite tudo via SSE.

```
npm run dev      # servidor + Vite (middleware, HMR) em http://127.0.0.1:4747
npm run build && npm start   # produção: serve dist/client
```

## Fontes de dados (somente leitura)

| O quê | Onde |
| --- | --- |
| Sessões abertas e status (ocupado/ocioso/esperando) | `<config>/sessions/<pid>.json` (+ PID vivo, fora do Docker) |
| Atividades, tarefas, título, números | `<config>/projects/<cwd>/<sessionId>.jsonl` (lê o último ~1 MB no boot; o começo em segundo plano) |
| Subagentes (inclusive de workflows) | `<config>/projects/<cwd>/<sessionId>/subagents/**/agent-*.jsonl` + `.meta.json` |
| Conta (e-mail, organização) e cache de uso | `~/.claude.json` (conta padrão) ou `<config>/.claude.json` — só esses campos |
| Uso ao vivo (5h e semanal) | `~/.codetown/usage/<conta>.json`, gravado pelo `scripts/statusline-tap.mjs` (`npm run usage:install`) |
| Atalho da conta (`c`, `d`...) | linhas `alias x='... claude ...'` de `~/.zshrc`, `~/.bashrc`, `~/.zprofile`, `~/.bash_profile` |

**Forks** (subagentes que herdam o contexto do pai): o transcript começa com uma linha `fork-context-ref`, a
cópia da chamada `Agent` do pai (mesmo `tool_use` id do `.meta.json`) e o resultado dela ("Fork started…") junto
com a instrução do fork. O parser ignora essa cópia — senão o resultado herdado parece o fim do subagente e o fork
nunca entra no escritório — e usa o texto depois de `</fork-boilerplate>` como o pedido dele.

## Esperando o shell

O status `shell` (ver `shared/types.ts`) é o agente que terminou o turno com comando(s) rodando em segundo
plano. Vem do registro (`"status": "shell"`, Claude Code 2.1.292+, que não conta monitores); em versões que
não gravam `shell`, registro `idle` + Bash em segundo plano sem notificação há menos de 12 h vira `shell`.

`sources/shells.ts` rastreia, por sessão (principal e subagentes), os `ShellJob` publicados em `AgentInfo.shells`:
Bash com `run_in_background` (o id passa a ser o `backgroundTaskId` do tool_result), Bash em primeiro plano ainda
sem resultado (`background: false`; some do lugar enquanto a sessão espera aprovação) e `Monitor` (`kind: 'monitor'`).
Término: `<task-notification>` (linha `queue-operation`/`enqueue`, mensagem user ou anexo) casando `task-id` ou
`tool-use-id`; `TaskStop`/`KillShell`/`KillBash`; fim de turno/interrupção (primeiro plano); `/clear` ou sessão
encerrada; jobs anteriores ao processo atual (sessão retomada) ou com mais de 24 h. O fim de um shell em segundo
plano vira a atividade `tool: 'ShellDone'` (`error` = falhou/interrompido; o mundo comemora ou lamenta) e um aviso;
enquanto o status é `shell`, o balão é "⏳ Esperando o shell: <rótulo>" (`tool: 'ShellWait'`).

## GitHub no escritório

`sources/github.ts` acha eventos do GitHub nos transcripts, sem token e sem rede (funciona no Docker): o parser guarda as
chamadas que interessam (Bash com `git push`/`gh pr create|merge|checks`/`gh run watch|view`/`gh release create`, já sem
heredocs e com os encadeamentos separados, e ferramentas de servidores MCP do GitHub) e lê o resultado delas:

- **fonte preferida:** `toolUseResult.gitOperation`, gravado pelo próprio Claude Code (`{pr: {number, url, action:
  'created'|'merged'}, push: {branch}}`);
- **saída do comando:** URL `…/pull/<n>` do `gh pr create`; `gh pr merge` sem erro nem sinal de falha (e sem `--auto`);
  linhas `abc..def  main -> main` / `* [new branch]` depois de `To <remoto>`; cabeçalho `✓|X <branch> <workflow> · <id>`
  ou `completed with '<conclusão>'` de `gh run watch|view`, `--json`/`--jq` com a conclusão, `gh pr checks` (tabs, resumo
  ou `--json`; pendente não conta); URL `…/releases/tag/<tag>` do `gh release create` (rascunho não conta); JSON do MCP;
- **código de saída:** `gh run watch --exit-status` ou `gh pr checks` como último comando, sem pipe (senão o código é de
  outro programa) — em primeiro plano ("Exit code N") ou em segundo plano (resumo da `<task-notification>`). ≥ 128
  (morto) e 8 (`gh pr checks` pendente) não contam.

Comando com erro, bloqueado ou interrompido não gera evento (só o CI vermelho usa o erro). O sinal `github` vira
`Office.githubEvent`: atividade `tool: 'GitHub'` (`shared/github.ts`) e, só ao vivo (nunca na carga inicial nem para
linhas com mais de 2 min), aviso e efeito na sala, publicado em `RoomInfo.effect` (`{kind: 'party'|'alarm', text, at,
until, agentId}`): festa (PR aberto/mergeado, release) por 12 s; alarme (CI vermelho) até um CI verde na sala (que vira
festa) ou 10 min. Push só avisa. O mesmo CI visto de novo em 2 min não repete o aviso.

## API

| Rota | Descrição |
| --- | --- |
| `GET /api/stream` | SSE: eventos `snapshot`, `feed`, `notice` (ver `shared/types.ts`); ping a cada 15 s |
| `GET /api/snapshot` | `OfficeSnapshot` atual |
| `GET /api/agents/:id` | `AgentDetail` (histórico de até 200 atividades) |
| `GET /api/agents/:id/terminal` | SSE do terminal somente leitura: eventos `init` e `append` (`TerminalMessage`); só com bind local (ver abaixo) |
| `GET /api/health` | `{ok, version, demo, docker, terminal, sources, accounts:[{id, usageStatus}]}` |
| `POST /api/demo` | `{enabled: boolean}` liga/desliga agentes simulados (misturados aos reais) |

O snapshot (SSE e `GET /api/snapshot`) leva só as últimas 8 atividades de cada agente em `recent`; o histórico
de até 200 (inclusive o começo de transcripts longos, lido em segundo plano) vem de `GET /api/agents/:id`.

Borda (`http/guard.ts`, vale para API, estáticos e Vite): `Host` precisa ser `localhost`/`*.localhost`, um IP
ou um nome de `CODETOWN_ALLOWED_HOSTS` (contra DNS rebinding) → senão 403; `POST` em `/api/*` exige
`Content-Type: application/json` (415) e `Origin` da mesma origem ou local (403), contra CSRF. Respostas JSON
saem com `nosniff` e `Cross-Origin-Resource-Policy: same-origin`, sem CORS.

## Terminal somente leitura

`GET /api/agents/:id/terminal` (`http/terminal.ts`) transmite a conversa da sessão — prompts, respostas,
ferramentas e resultados, como o Claude Code mostra — montada do transcript por `sources/terminal.ts`, com
segredos mascarados e textos truncados. Ao conectar (e a cada reconexão) vem um `init` com as últimas 500
entradas dos ~4 MB finais do transcript (`truncated: true` se ficou conversa de fora); depois, polling de 400 ms
manda `append` com as entradas novas. Transcript truncado/substituído ou trocado (`/clear` no mesmo processo) =
`init` de novo; arquivo sumido = continua tentando. Agentes do demo não têm transcript: a conversa fictícia sai
de `shared/demo/terminal.ts` (atualizada a cada 500 ms). Ping a cada 15 s, no máximo 8 terminais ao mesmo tempo,
cliente com mais de 8 MB acumulados é desconectado.

O recurso só existe com **bind local** (`config.ts`, `terminalOffReason`), já que mostra a conversa inteira:

- Node: `CODETOWN_HOST` loopback (127.0.0.0/8, `::1`, `localhost`); `0.0.0.0`, `::` ou IP de rede desligam;
- Docker: o processo sempre escuta em `0.0.0.0` dentro do container, então vale a porta publicada no host,
  `CODETOWN_BIND` (o `docker-compose.yml` repassa o mesmo valor ao container): loopback liga; ausente, vazia ou
  qualquer outra desliga;
- `CODETOWN_TERMINAL=0` desliga sempre; nenhuma variável liga o terminal com a porta exposta.

Além disso, cada requisição precisa de `Host` local (`localhost`, `*.localhost`, 127.x ou `[::1]`): IPs da rede e
nomes de `CODETOWN_ALLOWED_HOSTS` (proxies, túneis) recebem 403. O estado sai em `meta.terminal` do snapshot e em
`terminal` no `/api/health`. Erros antes do stream respondem JSON `{error}`: 403 (desligado ou acesso que não é
local), 404 (agente ou transcript desconhecido), 405 (método que não é `GET`), 429 (terminais demais) e 500
(transcript ilegível).

Estáticos (`http/static.ts`): `/bundle/*` (saída do Vite com hash, `build.assetsDir`) com cache `immutable` de
1 ano; o resto (`index.html`, `client/public` em `/assets/*`) com `no-cache` + `ETag`/`Last-Modified` (304).

## Variáveis de ambiente

| Variável | Padrão | Uso |
| --- | --- | --- |
| `CODETOWN_PORT` | `4747` | porta HTTP |
| `CODETOWN_HOST` | `127.0.0.1` | interface (o Docker usa `0.0.0.0`); fora do loopback, o terminal somente leitura fica desligado |
| `CODETOWN_BIND` | — (Compose: `127.0.0.1`) | só Docker: interface do host onde a porta é publicada, repassada ao container; só loopback liga o terminal somente leitura |
| `CODETOWN_TERMINAL` | — | `0` desliga o terminal somente leitura (não liga com a porta exposta) |
| `CODETOWN_CLAUDE_DIRS` | — | config dirs separados por vírgula; substitui a detecção (`~/.claude*` com `projects/` ou `sessions/` + `CLAUDE_CONFIG_DIR`) |
| `CODETOWN_DATA_DIR` | `~/.codetown` (Docker: `/data`) | estado do CodeTown (nomes persistidos em `names.json`) |
| `CODETOWN_DEMO` | desligado | `1` liga o modo demonstração ao iniciar |
| `CODETOWN_IN_DOCKER` | auto (`/.dockerenv`) | `1` = não confere PIDs (são do host) |
| `CODETOWN_ACCOUNTS` | — | JSON com metadados das contas vindos do host (Docker): `[{id, configDir, mountDir, short, name, email, organization, plan, color, cachedUsage}]`, casados por `id`, `mountDir` ou `configDir` |
| `CODETOWN_USAGE_DIR` | `~/.codetown/usage` (Docker: `/usage`) | pasta do uso capturado pelo tap de statusline, relida a cada 5 s |
| `CODETOWN_ALLOWED_HOSTS` | — | nomes extras aceitos no `Host`/`Origin` (vírgula); `localhost`, `*.localhost` e IPs sempre valem |

## Uso do plano (5h e semanal)

Duas fontes, ambas arquivos locais (nada de credenciais nem chamadas de rede); vale a de números mais recentes
(`fetchedAt`):

- `statusline` (**recomendada**, `accounts/statusline.ts`): o Claude Code envia ao comando de statusline um JSON
  com `rate_limits` (`five_hour`/`seven_day`: `used_percentage` e `resets_at` em segundos). O
  `scripts/statusline-tap.mjs`, instalado na frente do statusline de cada conta por `npm run usage:install`,
  grava só esses números em `~/.codetown/usage/<conta>.json` (casado com a conta pelo `configDir`; senão pelo
  `accountId`);
- `cache`: o `cachedUsageUtilization` que o próprio Claude Code grava ao rodar `/usage`, relido a cada 60 s.

Sem nenhuma das duas, a conta fica `disabled` ("sem dados de uso"). Números com mais de 30 min aparecem como
`stale`. Uma janela cujo reinício já passou desde a coleta é omitida (a interface mostra "—") até chegarem
números novos — nunca um 0% inventado.

## Estrutura

- `config.ts`, `log.ts`, `index.ts` — configuração, logs curtos (nunca conteúdo de conversas) e entrada.
- `accounts/` — detecção de contas (`detect.ts`, também usado pelo `docker-up`), uso (`usage.ts`), tap de statusline (`statusline.ts`), serviço (`service.ts`).
- `sources/` — registro de sessões, leitura incremental (`tail.ts`), parser de transcripts (atividades em `transcript.ts`; conversa do terminal em `terminal.ts`; eventos do GitHub em `github.ts`), subagentes e o orquestrador (`watcher.ts`).
- `model/` — escritório (`office.ts`), salas/slots (`rooms.ts`), nomes persistidos (`names.ts`).
- `http/` — proteções de borda (`guard.ts`), rotas (`app.ts`), SSE (`sse.ts`), terminal somente leitura (`terminal.ts`), estáticos (`static.ts`).

Testes: `npx vitest run server shared` (fixtures sintéticas em `server/test/fixtures.ts`; os scripts do host —
tap de statusline, instalador e `docker-up` — são testados em `server/test/` com HOME e config dirs falsos).
