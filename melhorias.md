# Melhorias

Este arquivo registra as melhorias planejadas e o status de implementacao.

## Implementadas

### Testes automatizados da CLI

- Script: `npm test`.
- Suite: `test/cli.test.js`.
- Cobertura atual:
  - `validate --json`;
  - `stats --json`;
  - `history --json` sem historico local;
  - `generate --dry-run` sem API key;
  - smoke test de `exam` com `--no-save`;
  - `auditSources` com `fetch` mockado, sem rede.

### Matriz Node no CI

`.github/workflows/quality.yml` roda a qualidade em Node 18, 20 e 22. A auditoria de links roda apenas no Node 22 para evitar triplicar chamadas externas.

### Saida JSON para integracoes

Comandos com suporte a `--json`:

- `validate --json`;
- `stats --json`;
- `history --json`;
- `audit-sources --json`.

### Historico local documentado

O README documenta que tentativas de prova sao salvas em `~/.backstage-cba-prep/history.json` e que `--no-save` desativa a gravacao em uma execucao.

### Checklist de release

`RELEASE.md` registra o processo minimo antes de publicar uma versao.

## Futuras

### Melhorar o sync

O comando `sync` ainda usa scraping simples por proximidade de texto. Uma melhoria futura seria registrar mais contexto do HTML/texto detectado e explicar melhor casos de dominio renomeado ou removido.

### Auditoria semantica das questoes

O validador garante estrutura e consistencia local, mas nao prova automaticamente que cada resposta esta correta. Uma melhoria futura seria um comando `review-bank` para amostrar questoes, abrir a fonte e produzir uma fila de revisao humana/IA.

### Exportacao de relatorios

Com `--json` disponivel nos comandos principais, um proximo passo seria gerar relatorios HTML/Markdown de cobertura, historico e links.
