import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type CriticalRules, DEFAULT_CONTEXT_BUDGET, MABEL_DIR, readCriticalRules } from './project.ts';

/**
 * Contexto hermético (G8): o que o agente recebe do projeto e a conferência do `init`.
 * O `--restricted` não carrega o `CLAUDE.md`; o Mabel injeta os arquivos do projeto.
 */

/** Arquivos de instruções do projeto lidos do worktree, nesta ordem. */
export const CONTEXT_FILES = ['CLAUDE.md', 'AGENTS.md'];

export type ProjectContext =
  | { kind: 'ok'; text: string }
  | { kind: 'over_budget'; reason: string };

function bullet(items: string[]): string {
  return items.length > 0 ? items.map((item) => `- ${item}`).join('\n') : 'Nenhum.';
}

/** Regras críticas do worktree como seção do prompt, já sem os comentários do modelo. */
export function renderCriticalRules(rules: CriticalRules): string {
  if (rules.paths.length === 0 && rules.concepts.length === 0) return '## Regras críticas do projeto\n\nNenhuma.\n';
  return [
    '## Regras críticas do projeto',
    '',
    '### Caminhos',
    '',
    bullet(rules.paths.map((path) => `\`${path}\``)),
    '',
    '### Conceitos',
    '',
    bullet(rules.concepts),
    '',
  ].join('\n');
}

/**
 * Contexto do projeto para o fim do prompt de sistema: `CLAUDE.md` e `AGENTS.md` do
 * worktree e as regras críticas, uma vez cada. Acima do orçamento, o motivo com o tamanho
 * de cada parte.
 */
export function projectContext(worktree: string, maxChars: number = DEFAULT_CONTEXT_BUDGET): ProjectContext {
  const parts: { path: string; text: string }[] = [];
  for (const path of CONTEXT_FILES) {
    const full = join(worktree, path);
    if (existsSync(full)) parts.push({ path, text: `### ${path}\n\n${readFileSync(full, 'utf8').trim()}\n` });
  }
  const files = parts.length > 0 ? [{ path: '', text: '## Contexto do projeto\n' }, ...parts] : [];
  const rules = renderCriticalRules(readCriticalRules(worktree));
  const all = [...files, { path: `${MABEL_DIR}/regras-criticas.md`, text: rules }];
  const total = all.reduce((sum, part) => sum + part.text.length, 0);
  if (total > maxChars) {
    const detail = all
      .filter((part) => part.path)
      .map((part) => `${part.path} ${part.text.length}`)
      .join(', ');
    return {
      kind: 'over_budget',
      reason: `contexto do projeto com ${total} caracteres, acima do orçamento de ${maxChars} (${detail}); reduza os arquivos ou ajuste contexto.maxCaracteres no .mabel/config.json`,
    };
  }
  return { kind: 'ok', text: all.map((part) => part.text).join('\n') };
}

/** Plugins internos do Claude Code, que o `--restricted` mantém. */
export const BUILTIN_PLUGINS = ['cc-plugin-agents-md', 'cc-plugin-telemetry', 'cc-plugin-plugin-authoring'];

/** Agentes internos do Claude Code (2.1.296). */
export const BUILTIN_AGENTS = ['claude', 'claude-code-guide', 'Explore', 'general-purpose', 'Plan', 'statusline-setup'];

function names(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((entry) =>
    typeof entry === 'string' ? entry : typeof entry === 'object' && entry !== null ? String((entry as { name?: unknown }).name) : String(entry),
  );
}

/** Ausente, nulo, lista vazia ou objeto sem chaves (`memory_paths: {}`). */
function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (Array.isArray(value)) return value.length === 0;
  return typeof value === 'object' && Object.keys(value).length === 0;
}

/**
 * Servidores MCP do `init` contra os pedidos pela etapa (só o do Mabel, `--mcp-config`):
 * exatamente os mesmos, todos `connected`. Sem pedido, nenhum.
 */
function mcpViolation(reported: unknown, expected: string[]): string | undefined {
  if (expected.length === 0) return isEmpty(reported) ? undefined : 'mcp_servers';
  const servers = Array.isArray(reported)
    ? reported.map((entry) => {
        const server = (typeof entry === 'object' && entry !== null ? entry : { name: entry }) as { name?: unknown; status?: unknown };
        return { name: String(server.name), status: String(server.status ?? '') };
      })
    : [];
  const extra = servers.filter((server) => !expected.includes(server.name)).map((server) => `+${server.name}`);
  const missing = expected.filter((name) => !servers.some((server) => server.name === name)).map((name) => `-${name}`);
  const down = servers
    .filter((server) => expected.includes(server.name) && server.status !== 'connected')
    .map((server) => `${server.name}: ${server.status || 'sem status'}`);
  const problems = [...extra, ...missing, ...down];
  return problems.length > 0 ? `mcp_servers (${problems.join(', ')})` : undefined;
}

/**
 * Campo do `init` que mostra contexto fora do pedido, ou `undefined` quando a run é
 * hermética: sem memória, MCP além do pedido (`mcpServers`), skills nem comandos, ferramentas iguais às pedidas e só
 * plugins e agentes internos.
 */
export function initViolation(init: Record<string, unknown>, tools: string[], mcpServers: string[] = []): string | undefined {
  if (!isEmpty(init.memory_paths)) return 'memory_paths';
  const mcp = mcpViolation(init.mcp_servers, mcpServers);
  if (mcp) return mcp;
  if (!isEmpty(init.skills)) return 'skills';
  if (!isEmpty(init.slash_commands)) return 'slash_commands';
  const reported = names(init.tools);
  if (!reported) return 'tools ausente';
  const expected = new Set(tools);
  const extra = reported.filter((tool) => !expected.has(tool));
  const missing = tools.filter((tool) => !reported.includes(tool));
  if (extra.length > 0 || missing.length > 0) {
    return `tools (${[...extra.map((t) => `+${t}`), ...missing.map((t) => `-${t}`)].join(', ')})`;
  }
  const plugins = (names(init.plugins) ?? []).filter((name) => !BUILTIN_PLUGINS.includes(name));
  if (plugins.length > 0) return `plugins (${plugins.join(', ')})`;
  const agents = (names(init.agents) ?? []).filter((name) => !BUILTIN_AGENTS.includes(name));
  if (agents.length > 0) return `agents (${agents.join(', ')})`;
  return undefined;
}
