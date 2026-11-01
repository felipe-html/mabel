import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { formatDuration } from './format.ts';
import { git, tryGit } from './git.ts';
import { matchGlob } from './glob.ts';
import type { ProjectConfig } from './project.ts';
import type { ExecuteOutput, PlanCriterion, PlanOutput } from './schemas/stages.ts';
import { proofTestCommand } from './stacks.ts';
import { shell } from './worktree.ts';

// Prova mecânica (P.2): o teste de um critério `novo` falha no código base e passa no item;
// o de um critério `mantido` passa nos dois.

export type ProofStatus = 'provado' | 'nao_provado' | 'sem_prova';

export interface TestRun {
  arquivo: string;
  nome: string;
  /** Passou no item / na base; ausente quando não rodou. */
  item?: boolean;
  base?: boolean;
}

export interface CriterionProof {
  id: string;
  comportamento: PlanCriterion['comportamento'];
  status: ProofStatus;
  /** Lacuna (`nao_provado`) ou motivo (`sem_prova`). */
  reason?: string;
  tests: TestRun[];
}

export interface ProofResult {
  /** `teste`: cada teste rodou sozinho; `item`: o comando de teste inteiro, uma vez. */
  mode: 'teste' | 'item';
  criteria: CriterionProof[];
  /** O worktree voltou ao estado de antes da prova. */
  restored: boolean;
  /** Erro ao levar o código à base (o worktree é restaurado mesmo assim). */
  error?: string;
  /** Comando usado no lugar do `testeUnico` do config, quando o item trocou o runner. */
  testeUnico?: string;
  /** Teste que nem chegou a rodar no item: a prova parou nele, sem rodar a base. */
  naoRodou?: { criterio: string; nome: string; saida: string };
}

/**
 * Teste da prova em andamento, em `prova-N/progresso.json`: o painel lê dali, porque a prova
 * roda síncrona e cada teste pode levar minutos. `criterio` ausente: o comando de teste inteiro.
 */
export interface ProofProgress {
  criterio?: string;
  lado: 'item' | 'base';
  /** Execuções já encerradas, antes desta. */
  feitos: number;
  total: number;
}

export const PROOF_PROGRESS = 'progresso.json';

/** Testes declarados para o critério que existem no worktree e contêm o nome. */
export function foundTests(worktree: string, tests: { arquivo: string; nome: string }[]): { arquivo: string; nome: string }[] {
  return tests.flatMap((t) => {
    const path = resolve(worktree, t.arquivo);
    const rel = relative(worktree, path);
    if (rel.startsWith('..') || !existsSync(path)) return [];
    try {
      return readFileSync(path, 'utf8').includes(t.nome) ? [{ arquivo: rel, nome: t.nome }] : [];
    } catch {
      return [];
    }
  });
}

export function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Comando de um teste só: `{arquivo}`, `{pasta}` e `{nome}` literais e `{padrao}` (o nome
 * escapado como expressão regular, para os runners que filtram por regex), todos com aspas.
 */
export function singleTestCommand(template: string, test: { arquivo: string; nome: string }): string {
  const values: Record<string, string> = {
    arquivo: test.arquivo,
    pasta: dirname(test.arquivo),
    nome: test.nome,
    padrao: escapeRegExp(test.nome),
  };
  return template.replace(/\{(arquivo|pasta|nome|padrao)\}/g, (_, key: string) => shellQuote(values[key] as string));
}

function lines(output: string): string[] {
  return output.split('\n').filter(Boolean);
}

/** Arquivos que o item mudou desde a base e que não são só de teste. */
export function restorableFiles(worktree: string, base: string, testGlobs: string[]): string[] {
  const changed = lines(git(worktree, 'diff', '--name-only', '--no-renames', base, 'HEAD'));
  return changed.filter((file) => !testGlobs.some((glob) => matchGlob(glob, file)));
}

function status(worktree: string): string {
  return git(worktree, 'status', '--porcelain', '--untracked-files=all');
}

/**
 * Leva os arquivos restauráveis ao código base, roda `fn` e restaura sempre. `restored` é
 * falso quando o `git status` depois difere do de antes: o chamador não pode seguir.
 */
export function withBaseCode<T>(
  worktree: string,
  base: string,
  restorable: string[],
  fn: () => T,
): { value?: T; restored: boolean; error?: string } {
  const before = status(worktree);
  let value: T | undefined;
  let error: string | undefined;
  try {
    const inBase = restorable.filter((file) => tryGit(worktree, 'cat-file', '-e', `${base}:${file}`) !== undefined);
    const created = restorable.filter((file) => !inBase.includes(file));
    if (inBase.length > 0) git(worktree, 'checkout', base, '--', ...inBase);
    for (const file of created) rmSync(join(worktree, file), { force: true });
    value = fn();
  } catch (caught) {
    error = (caught as Error).message;
  } finally {
    try {
      if (restorable.length > 0) {
        git(worktree, 'reset', '-q', '--', ...restorable);
        const inHead = restorable.filter((file) => tryGit(worktree, 'cat-file', '-e', `HEAD:${file}`) !== undefined);
        if (inHead.length > 0) git(worktree, 'checkout', 'HEAD', '--', ...inHead);
        for (const file of restorable.filter((f) => !inHead.includes(f))) rmSync(join(worktree, file), { force: true });
        git(worktree, 'clean', '-fdq', '--', ...restorable);
      }
    } catch (caught) {
      error ??= (caught as Error).message;
    }
  }
  return { value, restored: status(worktree) === before, error };
}

function progress(logDir: string, value: ProofProgress): void {
  writeFileSync(join(logDir, PROOF_PROGRESS), `${JSON.stringify(value)}\n`);
}

function run(command: string, worktree: string, logPath: string): { passed: boolean; output: string } {
  const { code, output } = shell(command, worktree);
  appendFileSync(logPath, `$ ${command}\n${output}\n[saída ${code}]\n\n`);
  return { passed: code === 0, output };
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ');
}

/**
 * O runner chegou a rodar o teste: todo runner do catálogo cita o nome do teste que falha.
 * Falha sem o nome é setup, import ou ambiente quebrado, ou filtro que não achou o teste.
 */
export function testRan(output: string, nome: string): boolean {
  return collapse(output).includes(collapse(nome).trim());
}

function lastLines(text: string, count: number): string {
  return text.trimEnd().split('\n').slice(-count).join('\n');
}

export interface ProofInput {
  worktree: string;
  /** Commit base: `git merge-base HEAD <origem>`. */
  base: string;
  config: Pick<ProjectConfig, 'testeUnico' | 'arquivosDeTeste' | 'verify'>;
  plan: PlanOutput;
  execution: ExecuteOutput;
  logDir: string;
  /** Uma linha por teste rodado, para a saída ao vivo: cada teste pode levar minutos. */
  log?: (line: string) => void;
}

/** Roda a prova no worktree do item. Não muda o estado do item; ver `proofVerdict`. */
export function runProof(input: ProofInput): ProofResult {
  const { worktree, base, config, plan, execution, logDir, log } = input;
  mkdirSync(logDir, { recursive: true });
  const restorable = restorableFiles(worktree, base, config.arquivosDeTeste);
  // Lido no código do item, antes de levar o worktree à base.
  const template = proofTestCommand(config.testeUnico, worktree);
  const adjusted = template !== config.testeUnico && template ? { testeUnico: template } : {};
  const mode = template ? 'teste' : 'item';

  const criteria: CriterionProof[] = plan.criterios
    .filter((c) => c.verificacao === 'teste')
    .map((criterion) => {
      const declared = execution.criterios.find((c) => c.id === criterion.id)?.testes ?? [];
      const tests: TestRun[] = foundTests(worktree, declared);
      const proof: CriterionProof = { id: criterion.id, comportamento: criterion.comportamento, status: 'provado', tests };
      if (!criterion.comportamento) return { ...proof, status: 'sem_prova', reason: 'plano sem comportamento declarado' };
      const inCode = tests.find((t) => restorable.includes(t.arquivo));
      if (inCode) return { ...proof, status: 'sem_prova', reason: `o teste mora no código alterado (\`${inCode.arquivo}\`)` };
      return proof;
    });
  const pending = criteria.filter((c) => c.status === 'provado');
  if (pending.length === 0) return { mode, criteria, restored: true, ...adjusted };

  if (template) {
    // Cada teste roda no item e, se todos rodaram, na base.
    const total = 2 * pending.reduce((sum, criterion) => sum + criterion.tests.length, 0);
    let done = 0;
    const timed = (criterion: CriterionProof, side: 'item' | 'base', test: TestRun) => {
      progress(logDir, { criterio: criterion.id, lado: side, feitos: done++, total });
      log?.(`prova ${criterion.id} no ${side}: \`${test.nome}\`…`);
      const started = Date.now();
      const outcome = run(singleTestCommand(template, test), worktree, join(logDir, `${criterion.id}-${side}.log`));
      const ran = outcome.passed || side === 'base' || testRan(outcome.output, test.nome);
      const verdict = outcome.passed ? 'passou' : ran ? 'falhou' : 'não rodou';
      log?.(`prova ${criterion.id} no ${side}: ${verdict} em ${formatDuration(Date.now() - started)}`);
      return { passed: outcome.passed, ran, output: outcome.output };
    };
    for (const criterion of pending) {
      for (const test of criterion.tests) {
        const outcome = timed(criterion, 'item', test);
        test.item = outcome.passed;
        if (outcome.ran) continue;
        // Os outros testes passariam pelo mesmo setup quebrado: parar poupa minutos por teste.
        for (const other of pending) {
          Object.assign(other, {
            status: 'nao_provado',
            reason:
              other === criterion
                ? `o comando não chegou a rodar o teste \`${test.nome}\` (setup, import ou ambiente quebrado, ou nome que o filtro não acha)`
                : `não verificado: a prova parou no ${criterion.id}`,
          });
        }
        const naoRodou = { criterio: criterion.id, nome: test.nome, saida: lastLines(outcome.output, 40) };
        return { mode, criteria, restored: true, naoRodou, ...adjusted };
      }
    }
    const result = withBaseCode(worktree, base, restorable, () => {
      // Na base, falha sem o nome é esperada: o código que o teste importa ainda não existe.
      for (const criterion of pending) for (const test of criterion.tests) test.base = timed(criterion, 'base', test).passed;
    });
    if (!result.restored || result.error) return { mode, criteria, restored: result.restored, error: result.error, ...adjusted };
    for (const criterion of pending) Object.assign(criterion, judge(criterion));
    return { mode, criteria, restored: true, ...adjusted };
  }

  // Pelo nome: `hasTestCommand` também casaria com `test -f arquivo`, que não é um runner.
  const test = config.verify.find((c) => c.name === 'test') ?? config.verify.find((c) => /test/i.test(c.name));
  if (!test) {
    for (const criterion of pending) Object.assign(criterion, { status: 'sem_prova', reason: 'sem `testeUnico` nem comando de teste no `verify`' });
    return { mode, criteria, restored: true };
  }
  progress(logDir, { lado: 'item', feitos: 0, total: 2 });
  const passedOnItem = run(test.command, worktree, join(logDir, 'item.log')).passed;
  const result = withBaseCode(worktree, base, restorable, () => {
    progress(logDir, { lado: 'base', feitos: 1, total: 2 });
    return run(test.command, worktree, join(logDir, 'base.log')).passed;
  });
  if (!result.restored || result.error) return { mode, criteria, restored: result.restored, error: result.error };
  const expectBaseToFail = pending.some((c) => c.comportamento === 'novo');
  const gap = !passedOnItem
    ? `o comando \`${test.command}\` falha no item`
    : result.value === !expectBaseToFail
      ? undefined
      : expectBaseToFail
        ? `o comando \`${test.command}\` já passava sem a mudança; os testes não protegem os critérios novos`
        : `o comando \`${test.command}\` falha no código anterior; os testes não descrevem o comportamento mantido`;
  for (const criterion of pending) Object.assign(criterion, gap ? { status: 'nao_provado', reason: gap } : {});
  return { mode, criteria, restored: true };
}

/** Resultado de um critério a partir das execuções de cada teste, na base e no item. */
function judge(criterion: CriterionProof): Pick<CriterionProof, 'status' | 'reason'> {
  const failedOnItem = criterion.tests.find((t) => !t.item);
  if (failedOnItem) {
    return { status: 'nao_provado', reason: `o teste \`${failedOnItem.nome}\` falha no item` };
  }
  if (criterion.comportamento === 'novo') {
    const passedOnBase = criterion.tests.find((t) => t.base);
    if (passedOnBase) {
      return {
        status: 'nao_provado',
        reason: `o teste \`${passedOnBase.nome}\` já passava sem a mudança; ele não protege o critério`,
      };
    }
  } else {
    const failedOnBase = criterion.tests.find((t) => !t.base);
    if (failedOnBase) {
      return {
        status: 'nao_provado',
        reason: `o teste \`${failedOnBase.nome}\` falha no código anterior; ele não descreve o comportamento mantido`,
      };
    }
  }
  return { status: 'provado' };
}

/** `provado`, `provado (por item)`, `nao_provado` ou `sem_prova`, como no relatório. */
export function proofLabel(criterion: CriterionProof, mode: ProofResult['mode']): string {
  return criterion.status === 'provado' && mode === 'item' ? 'provado (por item)' : criterion.status;
}

/** Uma entrada por critério: `C1 provado; C2 nao_provado: …`. */
export function proofDetail(result: ProofResult): string {
  const criteria = result.criteria.map((c) => `${c.id} ${proofLabel(c, result.mode)}${c.reason ? `: ${c.reason}` : ''}`);
  if (result.testeUnico) criteria.push(`testes rodados com \`${result.testeUnico}\` (o item passou a usar outro runner)`);
  return criteria.join('; ');
}
