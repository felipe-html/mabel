import { latestReadings, onBalanceChange, renderBalanceFooter } from './balance.ts';
import { openDb } from './db.ts';
import { paint, style } from './style.ts';

/** Abaixo disso o terminal fica sem rodapé: a área de rolagem ficaria apertada demais. */
export const FOOTER_MIN_ROWS = 10;

/** Redesenho periódico: idade da leitura e vencimento das janelas mudam sem leitura nova. */
const REFRESH_MS = 30_000;

let active: { draw: () => void } | undefined;

/** Linha do rodapé com a leitura atual do banco. */
export function footerLine(width: number, now = new Date()): string {
  try {
    const db = openDb();
    try {
      return renderBalanceFooter(latestReadings(db), now, width, paint);
    } finally {
      db.close();
    }
  } catch (error) {
    return style.dim(` saldo indisponível: ${(error as Error).message}`.slice(0, width));
  }
}

/** Redesenha o rodapé, se houver. Quem limpa a tela até o fim (`\x1b[0J`) chama depois. */
export function redrawFooter(): void {
  active?.draw();
}

/**
 * Reserva a última linha do terminal para o saldo: a rolagem fica nas linhas acima dela.
 * Só no TTY; uma segunda chamada enquanto há rodapé não faz nada. Devolve a função que o
 * desfaz.
 */
export function startFooter(stream: NodeJS.WriteStream = process.stdout): () => void {
  if (active || !stream.isTTY || process.env.MABEL_RODAPE === '0') return () => {};

  let rows = 0;
  let reserved = false;

  const release = () => {
    if (!reserved) return;
    stream.write(`\x1b7\x1b[r\x1b[${rows};1H\x1b[2K\x1b8`);
    reserved = false;
  };

  const reserve = (first: boolean) => {
    release();
    rows = stream.rows ?? 0;
    if (rows < FOOTER_MIN_ROWS) return;
    // Na primeira vez, abre uma linha livre embaixo para o cursor não ficar sob o rodapé.
    stream.write(`${first ? '\n\x1b[1A' : ''}\x1b7\x1b[1;${rows - 1}r\x1b8`);
    reserved = true;
  };

  const draw = () => {
    if (!reserved) return;
    stream.write(`\x1b7\x1b[${rows};1H\x1b[2K${footerLine(stream.columns ?? 80)}\x1b8`);
  };

  const onResize = () => {
    reserve(false);
    draw();
  };

  reserve(true);
  draw();
  active = { draw };
  const unsubscribe = onBalanceChange(draw);
  const timer = setInterval(draw, REFRESH_MS);
  timer.unref();
  stream.on('resize', onResize);
  process.on('exit', release);

  return () => {
    if (active?.draw !== draw) return;
    active = undefined;
    clearInterval(timer);
    unsubscribe();
    stream.off('resize', onResize);
    process.off('exit', release);
    release();
  };
}
