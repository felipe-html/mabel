/** Subconjunto de JSON Schema usado pelos esquemas das etapas. */
export interface Schema {
  type?: 'object' | 'array' | 'string' | 'boolean' | 'number' | 'integer';
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: Schema;
  enum?: unknown[];
  description?: string;
}

function typeOf(value: unknown): string {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

/** Erros de validação de `value` contra `schema`; lista vazia quando é válido. */
export function validate(schema: Schema, value: unknown, path = '$'): string[] {
  const actual = typeOf(value);
  if (schema.type) {
    const ok = schema.type === actual || (schema.type === 'number' && actual === 'integer');
    if (!ok) return [`${path}: esperado ${schema.type}, veio ${actual}`];
  }
  if (schema.enum && !schema.enum.includes(value)) {
    return [`${path}: valor ${JSON.stringify(value)} fora de ${JSON.stringify(schema.enum)}`];
  }
  const errors: string[] = [];
  if (actual === 'object' && (schema.properties || schema.required)) {
    const object = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in object)) errors.push(`${path}.${key}: obrigatório`);
    }
    for (const [key, child] of Object.entries(object)) {
      const sub = schema.properties?.[key];
      if (sub) errors.push(...validate(sub, child, `${path}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${path}.${key}: campo não previsto`);
    }
  }
  if (actual === 'array' && schema.items) {
    (value as unknown[]).forEach((child, i) => errors.push(...validate(schema.items as Schema, child, `${path}[${i}]`)));
  }
  return errors;
}
