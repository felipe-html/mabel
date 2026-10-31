# Especificação — Saldo eficiente e sempre visível

Até aqui, o saldo só é lido quando uma run acontece. O uso feito fora do Mabel (o Claude
Code interativo usa a mesma conta) não aparece até a run seguinte. A política usa um
limiar fixo de 30% que não considera o tamanho da etapa, e o saldo só aparece no início
do modo Mabel, no `/status` e no quadro.

Esta spec muda a "Política de saldo" do contrato (autorizado pelo usuário em 2026-10-12)
e acrescenta um rodapé fixo com o saldo.

Termina com `npm run check` verde, critérios atendidos, `docs/CONTRATO.md` e
`docs/PLANO.md` atualizados e um commit.

## Decisões

| Tema | Decisão |
|---|---|
| Leitura antiga | Mais de **30 min**. Antes de cada etapa, uma leitura ausente, vencida ou antiga provoca a chamada mínima. |
| Consumo por etapa | Medido pela própria auditoria: a última leitura da run menos a primeira, por janela, quando as duas pertencem à mesma janela (mesmo `resets_at`). Estimativa = média das últimas 10 amostras da etapa (`plan`, `execute`, `review`). Precisa de pelo menos 3. |
| Projeção | Com estimativa, a fila pergunta quando o saldo **depois da etapa** ficaria abaixo do **piso de 10%**. Sem estimativa, vale o limiar de 30% de antes. |
| Ritmo da janela de 7 dias | O uso esperado é a fração da janela já decorrida. **Acima do ritmo** quando o uso depois da etapa passa do esperado em mais de **10 pontos**. Isso aparece no rodapé e é critério da política. |
| Ritmo como critério | A fila pergunta. A autorização vale até o reset da janela de 5h em curso. Sem autorização, aguarda até o ritmo alcançar o uso e retoma sozinha. |
| Precedência | 7 dias abaixo do piso → ritmo → 5h abaixo do piso. |
| Visibilidade | Rodapé fixo na última linha do terminal, no modo Mabel e no `mabel rodar` com TTY. Fora de TTY ou com menos de 10 linhas, não há rodapé. |

## Ritmo

```
início   = resets_at − 7 dias
esperado = (agora − início) / 7 dias          (0–1)
usado    = utilization (+ estimativa da etapa, na política)
acima do ritmo   quando usado > esperado + 0,10
com folga        quando usado < esperado − 0,10
no ritmo         nos demais casos
alcança em       início + (usado − 0,10) × 7 dias
```

## API (`src/balance.ts`)

```ts
STALE_AFTER_MS = 30 * 60_000; BALANCE_FLOOR = 0.1; PACE_MARGIN = 0.1; MIN_SAMPLES = 3

stageEstimate(db, stage): Partial<Record<BalanceWindow, number>>
paceOf(reading, now): { expected: number; state: 'ahead' | 'on' | 'behind' }

checkBalance(readings, now, estimate = {}):
    { action: 'proceed' }
  | { action: 'refresh'; reason: 'missing' | 'expired' | 'stale' }
  | { action: 'ask'; window; balance; estimate?: number }
  | { action: 'pace'; used: number; expected: number; caughtUpAt: Date }

renderBalanceFooter(readings, now, width, paint): string
onBalanceChange(listener): () => void      // o runner avisa a cada leitura gravada
```

## Rodapé (`src/footer.ts`)

```
 5h ███████░░░ 72% · reset 16:40 │ 7d █████████░ 89% · sex 09:00 · no ritmo │ leitura de 3 min
```

- Região de rolagem (`DECSTBM`) nas linhas `1..rows−1`; o rodapé fica na última linha.
- Redesenhado a cada leitura nova (`onBalanceChange`), a cada 30 s (idade da leitura e
  vencimento) e ao redimensionar o terminal.
- Quem limpa a tela até o fim (`\x1b[0J`: editor de linha, menu) usa `clearBelow()`,
  que redesenha o rodapé.
- Em larguras menores, perde primeiro a idade da leitura, depois os resets e por fim as
  barras.
- Ao sair, a região é restaurada e a última linha, limpa.

## Critérios de aceite

1. `checkBalance` com leitura de mais de 30 min pede atualização (`stale`).
2. `stageEstimate` ignora pares de leituras de janelas diferentes, exige 3 amostras e
   usa as 10 mais recentes.
3. Com estimativa, 5h a 15% livre e etapa de 2% segue; 5h a 11% e etapa de 2% pergunta.
4. Sem estimativa, o limiar de 30% continua valendo.
5. Uso de 7 dias acima do ritmo pergunta pelo ritmo; fora de TTY, a fila espera até o
   ritmo alcançar e retoma (teste com relógio injetado).
6. `renderBalanceFooter` cabe em `width` e marca leitura vencida.
7. O rodapé fica ativo no modo Mabel e no `mabel rodar` com TTY; verificado num
   pseudo-terminal.
8. `docs/CONTRATO.md` com a política nova.

## Fora desta spec

- Saldo estimado ao vivo durante uma etapa longa. Hoje só há leituras no início e no fim
  de cada run.
- Estimativa por modelo além da etapa, para considerar o escalonamento.
- Calibrar o piso, a margem do ritmo e a idade máxima com dados reais.
