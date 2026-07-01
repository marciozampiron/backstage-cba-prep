# Inconsistencias e melhorias iniciais

Este arquivo consolida os pontos encontrados na primeira analise do projeto e o status do tratamento inicial.

## Tratado neste ciclo

### 1. Distribuicao das respostas

Resolvido. As respostas corretas deixaram de ficar todas em `A`.

Distribuicao atual:

| Alternativa | Total |
| --- | ---: |
| A | 10 |
| B | 10 |
| C | 10 |
| D | 9 |

### 2. Validador fortalecido

Resolvido em `src/lib/bank.js`. A validacao agora cobre mais casos alem das regras basicas:

- campos extras no objeto da questao;
- formato e tipo de `options`;
- opcoes duplicadas;
- `tags` como array de strings;
- fontes oficiais do Backstage docs ou LF CBA blueprint;
- IDs sequenciais por arquivo;
- distribuicao global de respostas muito enviesada.

### 3. Package alinhado com a proposta engine-neutral

Resolvido em `package.json`. O pacote npm agora inclui tambem:

- `.claude/`
- `.gemini/`
- `.github/`
- `CLAUDE.md`
- `workflows/`

### 4. Descricao do sync corrigida

Resolvido em `AGENTS.md`. O texto agora diz que o comando compara a pagina oficial com a blueprint local, pode gravar `spec/last-sync.json` com `--write`, e que o CI abre issue em caso de drift.

### 5. CI de qualidade criado

Resolvido em `.github/workflows/quality.yml`.

O workflow roda:

- `node bin/cli.js validate`
- `node bin/cli.js stats`
- `node bin/cli.js generate --domain catalog --count 1 --dry-run`
- `npm pack --dry-run`

## Ainda pendente

### 1. Completar cobertura do banco

Faltam 21 questoes para cobrir o mock completo de 60 questoes.

| Dominio | Atual | Meta | Faltam |
| --- | ---: | ---: | ---: |
| Backstage Development Workflow | 8 | 14 | 6 |
| Backstage Infrastructure | 9 | 13 | 4 |
| Backstage Catalog | 11 | 13 | 2 |
| Customizing Backstage | 11 | 20 | 9 |

Proxima acao recomendada: priorizar `Customizing Backstage`, que tem o maior deficit.

### 2. Melhorar feedback do tutor/CLI

Possiveis melhorias futuras:

- mostrar competencias fracas, nao apenas dominio fraco;
- sugerir links de estudo por competencia;
- salvar historico local opcional de tentativas;
- gerar plano de estudo ao final do mock.

### 3. Criar auditoria de fontes

Possivel comando futuro: `audit-sources`.

Esse comando poderia:

- checar status HTTP das fontes;
- evitar falha dura quando a rede estiver indisponivel;
- gerar avisos em CI para links suspeitos ou quebrados.

## Validacoes executadas

- `node bin/cli.js validate`: 39 questoes validas, 0 erros.
- `npm pack --dry-run`: pacote inclui 35 arquivos, incluindo integracoes de agentes e workflows.
