import { OperationalMappingError, UnsupportedOperationalRecordTypeError } from '../errors.js';
import type {
  IntakeMapper,
  IntakeMappingContext,
  OperationalCommand,
  OperationalRecordType,
  OperationalSourceRecord,
} from '../types.js';

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export class IntakeMapperRegistry {
  private readonly mappers = new Map<OperationalRecordType, IntakeMapper>();

  register(mapper: IntakeMapper): this {
    if (this.mappers.has(mapper.recordType)) {
      throw new OperationalMappingError(`Mapper already registered for ${mapper.recordType}`);
    }
    if (!Number.isInteger(mapper.version) || mapper.version < 1) {
      throw new OperationalMappingError(`Mapper version must be a positive integer for ${mapper.recordType}`);
    }
    this.mappers.set(mapper.recordType, mapper);
    return this;
  }

  has(recordType: string): boolean {
    return this.mappers.has(recordType as OperationalRecordType);
  }

  mapRecord(value: unknown, context: IntakeMappingContext): OperationalCommand[] {
    if (!isPlainRecord(value)) {
      throw new OperationalMappingError('Operational intake record must be an object.');
    }
    if (typeof value.recordType !== 'string' || value.recordType.trim().length === 0) {
      throw new OperationalMappingError('Operational intake record requires recordType.');
    }
    if (!isPlainRecord(value.data)) {
      throw new OperationalMappingError(`Operational intake record ${value.recordType} requires object data.`);
    }

    const record = value as unknown as OperationalSourceRecord;
    const mapper = this.mappers.get(record.recordType as OperationalRecordType);
    if (!mapper) throw new UnsupportedOperationalRecordTypeError(record.recordType);

    const reasons = mapper.validate(record.data);
    if (reasons.length > 0) {
      throw new OperationalMappingError(
        `Invalid ${mapper.recordType} record: ${reasons.join(', ')}`
      );
    }
    return mapper.map(record.data, context);
  }

  supportedRecordTypes(): readonly OperationalRecordType[] {
    return [...this.mappers.keys()].sort();
  }
}

export function requireString(data: Record<string, unknown>, key: string, errors: string[]): string | undefined {
  const value = data[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    errors.push(`${key}_required`);
    return undefined;
  }
  return value;
}

export function optionalString(data: Record<string, unknown>, key: string, errors: string[]): string | undefined {
  const value = data[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0) {
    errors.push(`${key}_invalid`);
    return undefined;
  }
  return value;
}

export function requireFiniteNumber(data: Record<string, unknown>, key: string, errors: string[]): number | undefined {
  const value = data[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    errors.push(`${key}_required`);
    return undefined;
  }
  return value;
}

export function optionalFiniteNumber(data: Record<string, unknown>, key: string, errors: string[]): number | undefined {
  const value = data[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    errors.push(`${key}_invalid`);
    return undefined;
  }
  return value;
}
