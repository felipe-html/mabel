import type { Schema } from './validate.ts';

const str: Schema = { type: 'string' };
const strings: Schema = { type: 'array', items: str };

function object(properties: Record<string, Schema>, optional: string[] = []): Schema {
  return {
    type: 'object',
    properties,
    required: Object.keys(properties).filter((key) => !optional.includes(key)),
    additionalProperties: false,
  };
}

const assumptions: Schema = {
  type: 'array',
  items: object({ texto: str, regraCritica: { type: 'boolean' } }),
};

/**
 * Pergunta ao humano, com a resposta que o agente proporia (vazia quando não há).
 * `regraCritica` marca a pergunta que toca uma regra crítica do projeto: ela sempre para o item.
 */
export interface Question {
  texto: string;
  sugestao: string;
  regraCritica: boolean;
}

const questions: Schema = {
  type: 'array',
  items: object({ texto: str, sugestao: str, regraCritica: { type: 'boolean' } }),
};

/**
 * `comportamento` diz o que a prova espera do teste no código base: `novo` falha nele,
 * `mantido` passa. Obrigatório no esquema; planos anteriores à prova não têm o campo.
 */
export interface PlanCriterion {
  id: string;
  texto: string;
  verificacao: 'teste' | 'humano';
  comportamento?: 'novo' | 'mantido';
}

export interface Assumption {
  texto: string;
  regraCritica: boolean;
}

export interface PlanOutput {
  resumo: string;
  criterios: PlanCriterion[];
  escopo: string[];
  passos: string[];
  suposicoes: Assumption[];
  conceitosCriticos: string[];
  perguntas: Question[];
}

/** Caminho fora do escopo do plano que a execução precisou alterar, com o motivo. */
export interface ScopeRequest {
  glob: string;
  motivo: string;
}

export interface ExecuteOutput {
  resumo: string;
  criterios: { id: string; testes: { arquivo: string; nome: string }[] }[];
  suposicoes: Assumption[];
  perguntas: Question[];
  /** Obrigatório no esquema; execuções anteriores ao 5.3 não têm o campo. */
  escopoAdicional?: ScopeRequest[];
}

/** Proposta de refinamento de um item do backlog; o humano revisa antes de gravar. */
export interface RefineOutput {
  entendimento: string;
  criterios: string[];
  foraDoEscopo: string[];
  perguntas: Question[];
  conceitosCriticos: string[];
  quebra: { titulo: string; intencao: string }[];
}

/** O parecer não declara aprovação: o Mabel a calcula (`reviewVerdict`). */
export interface ReviewOutput {
  criterios: { id: string; atendido: boolean; evidencia: string }[];
  problemas: { gravidade: 'bloqueante' | 'menor'; descricao: string; arquivo?: string }[];
}

export const refineSchema: Schema = object({
  entendimento: str,
  criterios: strings,
  foraDoEscopo: strings,
  perguntas: questions,
  conceitosCriticos: strings,
  quebra: { type: 'array', items: object({ titulo: str, intencao: str }) },
});

export const planSchema: Schema = object({
  resumo: str,
  criterios: {
    type: 'array',
    items: object({
      id: str,
      texto: str,
      verificacao: { type: 'string', enum: ['teste', 'humano'] },
      comportamento: { type: 'string', enum: ['novo', 'mantido'] },
    }),
  },
  escopo: strings,
  passos: strings,
  suposicoes: assumptions,
  conceitosCriticos: strings,
  perguntas: questions,
});

export const executeSchema: Schema = object({
  resumo: str,
  criterios: {
    type: 'array',
    items: object({ id: str, testes: { type: 'array', items: object({ arquivo: str, nome: str }) } }),
  },
  suposicoes: assumptions,
  perguntas: questions,
  escopoAdicional: { type: 'array', items: object({ glob: str, motivo: str }) },
});

export const reviewSchema: Schema = object({
  criterios: { type: 'array', items: object({ id: str, atendido: { type: 'boolean' }, evidencia: str }) },
  problemas: {
    type: 'array',
    items: object(
      { gravidade: { type: 'string', enum: ['bloqueante', 'menor'] }, descricao: str, arquivo: str },
      ['arquivo'],
    ),
  },
});
