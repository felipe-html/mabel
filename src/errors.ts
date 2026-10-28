import { JSON_VERSION } from './json.ts';

/**
 * Motivo de um erro, para quem lê a CLI com `--json` (`docs/specs/integracao-externa.md`).
 * Código novo não muda a versão; mudar o sentido de um muda.
 */
export type ErrorCode =
  | 'argumento_faltando'
  | 'argumento_invalido'
  | 'saldo_baixo'
  | 'nao_encontrado'
  | 'estado_invalido'
  | 'nao_e_projeto'
  | 'supervisor_indisponivel'
  | 'falha_etapa'
  | 'interno';

let json = false;

/** Liga o erro em JSON; o `cli.ts` liga quando o comando recebe `--json`. */
export function setJsonErrors(on: boolean): void {
  json = on;
}

/**
 * Escreve o erro no stderr e devolve 1. Em texto, a mensagem e o uso (se houver); com
 * `--json`, uma linha `{"versao":1,"erro":{"codigo":…,"mensagem":…}}`.
 */
export function fail(code: ErrorCode, message: string, usage?: string): number {
  if (json) {
    process.stderr.write(`${JSON.stringify({ versao: JSON_VERSION, erro: { codigo: code, mensagem: message.trim() } })}\n`);
  } else {
    process.stderr.write(`${message}\n${usage ? `Uso: ${usage}\n` : ''}`);
  }
  return 1;
}
