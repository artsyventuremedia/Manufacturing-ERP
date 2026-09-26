import { type FieldError, ValidationError } from '@manuling/kernel';
import { type PipeTransform } from '@nestjs/common';
import { type z } from 'zod';

export function zodIssuesToFieldErrors(issues: readonly z.core.$ZodIssue[]): FieldError[] {
  return issues.map((issue) => ({
    path: issue.path.map(String).join('.') || '$',
    code: `validation.${issue.code}`,
    message: issue.message,
  }));
}

/** Parses `value` or throws a ValidationError carrying per-field errors (→ 422). */
export function parseWith<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new ValidationError(
    'http.request_invalid',
    'The request is invalid',
    {},
    zodIssuesToFieldErrors(result.error.issues),
  );
}

/** `@Body(new ZodPipe(schema))` / `@Query(new ZodPipe(schema))`. */
export class ZodPipe<S extends z.ZodType> implements PipeTransform<unknown, z.output<S>> {
  constructor(private readonly schema: S) {}

  transform(value: unknown): z.output<S> {
    return parseWith(this.schema, value);
  }
}
