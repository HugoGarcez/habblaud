# Plugins do Claude Code do Habblaud

O repositório é também um marketplace de plugins do Claude Code: `.claude-plugin/marketplace.json` (na raiz)
lista o marketplace `habblaud` com dois plugins, um em cada pasta daqui. As versões acompanham o `package.json`
(o teste `server/test/mod.test.ts` falha se divergirem).

Testado com o **Claude Code 2.1.293**. Mods (hooks em TypeScript carregados pelo próprio Claude Code) existem a
partir da 2.1.287; a API ainda é "early access" e pode mudar entre versões. Em versões anteriores, use os
instaladores de sempre (`npm run usage:install` e `npm run hooks:install`). A instalação está no README principal.

## `habblaud` — o mod

`habblaud/hooks/register.ts`, um módulo só, sem build. Liga cada sessão ao escritório sem ler a conversa:

- **Uso do plano (5h e semanal):** no início da sessão e a cada `session.measure` (depois de cada turno e quando
  um limite anda um ponto) lê `$.session.usage().rateLimits` e grava `~/.habblaud/usage/<conta>.json` (ou em
  `HABBLAUD_USAGE_DIR`) no mesmo formato do tap de statusline, mais `"source": "mod"`. Substitui o
  `npm run usage:install`: o seu statusline fica intocado. A conta é a pasta de `CLAUDE_CONFIG_DIR` (o primeiro
  item) ou `~/.claude`. Valores iguais gravados há menos de 10 s não são regravados; falha ao gravar = silêncio.
- **"Precisa de você" embaixo do prompt:** a cada 5 s pergunta ao Habblaud local
  (`GET http://127.0.0.1:<HABBLAUD_PORT ou 4747>/api/mod/summary`) quem está esperando, já sem esta sessão e os
  subagentes dela, e mostra `🏢 Valentina precisa de você em loja-virtual` ou
  `🏢 2 precisam de você: Valentina (loja-virtual), Elias (app-mobile)` (até 3 nomes, depois "e mais N").
  Ninguém esperando ou Habblaud fora do ar: a linha some; fora do ar, as perguntas passam a ser a cada 30 s até
  ele voltar. Só em sessões que desenham (no `claude -p` não pergunta nada).
- **`/habblaud`:** resumo do escritório inteiro, respondido pelo próprio mod (não chama o modelo, não gasta uso):

  ```
  Habblaud 0.3.0 em http://localhost:4747
  7 agentes · 3 trabalhando · 2 precisam de você
  ✋ Valentina (loja-virtual): aprovar uma permissão · dá para responder pelo escritório
  ✋ Elias (app-mobile): responder no terminal
  ```

  Fora do ar: `O Habblaud não respondeu em http://localhost:4747. Para subir: npm run docker:up na pasta do Habblaud.`

### O que ele acessa

Saída de `claude plugin validate --strict mod/habblaud` (a análise estática que o Claude Code faz antes de
carregar o módulo; nada fora desta lista é chamado):

```
❯ ./register.ts hooks: session.start, session.measure, command.run{command=habblaud}
❯ ./register.ts answers its own command: command.run{command=habblaud}
❯ ./register.ts calls: $.clock.after (via askHabblaud), $.clock.every (via schedule), $.clock.now (via writeUsage), $.command.register, $.env.get (via readEnv), $.fs.write (via writeUsage), $.http.fetch (via askHabblaud), $.session.id (via poll), $.session.surfaces (via poll), $.session.usage, $.ui.status (via setStatus)
❯ ./register.ts env writes: nothing
❯ ./register.ts env reads: CLAUDE_CONFIG_DIR, HABBLAUD_PORT, HABBLAUD_USAGE_DIR, HOME
```

Em palavras: só observa (nenhum hook decide nada: não aprova ferramentas, não muda prompts, não lê mensagens),
grava um único arquivo (o de uso), fala só com `127.0.0.1` e lê quatro variáveis de ambiente. `$.clock.after` é o
prazo de 2 s de cada pergunta ao Habblaud (`$.http.fetch` não aceita AbortSignal).

## `habblaud-permissoes` — responder permissões pelo escritório

Um hook `PermissionRequest` comum (sem mod), em `habblaud-permissoes/hooks/hooks.json`:

```json
{ "matcher": "*", "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/permission-hook.mjs\"", "timeout": 330, "statusMessage": "Aguardando resposta no Habblaud" }] }
```

O script `hooks/permission-hook.mjs` é o mesmo que o `npm run hooks:install` instala (fonte única; Node puro, só
`node:*`, porque o Claude Code copia apenas a pasta do plugin para o cache). Ele manda o pedido ao Habblaud local
e espera a resposta por até 5 min; o diálogo continua no terminal e vale o que você responder primeiro. Sem o
Habblaud no ar ou sem nenhuma página aberta, sai na hora. Porta: `HABBLAUD_PORT` (padrão 4747); espera:
`HABBLAUD_PERMISSION_TIMEOUT` (padrão 300 s; o tempo limite do hook no plugin é fixo em 330 s, então valores
maiores que 300 são cortados pelo Claude Code). Precisa de `node` 22+ no `PATH` da sessão.

`claude plugin validate --strict mod/habblaud-permissoes`: `✔ Validation passed` (o validador também confere o
esquema do `hooks.json`).

## Desenvolver

```bash
claude --plugin-dir mod/habblaud                     # carrega o mod numa sessão, sem instalar (recarrega ao salvar)
claude -p "/habblaud" --plugin-dir mod/habblaud      # testa o comando sem sessão interativa (não chama o modelo)
cd mod/habblaud && claude plugin test                # testes do mod (tests/*.test.ts), sem sessão, login nem rede
claude plugin validate --strict mod/habblaud         # análise estática + manifesto (idem para mod/habblaud-permissoes e .)
npx tsc -p mod/habblaud                              # tipos (depois de carregar o mod uma vez com --plugin-dir)
```

Ao carregar o mod, o Claude Code grava os tipos da versão instalada em `habblaud/.claude-plugin/types/` e um
`habblaud/tsconfig.json` que os estende; os dois são gerados e ficam fora do git (`mod/.gitignore`). Os testes do
mod importam `claude-code/testing` e só rodam pelo `claude plugin test`: o `npm test` (vitest) e o
`npm run typecheck` não olham esta pasta.
