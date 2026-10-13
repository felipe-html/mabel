#!/usr/bin/env node
// Hook PreToolUse do Mabel (G4): nega escrita fora do escopo do item. Lê a chamada no stdin
// e o contexto no arquivo apontado por MABEL_ESCOPO. Falha fechado: qualquer erro nega.
import { appendFileSync, readFileSync } from 'node:fs';

const DENY_ON_ERROR = (reason) =>
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `hook de escopo do Mabel falhou: ${reason}`,
    },
  });

let context;
let input;
try {
  input = JSON.parse(readFileSync(0, 'utf8'));
  const path = process.env.MABEL_ESCOPO;
  if (!path) throw new Error('MABEL_ESCOPO ausente');
  context = JSON.parse(readFileSync(path, 'utf8'));
  const { decideScope, denyOutput } = await import('../src/scope.ts');
  const result = decideScope(input, context);
  appendFileSync(context.log, `${JSON.stringify({ at: new Date().toISOString(), ...result })}\n`);
  if (result.decision === 'deny') process.stdout.write(denyOutput(result.reason));
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error);
  try {
    if (context?.log) {
      appendFileSync(
        context.log,
        `${JSON.stringify({ at: new Date().toISOString(), decision: 'deny', tool: input?.tool_name ?? '', reason: `erro: ${reason}` })}\n`,
      );
    }
  } catch {}
  process.stdout.write(DENY_ON_ERROR(reason));
}
