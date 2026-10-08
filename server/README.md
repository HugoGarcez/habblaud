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
| `GET /api/sessions/recent` | `RecentSessionsResponse`: sessões dos últimos 7 dias de todas as contas (até 150); mesma trava do terminal |
| `GET /api/sessions/:conta/:sessionId/terminal` | SSE da conversa de uma sessão do histórico (mesmo protocolo do terminal); mesma trava |
| `GET /api/stats?day=AAAA-MM-DD&tz=<IANA>&source=real\|demo` | `DayStatsResponse` do "Meu dia" (ver abaixo); padrões: hoje, fuso do servidor, demo se ligado e o dia é hoje |
| `GET /api/stats/days?tz=<IANA>` | `StatsDaysResponse`: dias com dados reais (e do demo, se ligado), mais recente primeiro |
| `GET /api/timeline/days` | `{recording, days:[{day, bytes, from, to}]}`: dias gravados para o timelapse, do mais recente ao mais antigo |
| `GET /api/timeline/:dia` | o arquivo do dia (`AAAA-MM-DD`) em JSONL (`application/x-ndjson`, gzip se aceito); 400 para dia inválido, 404 sem gravação |
| `GET /api/health` | `{ok, version, demo, docker, terminal, permissions, updates:{state, latest, available}, sources, accounts:[{id, usageStatus}]}` |
| `POST /api/demo` | `{enabled: boolean}` liga/desliga agentes simulados (misturados aos reais) |
| `GET /api/mod/summary?account=&session=` | `ModSummary` para o mod do Claude Code: `{version, agents, working, waiting:[{id, name, room, account, waitingFor, since, answerable}]}`, sem o demo e sem a sessão de quem pergunta (ver abaixo) |
| `GET /api/updates` | `{version, ...UpdateStatus}`: versão em uso e o resultado da verificação de versão nova (ver abaixo) |
| `POST /api/updates/check` | "Verificar agora": consulta o GitHub (no máximo uma vez a cada 30 s) e devolve `{version, ...UpdateStatus}` |
| `POST /api/permissions` | (hook) registra um pedido de permissão: `201 {id, expiresAt}` ou `200 {skip}`; só com bind local (ver abaixo) |
| `GET /api/permissions/:id/wait` | (hook) long-poll de até 25 s (`?timeout=` em segundos): `{status: 'pending' \| 'decided' \| 'released', ...}` |
| `GET /api/permissions/:id` | (página) detalhe do pedido com os argumentos (`PermissionRequestInfo` com `input`) |
| `POST /api/permissions/:id/decision` | (página) `PermissionDecision`: `{behavior: 'allow' \| 'deny' \| 'terminal', message?, interrupt?, suggestion?}` |

O snapshot (SSE e `GET /api/snapshot`) leva só as últimas 8 atividades de cada agente em `recent`; o histórico
de até 200 (inclusive o começo de transcripts longos, lido em segundo plano) vem de `GET /api/agents/:id`.

Borda (`http/guard.ts`, vale para API, estáticos e Vite): `Host` precisa ser `localhost`/`*.localhost`, um IP
ou um nome de `CODETOWN_ALLOWED_HOSTS` (contra DNS rebinding) → senão 403; `POST` em `/api/*` exige
`Content-Type: application/json` (415) e `Origin` da mesma origem ou local (403), contra CSRF. Respostas JSON
saem com `nosniff` e `Cross-Origin-Resource-Policy: same-origin`, sem CORS.

## Versão nova

`updates/checker.ts` consulta `GET https://api.github.com/repos/<dono>/<nome>/releases/latest`, sem token, 5 s depois
de subir e depois a cada 6 h (1 h depois de uma falha). O repositório vem do campo `repository` do `package.json`
(um fork só precisa trocar esse campo). A consulta manda `If-None-Match` com o ETag da anterior, porque a resposta
304 não gasta o limite de 60 consultas por hora sem token. O resultado (`repo`, `checkedAt`, `etag`, `latest`, `url`,
`publishedAt`) fica em `<dataDir>/updates.json`, para um reinício não repetir a consulta antes da hora. A tag precisa
seguir o semver (`v1.2.3` ou `1.2.3-beta.1`) e é comparada com a versão do `package.json`. Respostas: 404 = nenhuma
release (`ok` sem `latest`); 403/429 = limite do GitHub (`error`). Numa falha, a última release conhecida continua
valendo. O status vai no snapshot em `meta.updates` (`UpdateStatus` em `shared/types.ts`) e, quando muda, o snapshot é
republicado. O link da release só passa se for do próprio repositório no GitHub. Uma versão nova encontrada é
avisada uma vez no log. `CODETOWN_UPDATE_CHECK=0` desliga (`state: 'off'`, nenhuma consulta).

Cada versão tem a sua seção no `CHANGELOG.md`; um teste falha se a versão do `package.json` não tiver seção, e o
`npm run release` (`scripts/release.ts`) cria a tag e a release com o texto dela como notas.

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

## Linha do tempo (timelapse)

`history/timeline.ts` grava o escritório para o timelapse do cliente em `<CODETOWN_DATA_DIR>/timeline/AAAA-MM-DD.jsonl`
(dia local do servidor; no Docker, `/data/timeline`). Formato e reconstrução em `shared/timeline.ts`; um registro por linha:

- `{"t":"k", at, v, every, boot?, rooms, agents, accounts}`: **keyframe**, o estado completo. Abre cada arquivo, se
  repete a cada 5 min (`every`) e marca o boot do servidor;
- `{"t":"d", at, rooms?, agents?, accounts?}`: **delta**, só o que mudou (`[id, objeto | null]` para salas e contas;
  `[id, campos alterados | null]` para agentes, com `null` = campo ou agente que saiu);
- `{"t":"end", at, reason?}`: o servidor parou (`SIGTERM`/`SIGINT`) ou o dia chegou ao limite (`reason: "limit"`).

Entra cada snapshot novo do `Hub` (`hub.onSnapshot`, ou seja, cada commit do `Office` com mudança), com throttle de
1 s e só quando muda algo que o player desenha. Por agente: id, kind, parentId, sala, nome, look, papel, conta,
status (com `statusSince`), waitingFor, atividade (`kind`, `icon`, `text`, `at`, `tool`, `error`), semente,
background, título e shells resumidos (sem o comando); agentes, salas e contas do modo demonstração (`demo:`) levam
`demo: true`. Contas sem e-mail, organização nem pasta. Nada de transcript: é a mesma exposição do `/api/snapshot`,
por isso as rotas valem com qualquer bind.

- **Limites:** acima de 20 MB no dia, delta a cada 15 s e keyframe a cada 15 min; acima de 30 MB, para até a virada.
- **Retenção:** os últimos 7 dias (contando hoje); só arquivos `AAAA-MM-DD.jsonl` são apagados.
- **Falhas de disco:** nunca derrubam o servidor: um aviso no log, nova tentativa em 1 min, recomeçando com keyframe.
- **Lacunas:** sem nenhum registro por mais de ~1,5× `every` (ou depois de um `end`), o player mostra "sem dados".
- `CODETOWN_TIMELINE=0` desliga a gravação (as rotas continuam servindo os dias gravados).

O dia na URL só é aceito como `AAAA-MM-DD` de uma data válida e o caminho do arquivo é montado só a partir dele
(nada de `..`, barras codificadas ou bytes nulos). `scripts/demo-timeline.ts` (`npm run demo:timeline`) usa o mesmo
gravador, com relógio simulado e o `DemoSimulator`, para gerar dias inteiros só com dados fictícios.
## Meu dia (estatísticas do dia)

`history/daystats.ts` amostra o snapshot do escritório a cada 1 s e passa os agentes ao rastreador puro de
`shared/daystats.ts`, que integra, por agente, o tempo desde a amostra anterior no status em que ele estava
(`working`, `waiting`, `shell`, `idle`; `done` e `offline` não contam), partindo o intervalo em `statusSince`.
Intervalos de mais de 2 min entre amostras (servidor parado, computador dormindo) não contam. Esperas por você são
episódios de `waiting` contínuo (os de menos de 3 s ficam de fora do ranking); "tempo de relógio com alguém
esperando" une os intervalos de todos os agentes.

- **Contagens:** `AgentStats` é cumulativo por agente, então conta o que passa do maior valor já visto (releitura de
  transcript regravado não conta de novo). Agente que já existia (boot, `/resume`) vira linha de base nos primeiros
  20 s (90 s no boot, enquanto o começo dos transcripts longos é lido em segundo plano); subagente que nasce durante a
  observação e sessão nova (ou `/clear`) contam do zero. Salto impossível numa amostra (mais de 60 ferramentas ou 5 M
  de tokens) é tratado como releitura. Custo que aparece num agente antigo é o total da sessão: só vira referência.
  Prompts saem das atividades `prompt` posteriores ao início do servidor; tarefas, do que sobe no nº de concluídas.
  Agente que some e volta mantém a linha de base por 6 h.
- **Baldes de 1 hora alinhados em UTC** (por sala, por conta e quem esteve presente: sessões e subagentes), guardados
  por dia de arquivo no fuso do servidor. O dia pedido é montado na consulta, no fuso `tz` do navegador: no Docker
  (UTC) o dia do painel continua começando à meia-noite do usuário.
- **Arquivos:** `<dataDir>/stats/AAAA-MM-DD.json` (`StatsDayFile`, versão 1), gravados a cada 30 s e ao encerrar
  (temporário + `rename`); no boot carrega ontem e hoje, indexa os demais e apaga os de mais de 30 dias (de novo a
  cada virada do dia). Arquivo ilegível vira `.corrupt` e o dia recomeça; erros de disco só geram aviso no log.
- **Demo:** agentes com id `demo:` nunca entram nos dados reais. Com o demo ligado há um balde separado, só em
  memória, semeado com um histórico fictício de ontem até agora (`shared/demo/daystats.ts`) e alimentado ao vivo.
- **Exposição:** só números agregados e nomes de projeto, conta e agente (o mesmo que o `/api/snapshot`), então a rota
  não tem a trava de bind local do terminal. Erros: 400 (`day` fora do formato `AAAA-MM-DD`, data inexistente, dia no
  futuro, parâmetro repetido, `tz` ou `source` inválidos), 404 (sem dados, fora da retenção ou demo desligado), 405.

Estáticos (`http/static.ts`): `/bundle/*` (saída do Vite com hash, `build.assetsDir`) com cache `immutable` de
1 ano; o resto (`index.html`, `client/public` em `/assets/*`) com `no-cache` + `ETag`/`Last-Modified` (304).

## Histórico de sessões

`sources/history.ts` lista, sob demanda, os transcripts de primeiro nível `<config>/projects/*/<sessionId>.jsonl` de
cada conta (nome com formato de UUID; subagentes ficam de fora) modificados nos últimos 7 dias, os 150 mais recentes.
De cada arquivo lê só os primeiros 64 KB (projeto = `cwd` da primeira linha que o traz, primeira atividade, o primeiro
prompt) e os últimos 64 KB (título e última atividade; sem nenhuma linha de título ali, procura nos últimos 512 KB),
com leitura assíncrona e um cache por caminho válido enquanto mtime e tamanho não mudam. O título segue o do agente
(`custom-title`/`custom-title.json` > `agent-name` > `ai-title` > `last-prompt`) e, sem nenhum, é o primeiro prompt.
Sessão aberta (agente principal da conta e do `sessionId` no escritório) sai com `open: true` e `agentId`; uma
encerrada sem nenhuma linha com horário é omitida. A lista sai da atividade mais recente para a mais antiga.

`GET /api/sessions/:conta/:sessionId/terminal` (`http/sessions.ts`) usa o mesmo leitor do terminal do agente
(`TerminalStreams.attachSession`: `init` com as últimas 500 entradas dos ~4 MB finais, depois `append`, com polling de
2 s para o caso de a sessão ser retomada) e conta no limite de 8 terminais. Validação: a conta precisa ser uma das
conhecidas (404), o id precisa ter formato de UUID (400) e o arquivo, com links resolvidos (`realpath`), precisa ficar
dentro da pasta `projects/` da conta (404); segmentos que não decodificam respondem 400. As duas rotas exigem a mesma
trava do terminal (recurso ligado e `Host` local, senão 403) e só aceitam `GET` (a lista, também `HEAD`; senão 405).
## Responder pelo escritório

O hook `PermissionRequest` do Claude Code (`mod/codetown-permissoes/hooks/permission-hook.mjs`, com `matcher: "*"`:
pelo plugin `codetown-permissoes` no Claude Code 2.1.287+ ou instalado em `<conta>/settings.json` por
`npm run hooks:install`) roda **junto** com o diálogo de permissão do terminal: vale o que
responder primeiro. Em subagentes em segundo plano o Claude Code roda o hook antes e só mostra o diálogo depois que
ele sai. O hook manda o pedido (`session_id`, `agent_id`/`agent_type`, `cwd`, `tool_name`, `tool_input` com textos
cortados, `permission_suggestions` e o próprio `timeout_ms`) e espera; com `decided` imprime
`hookSpecificOutput.decision` (`allow`, com `updatedPermissions` = a sugestão original escolhida, ou `deny` com
`message`/`interrupt`); com `released`, erro ou tempo esgotado sai sem imprimir nada (vale o terminal).
`AskUserQuestion` não é desviado.

`permissions/registry.ts` (`PermissionRegistry`):

- só aceita o pedido com alguma página conectada por `Host` local (`Hub.localSize`) e com a sessão conhecida
  (principal pelo `session_id`; subagente por `<session_id>:<agent_id>`, ou o principal com `subagent` = tipo);
  senão `{skip: 'no-viewers' | 'unknown-session' | 'unsupported-tool' | 'too-many'}` (máx. 32 abertos);
- publica o pedido mais antigo de cada agente em `AgentInfo.permission` (sem `input`, que só sai pelo detalhe;
  `queued` = quantos esperam depois) e põe o agente como `waiting`; atividade `PermissionRequest` no feed e aviso
  "pede permissão" (dedupe do "precisa de você"); aprovar/recusar viram atividades também;
- libera o hook (`released`) quando: `terminal` na página, tempo limite do hook + 5 s (`expired`), nenhum hook
  esperando por 8 s (`orphan`), agente que saiu (`gone`) ou resposta no próprio terminal (`answered`): o Claude Code
  não encerra o hook quando você responde lá, então o registro acha a chamada no fim do transcript
  (`permissions/transcript.ts`: nome + assinatura dos argumentos, a mais recente sem resultado) e espera o
  `tool_result` dela; sem a chamada, um principal que esteve `waiting` no registro de sessões e saiu dele há 3 s;
- decisões não buscadas ficam guardadas por 30 s; pedidos do demo (`demo:perm-…`) vão para o simulador.

As rotas (`permissions/http.ts`) seguem a trava do terminal somente leitura: sem `ServerConfig.terminal` → 403 em
todas; `Host` que não é local → 403. O guard já exige JSON e `Origin` local nos `POST`. Erros: 400 (corpo ou
sugestão inválidos), 404 (pedido desconhecido, já entregue ou expirado), 405, 409 (já respondido).

## Variáveis de ambiente

| Variável | Padrão | Uso |
| --- | --- | --- |
| `CODETOWN_PORT` | `4747` | porta HTTP |
| `CODETOWN_HOST` | `127.0.0.1` | interface (o Docker usa `0.0.0.0`); fora do loopback, o terminal somente leitura fica desligado |
| `CODETOWN_BIND` | — (Compose: `127.0.0.1`) | só Docker: interface do host onde a porta é publicada, repassada ao container; só loopback liga o terminal somente leitura |
| `CODETOWN_TERMINAL` | — | `0` desliga o terminal somente leitura (não liga com a porta exposta) |
| `CODETOWN_CLAUDE_DIRS` | — | config dirs separados por vírgula; substitui a detecção (`~/.claude*` com `projects/` ou `sessions/` + `CLAUDE_CONFIG_DIR`) |
| `CODETOWN_DATA_DIR` | `~/.codetown` (Docker: `/data`) | estado do CodeTown (nomes persistidos em `names.json`, linha do tempo em `timeline/`, estatísticas do Meu dia em `stats/`, última verificação de versão em `updates.json`) |
| `CODETOWN_TIMELINE` | ligado | `0` desliga a gravação da linha do tempo do timelapse |
| `CODETOWN_UPDATE_CHECK` | ligado | `0` desliga a verificação de versão nova (releases do repositório do `package.json` no GitHub, a cada 6 h) |
| `CODETOWN_DEMO` | desligado | `1` liga o modo demonstração ao iniciar |
| `CODETOWN_IN_DOCKER` | auto (`/.dockerenv`) | `1` = não confere PIDs (são do host) |
| `CODETOWN_ACCOUNTS` | — | JSON com metadados das contas vindos do host (Docker): `[{id, configDir, mountDir, short, name, email, organization, plan, color, cachedUsage}]`, casados por `id`, `mountDir` ou `configDir` |
| `CODETOWN_USAGE_DIR` | `~/.codetown/usage` (Docker: `/usage`) | pasta do uso capturado pelo tap de statusline ou pelo mod do Claude Code, relida a cada 5 s |
| `CODETOWN_ALLOWED_HOSTS` | — | nomes extras aceitos no `Host`/`Origin` (vírgula); `localhost`, `*.localhost` e IPs sempre valem |

No hook de permissão (ambiente do Claude Code; os argumentos `--port`/`--timeout` gravados pelo instalador têm
preferência): `CODETOWN_PORT` (porta do CodeTown, padrão `4747`), `CODETOWN_PERMISSION_TIMEOUT` (segundos de espera
pela resposta no CodeTown, padrão `300`, entre 5 e 1800) e `CODETOWN_HOOK_DEBUG=1` (conta no stderr o que fez).

## Uso do plano (5h e semanal)

Duas fontes, ambas arquivos locais (nada de credenciais nem chamadas de rede); vale a de números mais recentes
(`fetchedAt`):

- `statusline` (**recomendada**, `accounts/statusline.ts`): o Claude Code envia ao comando de statusline um JSON
  com `rate_limits` (`five_hour`/`seven_day`: `used_percentage` e `resets_at` em segundos). O
  `scripts/statusline-tap.mjs`, instalado na frente do statusline de cada conta por `npm run usage:install`,
  grava só esses números em `~/.codetown/usage/<conta>.json` (casado com a conta pelo `configDir`; senão pelo
  `accountId`). No Claude Code 2.1.287+ o mod do CodeTown grava o mesmo arquivo (ver abaixo);
- `cache`: o `cachedUsageUtilization` que o próprio Claude Code grava ao rodar `/usage`, relido a cada 60 s.

Sem nenhuma das duas, a conta fica `disabled` ("sem dados de uso"). Números com mais de 30 min aparecem como
`stale`. Uma janela cujo reinício já passou desde a coleta é omitida (a interface mostra "—") até chegarem
números novos — nunca um 0% inventado.

## Mod do Claude Code

O repositório é também um marketplace de plugins do Claude Code (`.claude-plugin/marketplace.json`, detalhes em
[`mod/README.md`](../mod/README.md)). Do lado do servidor, o mod `codetown` usa duas coisas:

- **o arquivo de uso:** em cada `session.start` e `session.measure` ele grava `<CODETOWN_USAGE_DIR>/<conta>.json`
  no formato do tap (`{accountId, configDir, fetchedAt, five_hour, seven_day}`, `resets_at` em segundos, a partir de
  `$.session.usage().rateLimits`) mais `source: "mod"`, que o leitor ignora: para o servidor continua sendo a fonte
  `statusline`. O mod escreve com `$.fs.write`, que não é atômico; por isso `StatuslineUsageReader` ignora uma
  leitura vazia ou pela metade, fica com o último registro bom daquele arquivo e o relê no ciclo seguinte;
- **`GET /api/mod/summary`** (`modSummary` em `http/app.ts`), perguntado a cada 5 s por sessão que desenha (30 s com
  o CodeTown fora do ar) e pelo comando `/codetown`: só contagens e quem espera, montado do snapshot atual. Ficam de
  fora os agentes do demo (que vivem só no snapshot, não no `Office`), quem já encerrou ou entregou e, com
  `?session=` (e `?account=`, se vier), a sessão de quem pergunta: o principal com esse `sessionId` e os subagentes
  dela (o `sessionId` deles é o da sessão que os disparou; por garantia, também quem tem um ancestral dela).
  `answerable` = há pedido de permissão para responder pelo escritório (`AgentInfo.permission`). Sem parâmetros,
  nada é excluído (é o que o `/codetown` usa, para os números baterem com a tela). Só `GET`/`HEAD` (senão 405).

## Estrutura

- `config.ts`, `log.ts`, `index.ts` — configuração, logs curtos (nunca conteúdo de conversas) e entrada.
- `accounts/` — detecção de contas (`detect.ts`, também usado pelo `docker-up`), uso (`usage.ts`), tap de statusline (`statusline.ts`), serviço (`service.ts`).
- `sources/` — registro de sessões, leitura incremental (`tail.ts`), parser de transcripts (atividades em `transcript.ts`; conversa do terminal em `terminal.ts`; eventos do GitHub em `github.ts`), subagentes, o histórico de sessões (`history.ts`) e o orquestrador (`watcher.ts`).
- `model/` — escritório (`office.ts`), salas/slots (`rooms.ts`), nomes persistidos (`names.ts`).
- `http/` — proteções de borda (`guard.ts`), rotas (`app.ts`), SSE (`sse.ts`), terminal somente leitura (`terminal.ts`) e o histórico dele (`sessions.ts`), timelapse (`timeline.ts`), Meu dia (`stats.ts`), estáticos (`static.ts`).
- `history/` — gravador da linha do tempo do timelapse (`timeline.ts`) e as estatísticas do Meu dia: amostragem, persistência e retenção (`daystats.ts`; o acumulador puro fica em `shared/daystats.ts`).
- `permissions/` — responder pelo escritório: registro dos pedidos (`registry.ts`), rotas (`http.ts`) e a busca da chamada no transcript (`transcript.ts`).
- `updates/` — verificação de versão nova nas releases do GitHub (`checker.ts`).

Testes: `npx vitest run server shared` (fixtures sintéticas em `server/test/fixtures.ts`; os scripts do host —
tap de statusline, hook de permissão (rodado como processo contra um servidor de teste), instaladores e
`docker-up` — são testados em `server/test/` com HOME e config dirs falsos).
