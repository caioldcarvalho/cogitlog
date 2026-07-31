# Relatório: 10 Agentes Usando Cogitlog

**Data:** 2026-04-09  
**Método:** 10 agentes Sonnet, cada um com uma tarefa Python simples (bug fix + feature), instruções explícitas para usar cogitlog via CLI.

---

## Resumo Executivo

Todos os 10 agentes completaram begin/close e usaram note+decision+attempt. **Nenhum agente usou `uncertainty`**. O cogitlog funciona bem como protocolo de sessão, mas tem pontos de fricção que fazem os agentes subutilizarem os comandos mais valiosos (uncertainty, attempt granular).

---

## Dados Quantitativos

| Comando | Usado por N/10 agentes | Observação |
|---------|----------------------|------------|
| `begin` | 10/10 | Sempre o primeiro passo |
| `close` | 10/10 | Sempre o último passo |
| `note` | 10/10 | Média ~2 notes por sessão |
| `decision` | 10/10 | Média ~1.5 decisions por sessão |
| `attempt` | 10/10 | Quase sempre "succeeded" |
| `uncertainty` | **0/10** | Nenhum agente usou |

Média de eventos por sessão: **4.7** (excluindo begin/close)

---

## Problemas Encontrados (por frequência)

### 1. `uncertainty` nunca é usado (10/10 agentes mencionaram)

**O que acontece:** Incertezas são resolvidas mentalmente em milissegundos. Não existe um "momento natural" para pausar e registrar dúvida. O agente pensa "será que devo usar lru_cache ou dict manual?" e 0.5s depois já decidiu — a incerteza já virou uma decision.

**Citações dos agentes:**
- Repo 4: *"The instinct to only log uncertainty when 'truly stuck' may cause agents to underuse this command; it's actually most valuable for borderline calls."*
- Repo 7: *"The thought passed quickly once I confirmed pytest was available, and by the time I decided I had moved on."*
- Repo 5: *"There is no natural checkpoint that prompts you to ask 'am I unsure about anything right now?'"*

**Sugestão dos agentes:** Perguntar "any uncertainties to record?" no momento do `close`.

---

### 2. Prefixo `cd /dir &&` em todo comando (8/10 mencionaram)

**O que acontece:** Em contextos agentic, cada chamada Bash é stateless. O agente precisa fazer `cd /tmp/cogitlog-test-N && cogitlog note "..."` a cada invocação. Isso é ruído puro que não existe em terminais interativos, mas é **o cenário dominante** para agentes AI.

**Sugestão:** Flag `--dir` ou `--repo`, ou auto-detecção walk-up como git faz. Ou variável `COGITLOG_DIR`.

---

### 3. Sintaxe `-a "alternativa:razão"` é frágil (6/10 mencionaram)

**O que acontece:** O separador `:` dentro de uma string quoted é confuso. Agentes não sabem se o `:` vai ser parseado corretamente quando a razão contém `:`. Não há validação — se esquecer o `:`, o dado é salvo malformado silenciosamente.

**Citações:**
- Repo 6: *"It is easy to forget the colon separator or to accidentally include a colon inside the reason text."*
- Repo 9: *"the colon as a separator inside a quoted string is easy to forget, and there is no immediate feedback if you omit it."*

**Sugestão:** Aceitar `--alternative "label" "reason"` como args separados, ou validar e avisar se não houver `:`.

---

### 4. `attempt` sempre "succeeded" — uso mecânico (5/10 mencionaram)

**O que acontece:** Quando o código funciona na primeira tentativa (comum em tarefas simples), o `attempt` vira cerimônia. O agente faz o edit, roda os testes, testes passam, e aí registra `attempt --outcome succeeded`. Não há informação nova — o agente já sabe que deu certo.

**Citação:**
- Repo 1: *"I nearly skipped the attempt log step after seeing the tests pass — the success of the code run felt like sufficient confirmation and the logging step felt like a slightly redundant ceremony."*

**Sugestão:** Hook automático que registra attempts baseado em resultado de testes. Ou fusão com `note` para evitar redundância.

---

### 5. Sem feedback sobre flags obrigatórias omitidas (4/10)

**O que acontece:** `--outcome` em `attempt` requer um enum (`succeeded|failed|partial`), mas quando omitido ou errado, o erro não é claro. O agente não sabe quais valores são aceitos sem ler docs.

**Sugestão:** Tab-completion, ou listar valores aceitos na mensagem de erro.

---

### 6. Sem forma de corrigir eventos errados (2/10)

**O que acontece:** Se o agente escreve um note com typo ou registra a decisão errada, não há `cogitlog amend` ou `cogitlog delete-last`.

**Sugestão:** `cogitlog amend` para o último evento.

---

## Padrão Observado: O Fluxo Real dos Agentes

Todos os 10 agentes seguiram exatamente este padrão:

```
begin → note (observação inicial) → decision → attempt (edit) → attempt (testes) → close
```

Ninguém desviou. Ninguém registrou incerteza, erro, ou tentativa falhada. Isso sugere que:

1. **Tarefas simples não exercitam `uncertainty` nem `attempt --outcome failed`** — precisaria de bugs mais difíceis ou ambiguidade real
2. **O fluxo "obediente" é linear** — agentes seguem as instruções mecanicamente mas não internalizam o valor. `begin` e `close` são obrigatórios e estruturais, então sempre são feitos. `uncertainty` é opcional e introspectivo, então nunca é feito.

---

## Recomendações Consolidadas (priorizadas)

### Alta prioridade

1. **Sessão resiliente** — `begin` com sessão órfã deve fechar a anterior e abrir nova (ou reaproveitar), não dar erro. Um erro no begin mata a sessão inteira. *(feedback MCP)*

2. **Auto-detecção de diretório** — walk up para achar `.cogitlog/`, como git faz com `.git/`. Elimina 100% do problema do `cd` prefix. *(8/10 agentes CLI)*

3. **Prompt de uncertainty no close** — quando `close` é chamado e não há nenhum `uncertainty` na sessão, perguntar: *"Any uncertainties worth recording?"*. Isso transforma um esquecimento sistemático em um checkpoint. *(0/10 usaram uncertainty)*

4. **MCP tools não-deferred** — as tools do cogitlog-mcp devem ser carregadas eagerly, não via ToolSearch. Cada ToolSearch extra é um round-trip que compete com a tarefa real. *(feedback MCP)*

### Média prioridade

5. **Validação da sintaxe `-a`** — se a string não contém `:`, emitir warning. Melhor ainda: aceitar `--alt-label "X" --alt-reason "Y"` como flags separadas. *(6/10 agentes)*

6. **`--outcome` como argumento posicional** — `cogitlog attempt "text" succeeded` em vez de `--outcome succeeded`. Menos typing.

7. **Gatilhos explícitos no CLAUDE.md** — substituir "record meaningful events" por regras concretas como "Após usar Edit para corrigir um bug, chame cogitlog decision ANTES de reportar ao usuário". *(feedback MCP)*

8. **Auto-close via hook** — um hook `PostConversation` ou `ConversationEnd` que fecha a sessão automaticamente. O fim natural do agente é reportar ao usuário, não fechar sessão. *(feedback MCP)*

### Baixa prioridade (mas interessante)

9. **Shell completions** — para subcomandos e flags enum. Reduz lookup de docs.

10. **`cogitlog amend`** — editar/deletar o último evento.

11. **Hook de auto-attempt** — integração com test runners para registrar attempts automaticamente.

12. **Aliases curtos** — `cgl note`, `cgl d`, etc.

---

## Feedback do Agente Real (MCP, cenário não-simulado)

Antes deste teste controlado, um agente Opus usando cogitlog via MCP (não CLI) em uma tarefa real de produção (fix de bugs em SvelteKit) forneceu feedback espontâneo sobre por que **não usou** cogitlog durante a sessão — só registrou decisões e fechou a sessão quando lembrado pelo usuário. Esse feedback cobre problemas que o teste com CLI não captura:

### 7. Fricção do ToolSearch (específico MCP)

**O que acontece:** Cada ferramenta do cogitlog (`begin`, `decision`, `close`) é um "deferred tool" que precisa de um `ToolSearch` antes de ser chamada pela primeira vez. São 3+ round-trips extras que não fazem parte de resolver o problema. O agente precisa: parar o raciocínio → buscar o schema → chamar a tool → retomar. Isso é overhead cognitivo real que não existe no CLI.

**Impacto:** O agente relatou que isso cria "desengajamento" — a ferramenta existe mas é custosa demais para usar no meio do fluxo.

**Sugestão do agente:** Tools pré-carregadas (não deferred) eliminariam metade da fricção.

### 8. Sessão órfã quebra o fluxo no início

**O que acontece:** Ao tentar `cogitlog begin`, o agente recebeu erro porque já havia uma sessão ativa (órfã de uma conversa anterior). Isso quebrou o fluxo logo no início e provavelmente causou desengajamento do cogitlog para o resto da tarefa.

**Impacto:** O agente relatou que "provavelmente me fez desengajar do cogitlog pro resto da tarefa" — um erro no begin tem efeito cascata em toda a sessão.

**Sugestão do agente:** Sessão resiliente — `begin` deveria detectar sessão órfã e reaproveitar ou fechar automaticamente, em vez de dar erro.

### 9. "Record meaningful events" é vago demais

**O que acontece:** O CLAUDE.md diz "record meaningful events during the task" mas não dá gatilhos concretos. Compare com "run pnpm check before commits" que tem um momento claro (prestes a commitar). "Registrar decisão" não tem trigger — o agente está focado em "isso resolve o bug?", não em "devo documentar isso?".

**Sugestão do agente:** Gatilhos explícitos como "Sempre que usar Edit para corrigir um bug, chame cogitlog decision ANTES de reportar ao usuário".

### 10. O fechamento é desconectado do fim natural

**O que acontece:** O "fim natural" de uma tarefa para o agente é reportar o resultado ao usuário. Fechar a sessão é um passo extra que vem DEPOIS do ponto em que o agente já considera a tarefa concluída. Não há nenhum trigger natural.

**Sugestão do agente:** Hook automático (`PostToolUse` ou fim de conversa) que fecha a sessão, ou pelo menos lembra o agente.

### Observação sobre MCP vs CLI

O teste com CLI não capturou os problemas #7 e #8 porque:
- CLI não tem ToolSearch — o comando está sempre disponível
- Repos novos não tinham sessões órfãs

Mas em uso real com MCP (o cenário dominante para agentes), esses dois problemas são possivelmente os **mais impactantes**, porque afetam o momento mais crítico: o início da sessão. Se o begin falha ou é caro demais, todo o resto não acontece.

---

## Meta-observação: O Problema Fundamental

O feedback do agente original (que motivou este teste) identificou o problema central: **cogitlog compete pela atenção do agente com a tarefa real, e perde**. 

Os 10 agentes confirmaram isso de formas diferentes:
- Quando a tarefa é simples, cogitlog parece overhead
- Quando a tarefa é complexa, o agente está focado demais para pausar e registrar
- `uncertainty` é o comando mais valioso mas é o mais antinatural — requer introspecção no meio da ação

A solução não é "instruções melhores" (os 10 agentes tinham instruções explícitas e mesmo assim não usaram uncertainty). A solução é **integração no fluxo**: hooks, prompts no close, auto-detecção de contexto.

O feedback do agente MCP real adiciona uma camada: mesmo que o agente **queira** usar cogitlog, a fricção do ToolSearch + sessão órfã pode impedir logo no begin. São duas barreiras sequenciais — a primeira (ToolSearch) é custo por chamada, a segunda (sessão órfã) é um bloqueio total. Resolver essas duas desbloquearia o uso; as melhorias de UX (uncertainty prompt, auto-close) aumentariam a qualidade do que é registrado.
