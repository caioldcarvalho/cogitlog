# Prompt para a sessão de melhorias do cogitlog

> Cole isto numa sessão nova aberta em `~/projects/vibegit` (o repo do cogitlog,
> `caioldcarvalho/cogitlog`, CLI v0.6.1 instalada em `~/.npm-global/bin/cogitlog`).

---

Você vai melhorar o **cogitlog**, uma CLI de memória semântica para agentes de IA trabalhando em
repositórios. O código-fonte é este repo. O MCP companheiro é `caioldcarvalho/cogitlog-mcp`.

Contexto: em 2026-07-31 o cogitlog foi usado para transportar contexto de projeto entre pessoas
(um handover real, em 4 repositórios). Nesse uso apareceram 4 defeitos concretos. Todos foram
observados, não supostos. Resolva-os.

## Defeito 1 — `query` mente quando o índice está raso

`cogitlog query <termo>` casa **apenas** com o `intent` da sessão e a `outcome_note`. O corpo das
decisões, notas, tentativas e incertezas — que é onde está toda a substância — só é buscado com
`--deep`.

Efeito prático medido: `cogitlog query embeddings` devolveu **`No results`** num store que tinha
uma nota inteira sobre embeddings. Quem chega novo conclui que o acervo está vazio e para de usar.

Resolva. Opções a avaliar (escolha e justifique): tornar `--deep` o padrão e oferecer `--shallow`;
ou manter o padrão e, quando o resultado raso vier vazio, rodar o deep automaticamente avisando;
ou no mínimo imprimir `No results (try --deep)`. A pior opção é a atual, que falha em silêncio.

## Defeito 2 — falta o campo que a OKF acertou: `description`

O cérebro OKF (o sistema de notas em `~/.claude/yaoyao/memory/`) tem uma propriedade que faz um
acervo de 200 notas ser navegável: **toda nota carrega uma `description:` de uma linha**. Dá para
varrer o corpus inteiro lendo só essas linhas e decidir o que abrir.

O cogitlog não tem equivalente por evento. É a causa-raiz do Defeito 1: como não há resumo, a
busca rasa não tem em que casar, e por isso precisa varrer o corpo inteiro.

Proposta a implementar: um campo curto de resumo por evento (`--summary` / `-s`, ou primeira linha
do corpo tratada como resumo), indexado, e usado por `query`, `log` e `show`. Alinhar a
nomenclatura com a OKF (`description`), não inventar um terceiro nome.

Considere também adotar o resto da forma OKF onde fizer sentido: **tipo** do evento já existe;
faltam **links** entre sessões (algo como `[[session-id]]` ou `--relates-to`) para que uma decisão
possa apontar a que a substituiu.

## Defeito 3 — `init` só ensina a ESCREVER, não a LER

Hoje `cogitlog init` acrescenta ao `CLAUDE.md` / `AGENTS.md` / `.github/copilot-instructions.md`
um bloco `## cogitlog` que só explica como **registrar** (`begin`, `decision`, `attempt`,
`uncertainty`, `close`).

Falta a metade mais importante para quem herda um repositório: **como consultar**, e o fato de que
dá para consultar **sem instalar nada**. O bloco deve dizer, em substância:

> Este repositório usa cogitlog para registrar as decisões importantes.
> Para consultar: `npm i -g cogitlog` e então `cogitlog log` / `cogitlog query "<termo>" --deep`.
> Sem instalar nada: os registros são JSONL legível em `.cogitlog/sessions/` — pode ler direto.

Esse último ponto é o que mais importa: o valor do store não pode depender de instalar a CLI.
Inclua também a orientação de **ler antes de editar** código que pareça arbitrário, porque as
entradas `attempt ... failed` existem para evitar que alguém repita um beco sem saída.

## Defeito 4 — store órfão sem índice não se anuncia

Um `.cogitlog/` criado por versão antiga tem só `sessions/`, sem `index.jsonl` nem `config.json`.
A CLI nova responde **`No sessions`** — mesmo com 17 arquivos de sessão presentes e íntegros.

Existe `cogitlog repair`, que reconstruiu os 17 na hora. Mas ninguém descobre que precisa dele: a
mensagem é indistinguível de "este repo não tem nada registrado".

Resolva: detectar `sessions/` não-vazio com índice ausente/desatualizado e ou reparar sozinho, ou
dizer `17 sessões encontradas mas o índice está ausente — rode 'cogitlog repair'`.

## Como trabalhar

Use o próprio cogitlog neste repo enquanto trabalha (dogfooding): abra a sessão, registre as
decisões e as alternativas rejeitadas, e feche. Se alguma dessas mudanças for incompatível com
stores existentes, registre isso como `uncertainty` e proponha o caminho de migração — há stores
reais em uso em `~/checkgrow/checkgrow-back`, `~/workspace/staycloud-frontned` e
`~/workspace/waster-backend`.

Priorize na ordem: **3 → 1 → 4 → 2**. O 3 é o que trava adoção por quem herda um repo, e é o mais
barato. O 2 é o mais profundo e provavelmente pede uma versão de formato.
