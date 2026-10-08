/**
 * 데이터 타입의 정의와 이름 해석.
 *
 * 담당
 *  - 지원 타입의 이름과 별칭 정규화
 *  - 길이, 정밀도, 소수 초 자릿수의 기본값과 범위 검증
 *  - 지원하지 않는 타입은 SQLSTATE 0A000, 잘못된 타입 인자는 22023 으로 알림
 *
 * 관련 사양 : AGENTS.md 개요 1, 상세 1-1, 13
 * 구현 단계 : 3단계
 */

import { DbError, ERROR_CODES, unsupportedFeature } from "../common/errors.js";

/** VARCHAR와 그 별칭 NVARCHAR의 길이는 유니코드 코드 포인트 단위이다. */
export const VARCHAR_MAX_LENGTH = 65_535;
export const DEFAULT_VARCHAR_LENGTH = VARCHAR_MAX_LENGTH;
export const CHAR_MAX_LENGTH = 2_000;
export const BINARY_MAX_LENGTH = 2_000;
export const VARBINARY_MAX_LENGTH = 65_535;
export const DECIMAL_MAX_PRECISION = 38;
export const DEFAULT_DECIMAL_PRECISION = 10;
export const DEFAULT_DECIMAL_SCALE = 3;
export const MAX_FLOAT_PRECISION = 53;
export const DEFAULT_INTERVAL_LEADING_PRECISION = 2;
export const MAX_INTERVAL_LEADING_PRECISION = 9;
export const DEFAULT_INTERVAL_FRACTIONAL_PRECISION = 6;

export interface CharacterDataType {
  kind: "CHAR" | "VARCHAR";
  name: "CHAR" | "VARCHAR";
  length: number;
}

export interface BinaryDataType {
  kind: "BINARY" | "VARBINARY";
  name: "BINARY" | "VARBINARY";
  length: number;
}

export interface IntegerDataType {
  kind: "INTEGER";
  name: "SMALLINT" | "INTEGER" | "BIGINT";
  bits: 16 | 32 | 64;
}

export interface ExactNumericType {
  name: "DECIMAL";
  precision: number;
  scale: number;
}

export interface DecimalDataType extends ExactNumericType {
  kind: "DECIMAL";
}

export interface FloatingPointDataType {
  kind: "FLOAT";
  name: "REAL" | "DOUBLE PRECISION";
  bits: 32 | 64;
}

export interface BooleanDataType {
  kind: "BOOLEAN";
  name: "BOOLEAN";
}

export interface DateDataType {
  kind: "DATE";
  name: "DATE";
}

export interface TimeDataType {
  kind: "TIME";
  name: "TIME" | "TIME WITH TIME ZONE";
  fractionalPrecision: number;
  withTimeZone: boolean;
}

export interface TimestampDataType {
  kind: "TIMESTAMP";
  name: "TIMESTAMP" | "TIMESTAMP WITH TIME ZONE";
  fractionalPrecision: number;
  withTimeZone: boolean;
}

export type IntervalField = "YEAR" | "MONTH" | "DAY" | "HOUR" | "MINUTE" | "SECOND";

export interface IntervalDataType {
  kind: "INTERVAL";
  name: "INTERVAL";
  startField: IntervalField;
  endField: IntervalField;
  leadingPrecision: number;
  fractionalPrecision: number | null;
}

export type DataType =
  | CharacterDataType
  | BinaryDataType
  | IntegerDataType
  | DecimalDataType
  | FloatingPointDataType
  | BooleanDataType
  | DateDataType
  | TimeDataType
  | TimestampDataType
  | IntervalDataType;

/** 고정소수 타입 이름과 인자를 받아 공통 DECIMAL 정의를 만든다. */
export function resolveExactNumericType(name: string, precision?: number, scale?: number): ExactNumericType {
  const normalized = normalizeTypeName(name);
  if (normalized !== "DECIMAL" && normalized !== "DEC" && normalized !== "NUMERIC") {
    throw unsupportedFeature(`Unsupported exact numeric type: ${name}.`);
  }
  if (precision === undefined && scale !== undefined) {
    throw invalidParameter("Scale cannot be specified without precision.");
  }
  const resolvedPrecision = precision ?? DEFAULT_DECIMAL_PRECISION;
  const resolvedScale = scale ?? (precision === undefined ? DEFAULT_DECIMAL_SCALE : 0);
  if (!Number.isSafeInteger(resolvedPrecision) || resolvedPrecision < 1 || resolvedPrecision > DECIMAL_MAX_PRECISION) {
    throw invalidParameter("Exact numeric precision must be an integer between 1 and 38.");
  }
  if (!Number.isSafeInteger(resolvedScale) || resolvedScale < 0 || resolvedScale > resolvedPrecision) {
    throw invalidParameter("Exact numeric scale must be an integer between 0 and precision.");
  }
  return { name: "DECIMAL", precision: resolvedPrecision, scale: resolvedScale };
}

/**
 * SQL 타입 이름과 타입 인자를 표준 정의로 해석한다.
 * INTERVAL 수식자는 이름에 포함하며, 인자는 선행 정밀도와 초 소수 자릿수 순서이다.
 */
export function resolveDataType(name: string, ...parameters: number[]): DataType {
  const normalized = normalizeTypeName(name);

  if (normalized === "DECIMAL" || normalized === "DEC" || normalized === "NUMERIC") {
    assertParameterCount(normalized, parameters, 0, 2);
    return { kind: "DECIMAL", ...resolveExactNumericType(normalized, parameters[0], parameters[1]) };
  }

  const characterName = resolveCharacterName(normalized);
  if (characterName !== null) {
    assertParameterCount(normalized, parameters, 0, 1);
    const isFixed = characterName === "CHAR";
    const length = parameters[0] ?? (isFixed ? 1 : DEFAULT_VARCHAR_LENGTH);
    validateRange(`${characterName} length`, length, 1, isFixed ? CHAR_MAX_LENGTH : VARCHAR_MAX_LENGTH);
    return { kind: characterName, name: characterName, length };
  }

  const binaryName = resolveBinaryName(normalized);
  if (binaryName !== null) {
    assertParameterCount(normalized, parameters, 0, 1);
    const isFixed = binaryName === "BINARY";
    const length = parameters[0] ?? (isFixed ? 1 : VARBINARY_MAX_LENGTH);
    validateRange(`${binaryName} length`, length, 1, isFixed ? BINARY_MAX_LENGTH : VARBINARY_MAX_LENGTH);
    return { kind: binaryName, name: binaryName, length };
  }

  const integerType = resolveIntegerType(normalized);
  if (integerType !== null) {
    assertParameterCount(normalized, parameters, 0, 0);
    return integerType;
  }

  if (normalized === "REAL" || normalized === "DOUBLE PRECISION" || normalized === "FLOAT") {
    assertParameterCount(normalized, parameters, 0, normalized === "FLOAT" ? 1 : 0);
    if (normalized !== "FLOAT" || parameters.length === 0) {
      const isReal = normalized === "REAL";
      return { kind: "FLOAT", name: isReal ? "REAL" : "DOUBLE PRECISION", bits: isReal ? 32 : 64 };
    }
    const precision = parameters[0];
    if (precision === undefined) {
      throw invalidParameter("FLOAT requires a precision value.");
    }
    validateRange("FLOAT precision", precision, 1, MAX_FLOAT_PRECISION);
    const isReal = precision <= 24;
    return { kind: "FLOAT", name: isReal ? "REAL" : "DOUBLE PRECISION", bits: isReal ? 32 : 64 };
  }

  if (normalized === "BOOLEAN") {
    assertParameterCount(normalized, parameters, 0, 0);
    return { kind: "BOOLEAN", name: "BOOLEAN" };
  }

  if (normalized === "DATE") {
    assertParameterCount(normalized, parameters, 0, 0);
    return { kind: "DATE", name: "DATE" };
  }

  const timeName = resolveTimeName(normalized);
  if (timeName !== null) {
    assertParameterCount(normalized, parameters, 0, 1);
    const fractionalPrecision = parameters[0] ?? (timeName.kind === "TIME" ? 0 : 6);
    validateRange("Fractional seconds precision", fractionalPrecision, 0, 6);
    if (timeName.kind === "TIME") {
      return {
        kind: "TIME",
        name: timeName.name,
        fractionalPrecision,
        withTimeZone: timeName.withTimeZone,
      };
    }
    return {
      kind: "TIMESTAMP",
      name: timeName.name,
      fractionalPrecision,
      withTimeZone: timeName.withTimeZone,
    };
  }

  const intervalFields = resolveIntervalFields(normalized);
  if (intervalFields !== null) {
    const secondIsLeadingField = intervalFields.startField === "SECOND";
    assertParameterCount(normalized, parameters, 0, intervalFields.endField === "SECOND" && !secondIsLeadingField ? 2 : 1);
    const leadingPrecision = secondIsLeadingField
      ? DEFAULT_INTERVAL_LEADING_PRECISION
      : parameters[0] ?? DEFAULT_INTERVAL_LEADING_PRECISION;
    validateRange("Interval leading precision", leadingPrecision, 1, MAX_INTERVAL_LEADING_PRECISION);
    const fractionalPrecision = intervalFields.endField === "SECOND"
      ? (secondIsLeadingField ? parameters[0] : parameters[1]) ?? DEFAULT_INTERVAL_FRACTIONAL_PRECISION
      : null;
    if (fractionalPrecision !== null) {
      validateRange("Interval fractional seconds precision", fractionalPrecision, 0, 6);
    }
    return {
      kind: "INTERVAL",
      name: "INTERVAL",
      startField: intervalFields.startField,
      endField: intervalFields.endField,
      leadingPrecision,
      fractionalPrecision,
    };
  }

  if (normalized.startsWith("INTERVAL ")) {
    throw invalidParameter(`Invalid INTERVAL qualifier: ${name}.`);
  }
  throw unsupportedFeature(`Unsupported data type: ${name}.`);
}

function normalizeTypeName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toUpperCase();
}

function resolveCharacterName(name: string): CharacterDataType["name"] | null {
  switch (name) {
    case "CHAR":
    case "CHARACTER":
    case "NCHAR":
    case "NATIONAL CHARACTER":
      return "CHAR";
    case "VARCHAR":
    case "CHARACTER VARYING":
    case "CHAR VARYING":
    case "NVARCHAR":
    case "NATIONAL CHARACTER VARYING":
      return "VARCHAR";
    default:
      return null;
  }
}

function resolveBinaryName(name: string): BinaryDataType["name"] | null {
  switch (name) {
    case "BINARY":
      return "BINARY";
    case "VARBINARY":
    case "BINARY VARYING":
      return "VARBINARY";
    default:
      return null;
  }
}

function resolveIntegerType(name: string): IntegerDataType | null {
  switch (name) {
    case "SMALLINT":
      return { kind: "INTEGER", name: "SMALLINT", bits: 16 };
    case "INTEGER":
    case "INT":
      return { kind: "INTEGER", name: "INTEGER", bits: 32 };
    case "BIGINT":
      return { kind: "INTEGER", name: "BIGINT", bits: 64 };
    default:
      return null;
  }
}

function resolveTimeName(name: string): Pick<TimeDataType, "kind" | "name" | "withTimeZone">
  | Pick<TimestampDataType, "kind" | "name" | "withTimeZone"> | null {
  switch (name) {
    case "TIME":
      return { kind: "TIME", name: "TIME", withTimeZone: false };
    case "TIME WITH TIME ZONE":
      return { kind: "TIME", name: "TIME WITH TIME ZONE", withTimeZone: true };
    case "TIMESTAMP":
      return { kind: "TIMESTAMP", name: "TIMESTAMP", withTimeZone: false };
    case "TIMESTAMP WITH TIME ZONE":
      return { kind: "TIMESTAMP", name: "TIMESTAMP WITH TIME ZONE", withTimeZone: true };
    default:
      return null;
  }
}

function resolveIntervalFields(name: string): { startField: IntervalField; endField: IntervalField } | null {
  const match = /^INTERVAL (YEAR|MONTH|DAY|HOUR|MINUTE|SECOND)(?: TO (YEAR|MONTH|DAY|HOUR|MINUTE|SECOND))?$/.exec(name);
  if (match === null) {
    return null;
  }
  const startField = match[1] as IntervalField;
  const endField = (match[2] ?? match[1]) as IntervalField;
  if (match[2] !== undefined && startField === endField) {
    return null;
  }
  const validEndFields: Record<IntervalField, readonly IntervalField[]> = {
    YEAR: ["YEAR", "MONTH"],
    MONTH: ["MONTH"],
    DAY: ["DAY", "HOUR", "MINUTE", "SECOND"],
    HOUR: ["HOUR", "MINUTE", "SECOND"],
    MINUTE: ["MINUTE", "SECOND"],
    SECOND: ["SECOND"],
  };
  if (!validEndFields[startField].includes(endField)) {
    return null;
  }
  return { startField, endField };
}

function assertParameterCount(name: string, parameters: number[], minimum: number, maximum: number): void {
  if (parameters.length < minimum || parameters.length > maximum) {
    throw invalidParameter(`${name} accepts ${minimum === maximum ? minimum : `${minimum} to ${maximum}`} type parameter(s).`);
  }
}

function validateRange(label: string, value: number, minimum: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw invalidParameter(`${label} must be an integer between ${minimum} and ${maximum}.`);
  }
}

function invalidParameter(message: string): DbError {
  return new DbError("22023", ERROR_CODES.TYPE_PARAMETER_INVALID, message);
}
