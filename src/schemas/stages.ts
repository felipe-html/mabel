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

export interface PlanCriterion {
  id: string;
  texto: string;
  verificacao: 'teste' | 'humano';
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

export interface ExecuteOutput {
  resumo: string;
  criterios: { id: string; testes: { arquivo: string; nome: string }[] }[];
  suposicoes: Assumption[];
  perguntas: Question[];
}

export interface ReviewOutput {
  aprovado: boolean;
  criterios: { id: string; atendido: boolean; evidencia: string }[];
  problemas: { gravidade: 'bloqueante' | 'menor'; descricao: string; arquivo?: string }[];
}

export const planSchema: Schema = object({
  resumo: str,
  criterios: {
    type: 'array',
    items: object({ id: str, texto: str, verificacao: { type: 'string', enum: ['teste', 'humano'] } }),
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
});

export const reviewSchema: Schema = object({
  aprovado: { type: 'boolean' },
  criterios: { type: 'array', items: object({ id: str, atendido: { type: 'boolean' }, evidencia: str }) },
  problemas: {
    type: 'array',
    items: object(
      { gravidade: { type: 'string', enum: ['bloqueante', 'menor'] }, descricao: str, arquivo: str },
      ['arquivo'],
    ),
  },
});
