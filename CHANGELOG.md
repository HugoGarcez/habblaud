# Novidades

O que entrou em cada versão do CodeTown. Cada versão tem a sua seção aqui, e o texto dela vira as notas da
[release no GitHub](https://github.com/marmottajr/codetown/releases) (`npm run release`), que o CodeTown abre em
**Configurações › Sobre › Ver o que mudou**.

O formato segue o [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/), e os números seguem o
[versionamento semântico](https://semver.org/lang/pt-BR/): correção sobe o último número (0.2.**1**), novidade sobe o
do meio (0.**3**.0).

## [Não lançado]

### Adicionado

- **Mod do CodeTown para o Claude Code** (2.1.287 ou mais novo): `npm run mod:install` instala, em cada conta, o
  marketplace desta pasta com o mod `codetown` (uso de 5 horas e semanal ao vivo, uma linha no terminal quando outra
  sessão precisa de você e o comando `/codetown`) e o plugin `codetown-permissoes` (responder permissões pelo
  escritório; `-- --sem-permissoes` deixa de fora). `npm run mod:status` mostra o que cada conta tem e
  `npm run mod:uninstall` tira tudo. O `npm run docker:up` atualiza o mod de quem já instalou.

### Mudado

- O tap de statusline (`npm run usage:install`) e o hook de permissão (`npm run hooks:install`) viram o jeito antigo,
  para o Claude Code anterior ao 2.1.287. O `npm run mod:install` tira os dois da conta (com backup), porque o mod faz
  o mesmo. A interface e o README passam a ensinar o `npm run mod:install`.

## [0.2.0] - 2026-10-08

Primeira versão publicada.

### Adicionado

- **Versão e atualizações:** a versão em uso aparece na barra superior e em Configurações › Sobre. A cada 6 horas o
  CodeTown confere as releases no GitHub; quando sai uma versão nova, aparece o selo **Nova versão**, com um aviso e o
  link do que mudou. `CODETOWN_UPDATE_CHECK=0` desliga a consulta.
- **Meu dia** (tecla M): para onde foi o tempo dos agentes, quanto tempo esperaram você, tokens e custo, com 30 dias
  de histórico.
- **GitHub no escritório:** PR aberto ou mergeado e release publicada viram festa na sala; CI vermelho liga o alarme,
  até um CI verde.
- **Responder pelo escritório** (tecla P): com o hook instalado (`npm run hooks:install`), aprovar, recusar ou
  "sempre permitir" pedidos de permissão sem ir ao terminal. Só com acesso local.
- **Timelapse do dia** (tecla L): o escritório reproduz o dia em alta velocidade.
- **Terminal somente leitura** (tecla T): a conversa de cada agente, ao vivo, no estilo do Claude Code, com busca,
  filtro, botão de copiar e histórico das sessões dos últimos 7 dias. Só com acesso local.
- **Dia e noite** pela hora local e **sons** sintetizados no navegador (desligados por padrão).
- **Vida social:** quem está à toa se junta em rodas (TV, videogame, pingue-pongue, papo na copa, jokenpô valendo
  moedinhas), com personalidades, amizades e rivalidades.
- **Esperando o shell:** o agente que espera um comando longo fica na mesa com a ampulheta, e a espera vira uma gag.
- Forks de sessão aparecem no escritório.
- A página aberta se recarrega sozinha quando o servidor passa a servir outra versão.
- O container usa o fuso horário do computador.
- **O escritório:** cada projeto aberto no Claude Code vira uma sala e cada sessão, um personagem com nome próprio.
  Subagentes chegam, trabalham e entregam ao principal. Mostra as duas contas, com o uso de 5 horas e semanal de
  cada uma (tap de statusline), além de feed de atividade, avisos e modo demonstração. Roda no Node ou no Docker local.

[Não lançado]: https://github.com/marmottajr/codetown/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/marmottajr/codetown/releases/tag/v0.2.0
