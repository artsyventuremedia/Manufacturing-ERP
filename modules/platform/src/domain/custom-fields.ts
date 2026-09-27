import { type FieldError, LocalDate, ValidationError, newId, toDecimal } from '@manuling/kernel';

/** Supported custom field types (plan C3). */
export const FIELD_TYPES = [
  'text',
  'long_text',
  'integer',
  'decimal',
  'boolean',
  'date',
  'datetime',
  'select',
  'multi_select',
  'email',
  'url',
  'phone',
  'reference',
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

/** Translated label: language tag → text, e.g. `{ en: 'Capacity', kn: 'ಸಾಮರ್ಥ್ಯ' }`. */
export type I18nText = Readonly<Record<string, string>>;

export interface SelectOption {
  readonly value: string;
  readonly label: I18nText;
}

export interface FieldSettings {
  readonly maxLength?: number;
  readonly min?: string;
  readonly max?: string;
  readonly scale?: number;
  /** Reference target entity, e.g. `platform.plant` or `custom.mould`. */
  readonly target?: string;
}

export interface FieldDef {
  readonly id: string;
  readonly entity: string;
  readonly apiName: string;
  readonly dataType: FieldType;
  readonly label: I18nText;
  readonly help: I18nText | null;
  readonly required: boolean;
  readonly defaultValue: JsonValue | null;
  readonly options: readonly SelectOption[] | null;
  readonly settings: FieldSettings;
  readonly position: number;
  readonly status: 'active' | 'archived';
  readonly version: number;
}

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type ExtValues = Record<string, JsonValue>;

const ENTITY = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;
const API_NAME = /^[a-z][a-zA-Z0-9]{1,39}$/;
const LANG = /^[a-z]{2,3}(-[A-Z]{2})?$/;
const OPTION_VALUE = /^[A-Za-z0-9_-]{1,64}$/;
const DECIMAL = /^[+-]?\d+(\.\d+)?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const PHONE = /^\+?[0-9][0-9 ()-]{5,19}$/;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/;

export interface FieldDefContext {
  /** Whether `entity` can carry custom fields (registered core entity or existing custom object). */
  readonly isExtensible: (entity: string) => boolean;
  /** Whether `entity` can be the target of a reference field. */
  readonly isReferenceable: (entity: string) => boolean;
}

export interface NewFieldDef {
  readonly entity: string;
  readonly apiName: string;
  readonly dataType: string;
  readonly label: unknown;
  readonly help?: unknown;
  readonly required?: boolean | undefined;
  readonly defaultValue?: unknown;
  readonly options?: unknown;
  readonly settings?: unknown;
  readonly position?: number | undefined;
}

/** Validates a new field definition (types, settings, options, default) with JSON paths. */
export function createFieldDef(input: NewFieldDef, ctx: FieldDefContext): FieldDef {
  const errors: FieldError[] = [];
  const fail = (path: string, message: string) =>
    errors.push({ path, code: 'platform.custom_field.invalid', message });

  if (!ENTITY.test(input.entity) || !ctx.isExtensible(input.entity))
    fail('entity', 'This entity cannot have custom fields');
  if (!API_NAME.test(input.apiName))
    fail('apiName', 'Use 2–40 characters, camelCase, starting with a lowercase letter');
  const dataType = (FIELD_TYPES as readonly string[]).includes(input.dataType)
    ? (input.dataType as FieldType)
    : undefined;
  if (!dataType) fail('dataType', `Use one of: ${FIELD_TYPES.join(', ')}`);
  const label = parseI18n(input.label, 'label', fail, true);
  const help =
    input.help === undefined || input.help === null
      ? null
      : parseI18n(input.help, 'help', fail, false);
  const settings = dataType ? parseSettings(dataType, input.settings, ctx, fail) : {};
  const options = dataType ? parseOptions(dataType, input.options, fail) : null;

  const partial: FieldDef = {
    id: newId(),
    entity: input.entity,
    apiName: input.apiName,
    dataType: dataType ?? 'text',
    label: label ?? {},
    help,
    required: input.required ?? false,
    defaultValue: null,
    options,
    settings,
    position: input.position ?? 0,
    status: 'active',
    version: 1,
  };
  let defaultValue: JsonValue | null = null;
  if (
    input.defaultValue !== undefined &&
    input.defaultValue !== null &&
    dataType &&
    errors.length === 0
  ) {
    const result = coerceValue(partial, input.defaultValue);
    if ('error' in result) fail('defaultValue', result.error);
    else defaultValue = result.value;
  }
  if (errors.length > 0) {
    throw new ValidationError(
      'platform.custom_field.invalid',
      'The custom field definition is invalid',
      {},
      errors,
    );
  }
  return { ...partial, defaultValue };
}

export interface FieldDefChanges {
  readonly label?: unknown;
  readonly help?: unknown;
  readonly required?: boolean | undefined;
  readonly defaultValue?: unknown;
  readonly options?: unknown;
  readonly position?: number | undefined;
  readonly status?: 'active' | 'archived' | undefined;
}

/**
 * Editable parts of a field. Options can be relabelled or added but never removed, because
 * stored values would become invalid. Entity, name and type are fixed (DB trigger too).
 */
export function changeFieldDef(def: FieldDef, changes: FieldDefChanges): FieldDef {
  const errors: FieldError[] = [];
  const fail = (path: string, message: string) =>
    errors.push({ path, code: 'platform.custom_field.invalid', message });
  const label =
    changes.label === undefined
      ? def.label
      : (parseI18n(changes.label, 'label', fail, true) ?? def.label);
  const help =
    changes.help === undefined
      ? def.help
      : changes.help === null
        ? null
        : parseI18n(changes.help, 'help', fail, false);
  let options = def.options;
  if (changes.options !== undefined) {
    options = parseOptions(def.dataType, changes.options, fail);
    const kept = new Set((options ?? []).map((o) => o.value));
    const removed = (def.options ?? []).filter((o) => !kept.has(o.value)).map((o) => o.value);
    if (removed.length > 0)
      fail('options', `Options cannot be removed (stored values use them): ${removed.join(', ')}`);
  }
  const next: FieldDef = {
    ...def,
    label,
    help,
    options,
    required: changes.required ?? def.required,
    position: changes.position ?? def.position,
    status: changes.status ?? def.status,
  };
  let defaultValue = def.defaultValue;
  if (changes.defaultValue !== undefined && errors.length === 0) {
    if (changes.defaultValue === null) defaultValue = null;
    else {
      const result = coerceValue(next, changes.defaultValue);
      if ('error' in result) fail('defaultValue', result.error);
      else defaultValue = result.value;
    }
  }
  if (errors.length > 0) {
    throw new ValidationError(
      'platform.custom_field.invalid',
      'The custom field change is invalid',
      {},
      errors,
    );
  }
  return { ...next, defaultValue };
}

// ----- values -----------------------------------------------------------------------------

export interface ReferenceCheck {
  readonly path: string;
  readonly target: string;
  readonly id: string;
}

export interface PreparedValues {
  readonly values: ExtValues;
  /** References to verify against the database (same tenant, correct type). */
  readonly references: readonly ReferenceCheck[];
}

/**
 * Validates and normalises custom values for a write (plan C2).
 * - `existing` undefined = create (defaults applied); otherwise the input is merged over the
 *   stored values and `null` clears a key.
 * - Unknown keys and writes to archived fields are rejected; required fields must end up set.
 * - Values of archived fields already stored are kept untouched.
 */
export function prepareValues(
  defs: readonly FieldDef[],
  input: unknown,
  existing: ExtValues | undefined,
  prefix: string,
): PreparedValues {
  const errors: FieldError[] = [];
  const fail = (path: string, message: string, code = 'platform.custom_field.value_invalid') =>
    errors.push({ path, code, message });
  if (
    input !== undefined &&
    (typeof input !== 'object' || input === null || Array.isArray(input))
  ) {
    throw new ValidationError(
      'platform.custom_field.value_invalid',
      `${prefix} must be an object`,
      {},
      [{ path: prefix, code: 'platform.custom_field.value_invalid', message: 'Must be an object' }],
    );
  }
  const byName = new Map(defs.map((d) => [d.apiName, d]));
  const values: ExtValues = { ...(existing ?? {}) };
  const references: ReferenceCheck[] = [];

  if (existing === undefined) {
    for (const def of defs)
      if (def.status === 'active' && def.defaultValue !== null)
        values[def.apiName] = def.defaultValue;
  }
  for (const [key, raw] of Object.entries((input ?? {}) as Record<string, unknown>)) {
    const path = `${prefix}.${key}`;
    const def = byName.get(key);
    if (!def) {
      fail(path, 'Unknown custom field', 'platform.custom_field.unknown');
      continue;
    }
    if (def.status !== 'active') {
      fail(path, 'This custom field is archived', 'platform.custom_field.archived');
      continue;
    }
    if (raw === null) {
      delete values[key];
      continue;
    }
    const result = coerceValue(def, raw);
    if ('error' in result) {
      fail(path, result.error);
      continue;
    }
    values[key] = result.value;
    if (def.dataType === 'reference' && def.settings.target) {
      references.push({ path, target: def.settings.target, id: result.value as string });
    }
  }
  for (const def of defs) {
    if (
      def.status === 'active' &&
      def.required &&
      (values[def.apiName] === undefined || values[def.apiName] === null)
    ) {
      fail(`${prefix}.${def.apiName}`, 'This field is required', 'platform.custom_field.required');
    }
  }
  if (errors.length > 0) {
    throw new ValidationError(
      'platform.custom_field.value_invalid',
      'Some custom fields are invalid',
      {},
      errors,
    );
  }
  return { values, references };
}

/** Type check and normalisation of one value. */
export function coerceValue(def: FieldDef, raw: unknown): { value: JsonValue } | { error: string } {
  const s = def.settings;
  switch (def.dataType) {
    case 'text':
    case 'long_text': {
      if (typeof raw !== 'string') return { error: 'Must be text' };
      const v = def.dataType === 'text' ? raw.trim() : raw;
      const max = s.maxLength ?? (def.dataType === 'text' ? 255 : 10_000);
      return v.length > max ? { error: `At most ${max} characters` } : { value: v };
    }
    case 'integer': {
      if (typeof raw !== 'number' || !Number.isSafeInteger(raw))
        return { error: 'Must be a whole number' };
      return withinRange(String(raw), s) ?? { value: raw };
    }
    case 'decimal': {
      const text = typeof raw === 'number' && Number.isSafeInteger(raw) ? String(raw) : raw;
      if (typeof text !== 'string' || !DECIMAL.test(text.trim()))
        return { error: 'Must be a decimal number as a string, e.g. "12.50"' };
      const scale = s.scale ?? 2;
      const d = toDecimal(text.trim());
      if (d.decimalPlaces() > scale) return { error: `At most ${scale} decimal places` };
      return withinRange(d.toFixed(), s) ?? { value: d.toFixed(scale) };
    }
    case 'boolean':
      return typeof raw === 'boolean' ? { value: raw } : { error: 'Must be true or false' };
    case 'date':
      try {
        if (typeof raw !== 'string') throw new Error();
        const v = LocalDate.parse(raw).toString();
        return withinRange(v, s, 'text') ?? { value: v };
      } catch {
        return { error: 'Must be a date YYYY-MM-DD' };
      }
    case 'datetime': {
      if (typeof raw !== 'string' || !ISO_DATETIME.test(raw) || Number.isNaN(Date.parse(raw))) {
        return { error: 'Must be an ISO 8601 date-time with a time zone' };
      }
      return { value: new Date(raw).toISOString() };
    }
    case 'select': {
      if (typeof raw !== 'string' || !(def.options ?? []).some((o) => o.value === raw))
        return { error: 'Must be one of the options' };
      return { value: raw };
    }
    case 'multi_select': {
      if (!Array.isArray(raw) || !raw.every((v) => typeof v === 'string'))
        return { error: 'Must be a list of options' };
      const allowed = new Set((def.options ?? []).map((o) => o.value));
      const unknown = raw.filter((v) => !allowed.has(v));
      return unknown.length > 0
        ? { error: `Unknown options: ${unknown.join(', ')}` }
        : { value: [...new Set(raw)] };
    }
    case 'email':
      return typeof raw === 'string' && EMAIL.test(raw.trim()) && raw.length <= 254
        ? { value: raw.trim().toLowerCase() }
        : { error: 'Must be an email address' };
    case 'url': {
      try {
        if (typeof raw !== 'string') throw new Error();
        const u = new URL(raw);
        if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error();
        return raw.length <= 2000 ? { value: u.toString() } : { error: 'At most 2000 characters' };
      } catch {
        return { error: 'Must be an http(s) URL' };
      }
    }
    case 'phone':
      return typeof raw === 'string' && PHONE.test(raw.trim())
        ? { value: raw.trim() }
        : { error: 'Must be a phone number' };
    case 'reference':
      return typeof raw === 'string' && UUID.test(raw)
        ? { value: raw.toLowerCase() }
        : { error: 'Must be a record id' };
  }
}

function withinRange(
  value: string,
  s: FieldSettings,
  kind: 'number' | 'text' = 'number',
): { error: string } | undefined {
  const cmp = (a: string, b: string) =>
    kind === 'text' ? (a < b ? -1 : a > b ? 1 : 0) : toDecimal(a).comparedTo(toDecimal(b));
  if (s.min !== undefined && cmp(value, s.min) < 0) return { error: `Must be at least ${s.min}` };
  if (s.max !== undefined && cmp(value, s.max) > 0) return { error: `Must be at most ${s.max}` };
  return undefined;
}

// ----- definitions: parts -------------------------------------------------------------------

function parseI18n(
  raw: unknown,
  path: string,
  fail: (p: string, m: string) => void,
  required: boolean,
): I18nText | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    fail(path, 'Give translations as { "en": "…", "kn": "…" }');
    return null;
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (required && entries.length === 0) fail(path, 'At least one translation is required');
  const out: Record<string, string> = {};
  for (const [lang, text] of entries) {
    if (!LANG.test(lang) || typeof text !== 'string' || !text.trim() || text.length > 200) {
      fail(`${path}.${lang}`, 'Use a language tag and 1–200 characters');
    } else out[lang] = text.trim();
  }
  return out;
}

function parseSettings(
  type: FieldType,
  raw: unknown,
  ctx: FieldDefContext,
  fail: (p: string, m: string) => void,
): FieldSettings {
  const r = (raw ?? {}) as Record<string, unknown>;
  if (
    typeof raw !== 'undefined' &&
    (typeof raw !== 'object' || raw === null || Array.isArray(raw))
  ) {
    fail('settings', 'Settings must be an object');
    return {};
  }
  const out: { -readonly [K in keyof FieldSettings]: FieldSettings[K] } = {};
  if (r['maxLength'] !== undefined) {
    const max = type === 'long_text' ? 100_000 : 1000;
    if (
      !['text', 'long_text'].includes(type) ||
      typeof r['maxLength'] !== 'number' ||
      !Number.isInteger(r['maxLength']) ||
      r['maxLength'] < 1 ||
      r['maxLength'] > max
    ) {
      fail('settings.maxLength', `maxLength applies to text (1–1000) and long_text (1–100000)`);
    } else out.maxLength = r['maxLength'];
  }
  if (r['scale'] !== undefined) {
    if (
      type !== 'decimal' ||
      typeof r['scale'] !== 'number' ||
      !Number.isInteger(r['scale']) ||
      r['scale'] < 0 ||
      r['scale'] > 6
    ) {
      fail('settings.scale', 'scale applies to decimal fields (0–6)');
    } else out.scale = r['scale'];
  }
  for (const bound of ['min', 'max'] as const) {
    const v = r[bound];
    if (v === undefined) continue;
    const ok =
      (['integer', 'decimal'].includes(type) && typeof v === 'string' && DECIMAL.test(v)) ||
      (type === 'date' && typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v));
    if (!ok)
      fail(
        `settings.${bound}`,
        `${bound} must be a number string (integer/decimal) or a date (date)`,
      );
    else out[bound] = v;
  }
  if (type === 'reference') {
    const target = r['target'];
    if (typeof target !== 'string' || !ctx.isReferenceable(target))
      fail('settings.target', 'Give a referenceable entity');
    else out.target = target;
  }
  return out;
}

function parseOptions(
  type: FieldType,
  raw: unknown,
  fail: (p: string, m: string) => void,
): SelectOption[] | null {
  if (type !== 'select' && type !== 'multi_select') {
    if (raw !== undefined && raw !== null) fail('options', 'Options apply only to select fields');
    return null;
  }
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 200) {
    fail('options', 'Give 1–200 options');
    return null;
  }
  const seen = new Set<string>();
  const out: SelectOption[] = [];
  raw.forEach((o, i) => {
    const value = (o as { value?: unknown } | null)?.value;
    if (typeof value !== 'string' || !OPTION_VALUE.test(value) || seen.has(value)) {
      fail(`options.${i}.value`, 'Use a unique value of letters, digits, "_" or "-"');
      return;
    }
    seen.add(value);
    const label = parseI18n((o as { label?: unknown }).label, `options.${i}.label`, fail, true);
    out.push({ value, label: label ?? {} });
  });
  return out;
}

/** Best label for a locale: exact tag, then language, then English, then any. */
export function labelFor(text: I18nText | null, locale: string, fallback: string): string {
  if (!text) return fallback;
  const lang = locale.split('-')[0]!;
  return text[locale] ?? text[lang] ?? text['en'] ?? Object.values(text)[0] ?? fallback;
}

// ----- filters ----------------------------------------------------------------------------------

export type FilterOp = 'eq' | 'gt' | 'gte' | 'lt' | 'lte';

export interface ValueFilter {
  readonly field: string;
  readonly op: FilterOp;
  readonly dataType: FieldType;
  readonly value: JsonValue;
}

const FILTER_KEY = /^(?<prefix>[a-z]+)\.(?<field>[a-zA-Z0-9]+)(\[(?<op>eq|gt|gte|lt|lte)\])?$/;
const RANGE_TYPES = new Set<FieldType>(['integer', 'decimal', 'date', 'datetime']);

/**
 * Parses list filters like `ext.capacity[gte]=100` or `data.status=open` from query params,
 * validating field names and operators and coercing values to the field type.
 */
export function parseFilters(
  query: Readonly<Record<string, unknown>>,
  prefix: string,
  defs: readonly FieldDef[],
): ValueFilter[] {
  const byName = new Map(defs.filter((d) => d.status === 'active').map((d) => [d.apiName, d]));
  const filters: ValueFilter[] = [];
  const errors: FieldError[] = [];
  for (const [key, raw] of Object.entries(query)) {
    const m = FILTER_KEY.exec(key);
    if (!m?.groups || m.groups['prefix'] !== prefix) continue;
    const def = byName.get(m.groups['field']!);
    const op = (m.groups['op'] ?? 'eq') as FilterOp;
    if (!def) {
      errors.push({
        path: key,
        code: 'platform.custom_field.filter_invalid',
        message: 'Unknown custom field',
      });
      continue;
    }
    if (op !== 'eq' && !RANGE_TYPES.has(def.dataType)) {
      errors.push({
        path: key,
        code: 'platform.custom_field.filter_invalid',
        message: `${op} is not supported for ${def.dataType}`,
      });
      continue;
    }
    const text: unknown = Array.isArray(raw) ? (raw as unknown[])[0] : raw;
    if (typeof text !== 'string') continue;
    const parsed =
      def.dataType === 'integer'
        ? coerceValue(def, /^-?\d+$/.test(text) ? Number(text) : text)
        : def.dataType === 'boolean'
          ? coerceValue(def, text === 'true' ? true : text === 'false' ? false : text)
          : def.dataType === 'multi_select'
            ? coerceValue({ ...def, dataType: 'select' }, text)
            : def.dataType === 'decimal'
              ? coerceValue({ ...def, settings: { scale: 6 } }, text)
              : coerceValue({ ...def, settings: {} }, text);
    if ('error' in parsed) {
      errors.push({
        path: key,
        code: 'platform.custom_field.filter_invalid',
        message: parsed.error,
      });
      continue;
    }
    filters.push({ field: def.apiName, op, dataType: def.dataType, value: parsed.value });
  }
  if (errors.length > 0)
    throw new ValidationError('platform.custom_field.filter_invalid', 'Invalid filter', {}, errors);
  return filters;
}
