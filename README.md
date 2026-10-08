<p align="center">
  <img src="client/public/assets/brand/logo-mark@4x.png" width="96" alt="Logo do CodeTown: um pequeno prédio em pixel art" />
</p>

<h1 align="center">CodeTown</h1>

<p align="center">
  <b>O escritório virtual dos seus agentes do Claude Code.</b><br />
  Cada projeto vira uma sala, cada agente vira um personagem em pixel art que mostra, em tempo real, o que está fazendo.
</p>

<p align="center">
  <img alt="Node.js 22.12+" src="https://img.shields.io/badge/node-%E2%89%A522.12-5fa04e?logo=node.js&logoColor=white" />
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-7-3178c6?logo=typescript&logoColor=white" />
  <img alt="Docker" src="https://img.shields.io/badge/Docker-pronto-2496ed?logo=docker&logoColor=white" />
  <img alt="Zero dependências de runtime" src="https://img.shields.io/badge/depend%C3%AAncias%20de%20runtime-0-f08a3c" />
  <img alt="Interface em português" src="https://img.shields.io/badge/interface-PT--BR-4aa8e8" />
</p>

<p align="center">
  <img src="docs/screenshots/office.gif" width="820" alt="Animação de uma sala do CodeTown: personagens digitando nas mesas, subagentes com crachá e balões de atividade" />
</p>

---

Você abre o Claude Code em vários projetos, dispara subagentes, deixa tarefas rodando… e perde a noção de quem está
fazendo o quê. O **CodeTown** transforma isso num escritório que dá para entender de relance: quem está digitando,
quem levantou a mão porque **precisa de você**, quem entregou o trabalho e foi embora, quem foi tomar um café
enquanto espera a próxima instrução — e quanto de cada conta você já gastou na sessão de 5 horas e na semana.

E quando dois ou mais agentes estão à toa, o escritório ganha **vida social**: cada um tem personalidade própria, e
eles veem futebol juntos no lounge, jogam videogame e ping-pong, fofocam na copa, se arrumam no espelho e apostam
moedinhas no jokenpô. Veja em [Vida social](#vida-social).

Tudo roda na sua máquina, lendo os arquivos que o próprio Claude Code já grava (e só as linhas `alias` do seu shell,
para dar a letra de cada conta). Nada sai do computador: o CodeTown não lê credenciais nem faz chamadas externas.

## Sumário

- [Como é](#como-é)
- [Instalação](#instalação)
- [Como usar](#como-usar)
- [Contas e uso (5 horas e semanal)](#contas-e-uso-5-horas-e-semanal)
- [Configuração](#configuração)
- [Como funciona](#como-funciona)
- [Privacidade e segurança](#privacidade-e-segurança)
- [Desenvolvimento](#desenvolvimento)
- [Solução de problemas](#solução-de-problemas)
- [Aviso](#aviso)
- [Licença](#licença)
- [Vida social](#vida-social)

## Como é

**Visão geral.** O prédio tem recepção com elevadores, copa, banheiros e lounge; cada projeto com uma sessão aberta
ganha a sua sala ao longo do corredor. No topo, os contadores e o uso de cada conta; à esquerda, as salas e os
agentes; embaixo, o feed de atividade.

![Visão geral do CodeTown: prédio com recepção, copa, banheiros, lounge e salas de projeto; barra lateral com salas e agentes; uso das contas no topo; feed de atividade embaixo](docs/screenshots/overview.png)

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/agent-details.png" alt="Gaveta de detalhes de um agente com tarefas, subagentes, linha do tempo e estatísticas" /></td>
    <td width="50%"><img src="docs/screenshots/night.png" alt="O escritório à noite, com postes acesos e salas iluminadas" /></td>
  </tr>
  <tr>
    <td><b>Detalhes do agente:</b> atividade atual, tarefas com progresso, subagentes, linha do tempo e estatísticas.</td>
    <td><b>Dia e noite:</b> o céu nas janelas e a iluminação seguem a hora local.</td>
  </tr>
</table>

<table>
  <tr>
    <td width="42%"><img src="docs/screenshots/collab.png" alt="Subagente entregando o resultado ao agente principal enquanto outra agente pede permissão" /></td>
    <td width="58%">
      <b>Colaboração à vista.</b> Subagentes são colegas com nome próprio e crachá: chegam pelo elevador, trabalham na
      sala do projeto e, ao terminar, vão até o agente que os chamou entregar o resultado (📦) antes de ir embora.<br /><br />
      <b>Precisa de você.</b> Quando um agente espera uma permissão ou resposta no terminal, ele corre para a mesa e
      levanta a mão, com um alerta piscando — e um aviso aparece na tela (opcionalmente com som e notificação do navegador).
    </td>
  </tr>
</table>

<table>
  <tr>
    <td width="58%">
      <b>Esperando o shell.</b> Quando o agente termina o turno mas deixa um comando rodando (testes, build,
      deploy…), ele não sai para passear: fica na mesa com uma ampulheta virando sobre a cabeça, o terminal mostrando
      o progresso e um balão com o comando e o tempo. E a espera vira comédia: primeiro ele come pipoca assistindo ao
      terminal; depois de 3 min cruza os braços e gira na cadeira; depois de 10 min junta teia de aranha; depois de
      25 min cochila. Quando o comando termina, levanta e comemora com confete — ou ganha uma nuvem de chuva, se
      falhou. Na lista lateral e nos detalhes, um cronômetro mostra há quanto tempo cada comando está rodando.
    </td>
    <td width="42%"><img src="docs/screenshots/shell-wait.png" alt="Agente comendo pipoca na mesa, com uma ampulheta sobre a cabeça e o balão 'Rodar a suíte de testes · 1 min'; na fileira da frente, uma colega espera há mais tempo, com teia de aranha na cadeira e o terminal mostrando o progresso" /></td>
  </tr>
</table>

**A luz apaga.** Quando você fecha a última sessão de um projeto, o último personagem vai até o interruptor,
apaga a luz, sai pelo elevador — e a sala é desmontada, virando jardim até um novo projeto chegar.

| 1. A sala é montada, ainda apagada | 2. Alguém acende a luz e todos trabalham | 3. O último sai e apaga a luz | 4. A sala vira jardim |
| --- | --- | --- | --- |
| ![Sala sendo montada, com os móveis aparecendo e a luz apagada](docs/screenshots/lifecycle-1.png) | ![Sala acesa com três agentes trabalhando nas mesas](docs/screenshots/lifecycle-2.png) | ![Sala com a luz apagada e os móveis ainda no lugar, depois que todos saíram](docs/screenshots/lifecycle-3.png) | ![O lote da sala transformado em jardim](docs/screenshots/lifecycle-4.png) |

<table>
  <tr>
    <td width="34%"><img src="docs/screenshots/mobile.png" alt="CodeTown no celular, com o uso das contas no topo" /></td>
    <td>
      <b>Também no celular.</b> A interface se adapta a telas pequenas: o uso das contas fica no topo, a lista de
      salas vira uma gaveta e os detalhes abrem de baixo para cima. Veja como liberar o acesso pela rede local em
      <a href="#abrir-no-celular-opcional">Abrir no celular</a>.
    </td>
  </tr>
</table>

> As imagens acima usam o **modo demonstração** (projetos, pessoas e contas fictícios).

## Instalação

### Requisitos

- **macOS** (testado) ou Linux.
- **[Claude Code](https://code.claude.com)** instalado, com uma ou mais contas.
- **Node.js 22.12+** e **npm** (desenvolvido com o Node 24; o Docker já usa o Node 24).
- **Docker Desktop** (ou Docker Engine com Compose v2), se for rodar em container.

### 1. Baixe o projeto

```bash
git clone https://github.com/marmottajr/codetown.git
cd codetown
npm install
```

> O `npm install` só baixa ferramentas de compilação (Vite, TypeScript, tsx…). O servidor do CodeTown não tem
> dependências de runtime: usa só módulos nativos do Node.

### 2. Suba o CodeTown

**Opção A — Docker (recomendado para deixar sempre ligado)**

```bash
npm run docker:up
```

O script detecta as suas contas do Claude Code, monta só as pastas necessárias (em modo somente leitura), constrói
a imagem e sobe o container — que reinicia sozinho junto com o Docker. Abra **http://localhost:4747**.

**Opção B — Node, sem Docker**

```bash
npm run build
npm start
```

Abra **http://localhost:4747**. Para desenvolver, use `npm run dev` (servidor + Vite com recarga automática).

Agora abra o Claude Code em qualquer projeto e veja o seu agente chegar pelo elevador. 🎉

### 3. Ative o uso ao vivo das contas (opcional, recomendado)

```bash
npm run usage:install
```

Isso coloca um pequeno "tap" na frente do statusline de cada conta (o seu statusline continua aparecendo igual) para
capturar o **uso de 5 horas e semanal** que o próprio Claude Code envia — sem ler senhas nem tokens. Faz backup do
`settings.json` antes; para desfazer: `npm run usage:uninstall`. Detalhes em
[Contas e uso](#contas-e-uso-5-horas-e-semanal).

> O tap aponta para a pasta onde você clonou o CodeTown. Se mover a pasta, rode `npm run usage:install` de novo
> (até lá, o statusline das contas mostra erro).

### Abrir no celular (opcional)

Por padrão o CodeTown só aceita conexões do próprio computador. Para abrir no celular (no mesmo Wi-Fi), com Docker:

```bash
printf 'CODETOWN_BIND=0.0.0.0\n' > .env
npm run docker:up -- --no-build
```

Depois abra `http://<ip-do-computador>:4747` no celular (no macOS: `ipconfig getifaddr en0`; se vier vazio,
`ipconfig getifaddr en1`). No modo Node, use `CODETOWN_HOST=0.0.0.0 npm start`.

> ⚠️ Com isso, qualquer aparelho da rede vê a atividade dos agentes (comandos, arquivos, títulos das sessões). Use
> só em redes de confiança. O [terminal somente leitura](#terminal-somente-leitura) fica desligado enquanto a porta
> estiver exposta. Para voltar: apague o `.env` e rode `npm run docker:up -- --no-build`.

### Atualizar

```bash
git pull
npm install
npm run docker:up        # ou: npm run build && npm start
```

### Desinstalar

```bash
npm run usage:uninstall                     # devolve o statusline original das contas
npm run docker:down                         # para o container
docker volume rm codetown_codetown-data     # apaga os dados do container (nomes dos personagens)
docker image rm codetown:local              # apaga a imagem
rm -rf ~/.codetown                          # apaga os dados locais (uso capturado, nomes e estatísticas)
```

Depois é só apagar a pasta do projeto — rode o `usage:uninstall` **antes**, senão o statusline das contas passa a
dar erro. O `usage:uninstall` deixa cópias `settings.json.codetown-backup-<data>` na pasta de cada conta
(ex.: `~/.claude/`); apague-as se não precisar mais.

## Como usar

### O que cada personagem está fazendo

| Estado | O que você vê |
| --- | --- |
| **Trabalhando** | Na mesa, digitando. O monitor e um balão mostram a atividade: 📖 lendo, ✏️ editando, 💻 terminal, 🧪 testes, 🌐 pesquisando… |
| **Precisa de você** | Corre para a mesa e levanta a mão, com alerta piscando: está esperando uma permissão ou resposta no terminal. |
| **Esperando o shell** | Terminou o turno mas deixou um comando rodando (testes, build, deploy…), então fica na mesa com uma ampulheta virando sobre a cabeça e o terminal em progresso: come pipoca assistindo, depois de 3 min cruza os braços e gira na cadeira, depois de 10 min junta teia de aranha e depois de 25 min cochila; quando o comando termina, levanta e comemora com confete (ou ganha uma nuvem de chuva, se falhou). Depois de 40 s, se houver colegas à toa, pode sair para uma roda — com a ampulheta na cabeça. |
| **Ocioso** | Terminou o turno e passeia: café na copa, bebedouro, banheiro, sofá do lounge, celular no puff, espelho. Com colegas à toa, entra numa roda: TV, videogame, ping-pong, papo na copa, jokenpô (veja [Vida social](#vida-social)). Depois de 10 min parado, cochila — mas um colega pode acordá-lo para uma roda. |
| **Subagente concluído** | Vai até o agente que o chamou, entrega o resultado e sai pelo elevador. |
| **Sessão encerrada** | Vai embora; se era o último da sala, apaga a luz antes de sair. |

Cada personagem tem um **nome brasileiro único** (Marina, Henrique, Luan…) que se mantém enquanto a sessão existir, e
um **chip colorido com a letra da conta** (C, D…).

### Interface

- **Topo:** contadores (salas, agentes, trabalhando, subagentes, shells rodando, precisam de você) e um cartão de
  **uso por conta**. O de shells só aparece enquanto algum comando está rodando; clique nele para ir até quem espera.
- **Painel lateral:** busca, filtro por conta e a lista de salas com seus agentes e subagentes.
- **Gaveta de detalhes:** clique num personagem (no prédio ou na lista) para ver atividade, tarefas, subagentes,
  linha do tempo e estatísticas (ferramentas, tokens, custo, linhas alteradas, modelo, branch).
- **Feed:** as últimas atividades de todo o escritório.
- **Configurações (⚙):** nomes, balões, quanto os ociosos passeiam, dia e noite, som, notificações do navegador e
  modo demonstração. **Ajuda (?):** legenda completa e atalhos. **Meu dia (📊):** para onde foi o tempo do dia (veja
  [Meu dia](#meu-dia)).

**Câmera:** arraste para mover, role para dar zoom, clique duplo num personagem para segui-lo.

**Atalhos:** `/` busca · `F` seguir o selecionado · `O` ou `0` visão geral · `Esc` limpar seleção ·
`[` painel lateral · `]` feed · `M` meu dia · setas/`WASD` mover · `+` `-` zoom · `?` ajuda.

### Terminal somente leitura

Clique num agente e use **Abrir terminal** para ver a conversa da sessão como o Claude Code mostra: os prompts, as
respostas, cada ferramenta chamada (com o comando ou o diff) e o resultado, atualizados ao vivo. É só para ler: não
dá para digitar nem interferir no agente. Vale para agentes principais e subagentes; no modo demonstração, a conversa
é fictícia.

Como o terminal mostra a conversa inteira, ele só existe quando o CodeTown está acessível **apenas pelo próprio
computador** (o padrão) e só abre por `http://localhost` ou `http://127.0.0.1`. Com a porta liberada para a rede
(`CODETOWN_BIND=0.0.0.0` ou `CODETOWN_HOST=0.0.0.0`), ele fica desligado. Detalhes em
[Privacidade e segurança](#privacidade-e-segurança).

### Meu dia

O botão **Meu dia** (ou a tecla `M`) mostra para onde foi o dia: quanto tempo os agentes passaram trabalhando e,
em destaque, quanto tempo ficaram **esperando você** (permissão, pergunta ou escolha) — com a maior espera, quem
esperou, onde e quando. Ao lado, sessões, subagentes, pedidos, tokens e custo (quando o Claude Code grava o custo no
transcript), e gráficos por hora, por projeto (do que mais esperou você para o que menos esperou) e por conta, além
do ranking das maiores esperas. Escolha o dia no seletor (o CodeTown guarda os últimos 30); aberto no dia de hoje,
o painel se atualiza a cada 30 s. Cada gráfico tem uma versão em tabela, e a legenda liga e desliga cada status.

O tempo é **tempo de agente**: dois agentes trabalhando por uma hora contam duas horas. O CodeTown só conta o que
acontece enquanto ele está rodando, e o dia segue o fuso do seu navegador. Com o modo demonstração ligado, o painel
mostra números fictícios (com o selo "demonstração") e deixa alternar para os dados reais; os agentes do demo nunca
entram nas estatísticas de verdade.

### Modo demonstração

Quer ver o escritório cheio sem ter sessões abertas?

- Acrescente **`?mock=1`** à URL (ex.: http://localhost:4747/?mock=1) para simular tudo no navegador, sem as suas
  sessões reais. Parâmetros: `&speed=3` acelera o tempo e `&sessions=6` muda o número de sessões simuladas.
- Ou ligue pela interface — **Ver demonstração** (quando o escritório está vazio) ou **Configurações › Modo
  demonstração** —, que coloca agentes fictícios junto com os reais. Com `npm run demo` (ou `CODETOWN_DEMO=1` no
  `.env` do Docker), esse modo já começa ligado.

## Contas e uso (5 horas e semanal)

Se você usa mais de uma conta do Claude Code (por exemplo, um atalho `c` com `~/.claude` e um `d` com
`CLAUDE_CONFIG_DIR=~/.claude-conta2`), o CodeTown mostra todas juntas: cada agente leva o chip da sua conta e o topo
mostra, para cada conta, o **percentual usado** da sessão de 5 horas e da semana e **quando cada limite reinicia**.

**Como as contas são reconhecidas.** Cada pasta de configuração do Claude Code é uma conta: `~/.claude` e qualquer
`~/.claude*` com `projects/` ou `sessions/` (além de `CLAUDE_CONFIG_DIR`). Para dar a letra de cada uma, o CodeTown
lê nos arquivos do shell (`~/.zshrc`, `~/.bashrc`…) **somente** as linhas `alias x='... claude ...'`:

```bash
alias c='claude'
alias d='CLAUDE_CONFIG_DIR=~/.claude-conta2 claude'
```

vira **Conta C** e **Conta D**. Só valem atalhos de até 3 letras; contas sem atalho recebem A, B…

**De onde vêm os números.** O jeito recomendado é o tap de statusline (`npm run usage:install`): o Claude Code já envia
ao comando de statusline de cada sessão os limites do plano (`rate_limits`), e o tap guarda só esses números em
`~/.codetown/usage/<conta>.json`. Os números chegam depois da próxima resposta de cada conta. Confira com
`npm run usage:status`.

<details>
<summary><b>Detalhes do tap e do cache do /usage</b></summary>

- O `usage:install` altera, em `<conta>/settings.json`, **só** o campo `statusLine.command`: o comando original
  (ex.: `npx -y ccstatusline`) passa a rodar através de `node "<pasta do CodeTown>/scripts/statusline-tap.mjs" --
  <comando original>`. Uma cópia do arquivo vai antes para `settings.json.codetown-backup-<data>`. Se a conta não tinha
  statusline, é criado um que só captura o uso. `npm run usage:install -- --dry-run` mostra o que mudaria sem gravar.
- O tap repassa o mesmo JSON ao seu statusline (saída e código de saída continuam os dele) e grava **somente**
  `{accountId, configDir, fetchedAt, five_hour, seven_day}` — nada de prompts, custos ou caminhos de projeto. Qualquer
  falha na captura é ignorada: o statusline nunca quebra por causa do CodeTown.

| Fonte | Como funciona |
| --- | --- |
| **Tap de statusline** (recomendado) | Ao vivo, como descrito acima. |
| Cache do `/usage` (sempre ligado) | O Claude Code grava o último resultado do comando `/usage`. No modo Node, o CodeTown relê a cada 60 s; no Docker, vale o valor lido no último `npm run docker:up`. Só muda quando alguém roda `/usage`. |

As duas fontes são arquivos locais: nenhuma lê senhas ou tokens, nem faz chamadas de rede. Vale sempre a fonte com os
números mais recentes. Números com mais de 30 minutos aparecem como **desatualizados**; uma janela que já reiniciou
desde a coleta aparece como **—** até chegarem números novos.

</details>

## Configuração

Tudo funciona sem configurar nada. Se precisar ajustar, use variáveis de ambiente:

| Variável | Padrão | Para quê |
| --- | --- | --- |
| `CODETOWN_PORT` | `4747` | Porta HTTP (no Docker, a porta publicada no host). |
| `CODETOWN_HOST` | `127.0.0.1` | Interface do servidor no modo Node. Fora de `127.0.0.1`/`localhost`, o terminal somente leitura fica desligado. |
| `CODETOWN_BIND` | `127.0.0.1` | Só Docker (no `.env`): onde a porta é publicada. `0.0.0.0` libera a rede local (e desliga o terminal somente leitura). |
| `CODETOWN_CLAUDE_DIRS` | detecção automática | Pastas das contas, separadas por vírgula (ex.: `/caminho/conta1,/caminho/conta2`). |
| `CODETOWN_DATA_DIR` | `~/.codetown` | Onde o CodeTown guarda os próprios dados (nomes dos personagens e estatísticas do Meu dia). |
| `CODETOWN_USAGE_DIR` | `~/.codetown/usage` | Onde o tap de statusline grava o uso. |
| `CODETOWN_DEMO` | desligado | `1` liga o modo demonstração ao iniciar. |
| `CODETOWN_ALLOWED_HOSTS` | — | Nomes extras aceitos no endereço (ex.: `meu-mac.local`), além de `localhost` e IPs. |
| `CODETOWN_TERMINAL` | ligado (só com acesso local) | `0` desliga o terminal somente leitura. Com a porta exposta ele já fica desligado, sem opção de ligar. |
| `CODETOWN_ACCOUNTS` | — | JSON para personalizar nome, letra ou cor, casado pelo nome da pasta da conta. Ex.: `[{"id":".claude-conta2","name":"Trabalho","short":"T","color":"#5cc97b"}]`. |

**No Docker**, valem `CODETOWN_PORT`, `CODETOWN_BIND`, `CODETOWN_ALLOWED_HOSTS`, `CODETOWN_DEMO` e `CODETOWN_TERMINAL`
(no `.env` ou no ambiente) e `CODETOWN_CLAUDE_DIRS`, `CODETOWN_USAGE_DIR` e `CODETOWN_ACCOUNTS` (lidas pelo `docker:up`
no host); as demais ficam fixas dentro do container. Opções: `npm run docker:up -- --no-build` (sobe sem reconstruir),
`npm run docker:down` (para) e `npm run docker:logs` (acompanha os logs).

## Como funciona

```
 ~/.claude*/sessions/<pid>.json ─────────────────┐
 ~/.claude*/projects/<projeto>/<sessão>.jsonl ───┼──▶ servidor Node ──▶ modelo do escritório ──▶ SSE ──▶ navegador
 .../<sessão>/subagents/**/agent-*.jsonl ────────┘    (polling de 1 s)                                 (canvas + interface)
```

- **Quem está no escritório:** enquanto uma sessão está aberta, o Claude Code mantém `sessions/<pid>.json` com o
  projeto e o status (ocupado, ocioso, esperando você ou esperando um shell em segundo plano). É isso que decide
  quem aparece e o que cada um faz.
- **Shells rodando:** nos transcripts, cada `Bash` em segundo plano (ou comando longo em primeiro plano) vira um
  "shell" com rótulo e cronômetro, até chegar a notificação de que terminou, falhou ou foi interrompido.
- **Vida social:** as rodas, as personalidades e as moedinhas são simulação do navegador (`client/src/world/social/`),
  sem nenhum efeito nos agentes de verdade. A personalidade sai da semente de cada agente (é a mesma em qualquer
  navegador); as carteiras ficam no `localStorage` do navegador.
- **O que cada um está fazendo:** o servidor acompanha o fim dos transcripts (`.jsonl`) das sessões abertas e traduz
  cada chamada de ferramenta numa atividade em português, com ícone. Dali também saem tarefas, título, modelo e
  estatísticas.
- **Subagentes:** os transcripts em `<sessão>/subagents/` (inclusive os de workflows) viram personagens ligados ao
  agente que os chamou.
- **O desenho:** o navegador recebe o estado por SSE e desenha tudo num canvas — personagens, móveis, pisos e paredes
  são pixel art **gerada por código**; já o logotipo, as ilustrações e os quadros das paredes foram gerados com IA.

<details>
<summary><b>Estrutura do código e API</b></summary>

```
shared/   protocolo (types.ts), atividades em PT-BR, nomes, simulador de demonstração
server/   servidor HTTP + SSE: contas e uso, leitura das sessões e transcripts, modelo do escritório
client/   Vite: src/art (pixel art procedural), src/world (o escritório no canvas), src/ui (interface)
scripts/  build do servidor, docker-up, tap de statusline (+ instalador) e screenshots
```

| Rota | Descrição |
| --- | --- |
| `GET /api/stream` | SSE com os eventos `snapshot`, `feed` e `notice` (formato em `shared/types.ts`). |
| `GET /api/snapshot` | Estado atual do escritório. |
| `GET /api/agents/:id` | Detalhes de um agente, com até 200 atividades. |
| `GET /api/agents/:id/terminal` | SSE do terminal somente leitura (eventos `init` e `append`); só com acesso local. |
| `GET /api/stats?day=AAAA-MM-DD` | Estatísticas do Meu dia (tempo por status, projetos, contas, horas, esperas, tokens e custo). |
| `GET /api/stats/days` | Dias com estatísticas (os últimos 30). |
| `GET /api/health` | Saúde: versão, demonstração, Docker, terminal, fontes e status de uso de cada conta. |
| `POST /api/demo` | `{"enabled": true \| false}` liga ou desliga os agentes simulados. |

Mais detalhes do servidor em [`server/README.md`](server/README.md).

</details>

<details>
<summary><b>O que o Docker monta e por quê</b></summary>

| Host | Container | Para quê |
| --- | --- | --- |
| `<conta>/sessions/` | `/claude/<conta>/sessions` (somente leitura) | Sessões abertas e seus status. |
| `<conta>/projects/` | `/claude/<conta>/projects` (somente leitura) | Transcripts das sessões e dos subagentes. |
| `~/.codetown/usage/` | `/usage` (somente leitura) | Uso capturado pelo tap de statusline. |
| volume `codetown-data` | `/data` | Dados do próprio CodeTown (nomes dos personagens e estatísticas do Meu dia). |

A pasta da conta **nunca** é montada inteira (lá ficam credenciais e configurações). O container roda como usuário sem
privilégios, com sistema de arquivos somente leitura, sem capabilities extras e com `no-new-privileges`. Os metadados
das contas (letra, e-mail, organização) são lidos no host pelo `docker:up` e passados ao container.

</details>

## Privacidade e segurança

- **Só leitura:** o CodeTown nunca grava nas pastas do Claude Code. A única exceção é o `npm run usage:install` /
  `usage:uninstall`, que muda só o `statusLine.command` do `settings.json` — com backup antes.
- **Só local, por padrão:** o servidor só aceita conexões do próprio computador; liberar a rede local é opcional.
  Não há telemetria nem chamadas externas: o CodeTown não acessa a internet.
- **Sem credenciais:** o CodeTown não lê senhas nem tokens de acesso. Do `.claude.json` de cada conta aproveita só o
  e-mail, a organização e o cache do `/usage`; o uso ao vivo vem do tap de statusline.
- **Segredos mascarados:** tokens e senhas com formato conhecido (`Bearer`, `-u usuário:senha`, `TOKEN=`, chaves
  `sk-…`, `ghp_…`, `AKIA…`, JWTs, senhas em URLs) viram `***` antes de chegar ao navegador.
- **Protegido contra sites maliciosos:** o servidor recusa endereços que não sejam `localhost`/IP (DNS rebinding) e
  `POST` vindos de outras origens (CSRF), e não deixa a página ser embutida em outros sites.
- **Terminal somente leitura só local:** a conversa completa das sessões só sai do servidor com o CodeTown acessível
  apenas pelo próprio computador (`CODETOWN_HOST` local no Node; `CODETOWN_BIND` local no Docker) — não há como
  ligá-lo com a porta exposta — e cada pedido precisa vir por `localhost`/`127.0.0.1`: IPs da rede e nomes de
  `CODETOWN_ALLOWED_HOSTS` (proxies, túneis) são recusados. Segredos são mascarados e textos longos truncados antes
  de chegar ao navegador; no modo demonstração, a conversa é fictícia. `CODETOWN_TERMINAL=0` desliga de vez.
- **Estatísticas do Meu dia:** só números agregados (tempo por status, contagens, tokens, custo) com nomes de projeto,
  conta e agente, guardados em `CODETOWN_DATA_DIR/stats/` por 30 dias — nada da conversa.
- **O que aparece na tela:** resumos das atividades (ferramenta, arquivo, comando ou consulta), títulos das sessões,
  tarefas e estatísticas (e, no terminal somente leitura, a conversa). Não exponha a porta em redes em que você não
  confia.

## Desenvolvimento

| Comando | O que faz |
| --- | --- |
| `npm run dev` | Servidor + Vite em http://localhost:4747, com recarga automática. |
| `npm run dev:client` | Só o Vite, em http://localhost:5173 (abra com `?mock=1`; `/api` é repassado para a porta 4747). |
| `npm run demo` | `npm run dev` com o modo demonstração ligado. |
| `npm run build` / `npm start` | Compila e roda a versão de produção. |
| `npm test` | Testes (Vitest). |
| `npm run typecheck` | Verificação de tipos de cliente, servidor e scripts. |

Para tirar screenshots sem abrir o seu navegador, `scripts/shot.mjs` usa um Chromium headless isolado (Playwright).
Na primeira vez, baixe o navegador (uma vez só): `npx playwright-core install chromium-headless-shell`.

```bash
node scripts/shot.mjs 'http://localhost:4747/?mock=1&speed=3' /tmp/codetown.png --size 1400x900 --wait 4000
```

No console do navegador, `codetown.world.debug` tem ferramentas para testar cenas (ex.:
`codetown.world.debug.setHour(21)` para ver a noite).

## Solução de problemas

<details>
<summary><b>O escritório está vazio</b></summary>

Só aparecem sessões **abertas** do Claude Code. Confira se há alguma rodando e se a conta foi detectada em
`http://localhost:4747/api/health`. Se as pastas das contas estiverem em outro lugar, use
`CODETOWN_CLAUDE_DIRS=/caminho/conta1,/caminho/conta2`.

</details>

<details>
<summary><b>O uso aparece como "sem dados" ou "desatualizado"</b></summary>

Rode `npm run usage:install` e confira com `npm run usage:status`. Os números chegam depois da próxima resposta numa
sessão aberta daquela conta; se não aparecerem, reabra a sessão. Um **—** no lugar do percentual quer dizer que a
janela reiniciou desde a última coleta.

</details>

<details>
<summary><b>"A porta 4747 já está em uso"</b></summary>

Outro CodeTown (Node ou Docker) já está rodando. Pare-o (`npm run docker:down`, ou Ctrl+C no terminal do
`npm start`) ou use outra porta: `CODETOWN_PORT=4848 npm run docker:up` (Docker) ou `CODETOWN_PORT=4848 npm start`
(Node).

</details>

<details>
<summary><b>Não abre no celular</b></summary>

Confira se criou o `.env` com `CODETOWN_BIND=0.0.0.0` e recriou o container (`npm run docker:up -- --no-build`), se
o celular está no mesmo Wi-Fi e se o firewall do computador permite conexões na porta 4747. Por IP funciona direto;
para abrir por um nome (ex.: `meu-mac.local`), acrescente `CODETOWN_ALLOWED_HOSTS=meu-mac.local` (no Docker, no mesmo
`.env`).

</details>

<details>
<summary><b>O terminal somente leitura não abre</b></summary>

O terminal só existe com o CodeTown acessível apenas pelo próprio computador. Confira se o `.env` não tem
`CODETOWN_BIND=0.0.0.0` (ou, no modo Node, se não usou `CODETOWN_HOST=0.0.0.0`) nem `CODETOWN_TERMINAL=0`, e abra por
`http://localhost:4747` (pelo IP da rede ou por um nome de `CODETOWN_ALLOWED_HOSTS` ele é recusado). No Docker, um container
criado antes desse recurso precisa ser recriado: `npm run docker:up`. O log de inicialização (`npm run docker:logs`)
diz se o terminal está ligado e, se não estiver, por quê.

</details>

<details>
<summary><b>No Docker, uma sessão fechada continua no escritório</b></summary>

Acontece se o Claude Code foi encerrado à força sem apagar o próprio registro em `sessions/` (no Docker não dá para
conferir se o processo ainda existe). Rodando com Node (`npm start`), o CodeTown confere os processos e isso não
acontece.

</details>

<details>
<summary><b>No Docker, uma conta fora de /Users não aparece</b></summary>

O Docker Desktop só compartilha algumas pastas do Mac com os containers (por padrão `/Users`, `/Volumes`, `/private` e
`/tmp`). Adicione a pasta em *Settings › Resources › File sharing*.

</details>

<details>
<summary><b>Quero começar do zero</b></summary>

`npm run docker:down`, depois `docker volume rm codetown_codetown-data` (apaga os nomes guardados) e
`npm run docker:up`.

</details>

## Aviso

O CodeTown é um projeto independente, **não afiliado, patrocinado nem endossado pela Anthropic**. "Claude" e
"Claude Code" são marcas da Anthropic, usadas aqui só para descrever com o que o projeto funciona.

Para mostrar os agentes, o CodeTown lê apenas arquivos locais que o próprio Claude Code grava na sua máquina
(registros das sessões abertas, transcripts e configurações das contas). Esse formato não é documentado e pode mudar entre versões do Claude Code:
depois de uma atualização, o CodeTown pode deixar de funcionar, total ou parcialmente, até ser ajustado.

## Licença

[MIT](LICENSE). As imagens em `client/public/assets` (logotipo, ilustrações, quadros e pôsteres) foram geradas com
IA para este projeto e convertidas em pixel art pelos scripts de `scripts/assets/`.

## Vida social

Quando dois ou mais agentes estão à toa — ociosos, ou esperando um shell há mais de 40 segundos —, eles param de
passear sozinhos e se juntam. Ninguém combina nada: cada personagem tem uma **personalidade**, **amigos** e
**rivais**, e isso decide o que ele prefere fazer, com quem e o que fala. Quem está esperando um shell só sai da mesa
para uma roda (sozinho, continua na pipoca) e leva a ampulheta junto; quando o comando termina — ou quando você manda
um pedido novo para alguém —, ele avisa a turma ("Opa, me chamaram! 🏃") e corre de volta para a mesa.

<p align="center">
  <img src="docs/screenshots/social-lounge.gif" width="816" alt="Lounge do CodeTown com três rodas ao mesmo tempo: três colegas no sofá vendo futebol na TV (a tela pisca GOL), uma partida de pingue-pongue com torcida e um duelo nos fliperamas com provocações nos balões" />
</p>

### As rodas

| | Roda | O que acontece |
| --- | --- | --- |
| 📺 | **TV no lounge** | Futebol, novela ou desenho, com pipoca no sofá. No futebol a torcida comemora junto com o "GOL" que pisca na tela (ou lamenta o gol do adversário); na novela, coraçõezinhos e "Não acredito! 😱". Quem é de sonecas acaba dormindo no sofá. |
| 🎮 | **Videogame** | Dois no sofá com o controle, a TV em tela dividida (corrida ou luta), melhor de 3, provocações ("Que lag é esse?!") e torcida. |
| 👾 | **Fliperama** | Duelo nas duas máquinas do lounge, uma partida só. |
| 🏓 | **Pingue-pongue** | Até 5 pontos, com a bolinha indo e voltando, placar nos balões ("3 × 2 🏓") e torcida atrás da mesa. |
| ☕ | **Papo na copa** | Cada um pega um café (ou água) e senta à mesa: fofoca com o nome dos colegas ("Viram o commit de Rafaela? 👀"), piada (a roda gargalha), trabalho ("Deploy na sexta? 😈") e assuntos do dia e da hora ("Sextou! 🎉"). |
| 💬 | **Conversa** | Dois colegas em pé num canto da recepção, da copa ou do lounge. |
| ✊ | **Jokenpô valendo** | "Jo… ken… pô!", os gestos aparecem sobre a cabeça, quem ganha comemora e as moedinhas voam de um para o outro; quem perde fica chateado e, se for competitivo, pede revanche. Empate repete. Quem está passando pode parar para assistir. |
| 💄 | **Espelho do banheiro** | Batom ou pente, com o rosto refletido no espelho e um brilho no final. Vale sozinho ou em dupla ("Empresta o pente?"). |

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/social-rps.png" alt="Jokenpô na recepção: Lia comemora com uma moeda sobre a cabeça e o balão 'Ganhei!', moedinhas voam de Bruna (chateada, com o ícone de pedra) para ela, '+20' e '−20' flutuando, e Iara assiste atrás" /></td>
    <td width="50%"><img src="docs/screenshots/social-kitchen.png" alt="Papo na copa: quatro colegas sentados à mesa comprida com café, com os balões 'Vai dar certo!' e 'Hahaha'" /></td>
  </tr>
  <tr>
    <td><b>Jokenpô valendo moedinhas.</b> A aposta sai da personalidade (quem é de apostas aposta alto, quem é pão-duro aposta pouco) e nunca passa do saldo de quem tem menos.</td>
    <td><b>Papo na copa.</b> Quem fala mais é quem é mais sociável; as reações dependem do assunto (gargalhada na piada, 👀 na fofoca).</td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/social-mirror.png" alt="Duas colegas diante das pias do banheiro se arrumando, com os rostos refletidos nos espelhos e o balão 'Tá arrasando!'" /></td>
    <td><img src="docs/screenshots/social-drawer.png" alt="Seção Vida social nos detalhes do agente: 'Vendo novela na TV com Bruna e Iara', 115 moedinhas, 1 vitória e 0 derrotas, os traços Vaidade e Economia, o bordão, amizades, rivalidades com o placar e o extrato" /></td>
  </tr>
  <tr>
    <td><b>No espelho.</b> Quem é de vaidade passa no banheiro sempre que pode — e aparece refletido.</td>
    <td><b>Nos detalhes do agente.</b> O que está fazendo, a carteira, o placar, a personalidade, amizades e rivalidades (com o retrospecto) e o extrato.</td>
  </tr>
</table>

### Personalidades

Cada agente tem 2 ou 3 traços, sorteados pela semente dele (é sempre a mesma pessoa, em qualquer navegador):

🏆 Competição · 🎲 Apostas · 🎮 Games · 📺 Séries e TV · 🗣️ Fofoca · 💄 Vaidade · ☕ Cafeína · 😂 Piadas · 🏓 Esporte ·
🙈 Timidez · 💰 Economia · 😴 Sonecas · 🧘 Calma · 📚 Leitura

Os traços mudam o que cada um escolhe (quem é de séries liga a TV, quem é de esporte chama para o ping-pong), quem
chama (amigos se procuram; rivais se desafiam nos jogos), o que fala e até quem joga melhor. Cada um também tem um
bordão ("Tá pago!", "Bora codar!"). Passe o mouse sobre um traço nos detalhes do agente para ver o que ele faz.

### Moedinhas

Moedinhas fictícias (🪙), só para dar graça às apostas:

| | |
| --- | --- |
| **Chegou ao escritório** | 🪙100 (subagentes, 🪙30) |
| **Tarefa concluída** (item da lista de tarefas) | +🪙10 |
| **Pedido atendido** (fim de turno) | +🪙5 |
| **Subagente entregou o resultado** | +🪙15 |
| **Apostas** (jokenpô; partidas entre rivais ou com quem é de apostas) | o que perder vai para quem ganhar |

Cada ganho aparece como "+🪙10" sobre a cabeça; as partidas e apostas entram no feed de atividade. O saldo, o placar
e o extrato ficam salvos no navegador (cada navegador tem a sua economia: as apostas são sorteadas ali) e são
esquecidos três dias depois de o agente sair.

> Tudo isso é encenação do CodeTown: nada muda nos agentes do Claude Code, que continuam trabalhando normalmente.

---

<p align="center">
  Feito com ☕ e muitos agentes do <a href="https://code.claude.com">Claude Code</a>.
</p>
