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
  /**
   * Motivo pelo qual a verificação não passa por causa do ambiente (rede, sandbox,
   * permissão), não do código; vazio quando não há. Execuções anteriores não têm o campo.
   */
  impedimento?: string;
}

/** Exemplo de uma regra (Example Mapping): situação → resultado; `resultado` vazio vira pergunta. */
export interface SpecifyExample {
  situacao: string;
  resultado: string;
  borda: boolean;
}

/**
 * Proposta do motor de especificação (`mabel especificar` e `mabel refinar`); o humano
 * responde as perguntas, rodada a rodada, e revisa antes de gravar.
 */
export interface SpecifyOutput {
  historia: string;
  regras: { id: string; texto: string; exemplos: SpecifyExample[] }[];
  /** No máximo 5 por rodada; `regra` é o id da regra cujo exemplo ficou sem resultado. */
  perguntas: (Question & { regra: string })[];
  /** "pergunta → resposta" das rodadas. */
  decisoes: string[];
  foraDoEscopo: string[];
  /** Copiados de `regras-criticas.md`. */
  conceitosCriticos: string[];
  alteracoesRegrasVigentes: { assunto: string; acao: 'incluir' | 'alterar' | 'remover'; texto: string }[];
  /** `dependeDe` usa a posição na lista, como no `nascer`. */
  tarefas: { titulo: string; intencao: string; regras: string[]; dependeDe: number[] }[];
  sugestaoQuebra: { titulo: string; historia: string }[];
  /** Só no avulso `Tipo: bug`; vazios nos outros. */
  reproducao: { passos: string; esperado: string; obtido: string };
}

/** O parecer não declara aprovação: o Mabel a calcula (`reviewVerdict`). */
export interface ReviewOutput {
  criterios: { id: string; atendido: boolean; evidencia: string }[];
  problemas: { gravidade: 'bloqueante' | 'menor'; descricao: string; arquivo?: string }[];
}

export const specifySchema: Schema = object({
  historia: str,
  regras: {
    type: 'array',
    items: object({
      id: str,
      texto: str,
      exemplos: { type: 'array', items: object({ situacao: str, resultado: str, borda: { type: 'boolean' } }) },
    }),
  },
  perguntas: { type: 'array', items: object({ texto: str, sugestao: str, regraCritica: { type: 'boolean' }, regra: str }) },
  decisoes: strings,
  foraDoEscopo: strings,
  conceitosCriticos: strings,
  alteracoesRegrasVigentes: {
    type: 'array',
    items: object({ assunto: str, acao: { type: 'string', enum: ['incluir', 'alterar', 'remover'] }, texto: str }),
  },
  tarefas: {
    type: 'array',
    items: object({ titulo: str, intencao: str, regras: strings, dependeDe: { type: 'array', items: { type: 'integer' } } }),
  },
  sugestaoQuebra: { type: 'array', items: object({ titulo: str, historia: str }) },
  reproducao: object({ passos: str, esperado: str, obtido: str }),
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
  impedimento: str,
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

/** Item do backlog inicial proposto pelo `nascer`; `dependeDe` são posições na própria lista. */
export interface BirthItem {
  titulo: string;
  intencao: string;
  criterios: string[];
  foraDoEscopo: string[];
  decisoes: string[];
  /** Conceitos de `regrasCriticas.conceitos` que o item toca. */
  regrasCriticas: string[];
  dependeDe: number[];
}

/** Proposta de nascimento de um projeto; o humano revisa antes de o Mabel gravar. */
export interface BirthProposal {
  /** Id do catálogo de stacks ou `outra`. */
  stack: string;
  stackMotivo: string;
  /** Vazio quando a raiz já tem `CLAUDE.md`. */
  claudeMd: string;
  /** Com `CLAUDE.md` existente: sugestões, mostradas na revisão e não gravadas. */
  acrescimosClaudeMd: string[];
  regrasCriticas: { caminhos: string[]; conceitos: string[] };
  backlog: BirthItem[];
}

export interface BirthOutput {
  entendimento: string;
  /** Vazio quando a proposta está pronta. */
  perguntas: Question[];
  suposicoes: string[];
  /** Ignorada enquanto houver perguntas. */
  proposta: BirthProposal;
}

export const birthProposalSchema: Schema = object({
  stack: str,
  stackMotivo: str,
  claudeMd: str,
  acrescimosClaudeMd: strings,
  regrasCriticas: object({ caminhos: strings, conceitos: strings }),
  backlog: {
    type: 'array',
    items: object({
      titulo: str,
      intencao: str,
      criterios: strings,
      foraDoEscopo: strings,
      decisoes: strings,
      regrasCriticas: strings,
      dependeDe: { type: 'array', items: { type: 'integer' } },
    }),
  },
});

export const birthSchema: Schema = object({
  entendimento: str,
  perguntas: questions,
  suposicoes: strings,
  proposta: birthProposalSchema,
});
