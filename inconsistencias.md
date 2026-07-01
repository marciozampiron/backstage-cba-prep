# Inconsistencias e melhorias iniciais

Este arquivo registra o fechamento dos pontos encontrados na primeira revisao do projeto.

## Status atual

- Banco completo: 60 questoes no total, seguindo o budget da blueprint.
- Cobertura por dominio: Development Workflow 14, Infrastructure 13, Catalog 13, Customizing 20.
- Respostas balanceadas: A 15, B 15, C 15, D 15.
- Dificuldade balanceada: 24 easy, 24 medium, 12 hard.
- Fontes auditadas: 14 URLs oficiais, 0 quebradas na ultima validacao.

## Resolvido

### Distribuicao das respostas

As respostas corretas deixaram de ficar concentradas em `A` e agora estao balanceadas entre as quatro alternativas.

### Validador fortalecido

`src/lib/bank.js` agora cobre:

- campos extras no objeto da questao;
- formato e tipo de `options`;
- opcoes duplicadas;
- `tags` como array de strings;
- fontes oficiais do Backstage docs ou LF CBA blueprint;
- IDs sequenciais por arquivo;
- distribuicao global de respostas muito enviesada.

### Package alinhado com a proposta engine-neutral

`package.json` inclui tambem:

- `.claude/`
- `.gemini/`
- `.github/`
- `CLAUDE.md`
- `workflows/`

### Sync documentado corretamente

`AGENTS.md` descreve o comportamento real: o comando compara a pagina oficial com a blueprint local, pode gravar `spec/last-sync.json` com `--write`, e o CI abre issue em caso de drift.

### CI de qualidade criado

`.github/workflows/quality.yml` roda:

- `node bin/cli.js validate`
- `node bin/cli.js stats`
- `node bin/cli.js generate --domain catalog --count 1 --dry-run`
- `npm pack --dry-run`
- `node bin/cli.js audit-sources`

### Feedback do tutor/CLI

O mock agora mostra plano de estudo por competencia, sugere o dominio mais fraco e pode salvar historico local opcional. O historico pode ser visto com `node bin/cli.js history`.

### Auditoria de fontes

`node bin/cli.js audit-sources` checa as URLs citadas pelas questoes. O comando retorna erro (exit 2) apenas para link morto (404/410); 403/429/5xx e falhas de rede sao tratados como soft-fail e nao quebram o CI.

## Validacoes de referencia

- `node bin/cli.js validate`: 60 questoes validas, 0 erros.
- `node bin/cli.js stats`: 60/60 questoes, 100% do budget.
- `node bin/cli.js audit-sources`: 14 URLs unicas, 0 quebradas.
- `npm pack --dry-run`: pacote inclui integracoes de agentes e workflows.
