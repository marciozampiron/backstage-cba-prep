# Release Checklist

Use este checklist antes de publicar uma nova versao.

1. Confirmar que o working tree esta limpo ou que as mudancas esperadas estao revisadas.
2. Rodar `node bin/cli.js validate`.
3. Rodar `node bin/cli.js stats`.
4. Rodar `npm test`.
5. Rodar `node bin/cli.js generate --domain catalog --count 1 --dry-run`.
6. Rodar `node bin/cli.js audit-sources`.
7. Rodar `npm pack --dry-run` e conferir os arquivos listados.
8. Atualizar README, `spec/` e `questions/` se a blueprint ou docs oficiais tiverem mudado.
9. Atualizar `package.json` com a nova versao.
10. Criar tag Git e publicar no npm quando aplicavel.
