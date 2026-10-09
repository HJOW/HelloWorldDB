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

// ---------------------------------------------------------------------------
// 자주 쓰는 타입 정의와 생성 도우미
// ---------------------------------------------------------------------------

export const SMALLINT_TYPE: IntegerDataType = { kind: "INTEGER", name: "SMALLINT", bits: 16 };
export const INTEGER_TYPE: IntegerDataType = { kind: "INTEGER", name: "INTEGER", bits: 32 };
export const BIGINT_TYPE: IntegerDataType = { kind: "INTEGER", name: "BIGINT", bits: 64 };
export const REAL_TYPE: FloatingPointDataType = { kind: "FLOAT", name: "REAL", bits: 32 };
export const DOUBLE_TYPE: FloatingPointDataType = { kind: "FLOAT", name: "DOUBLE PRECISION", bits: 64 };
export const BOOLEAN_TYPE: BooleanDataType = { kind: "BOOLEAN", name: "BOOLEAN" };
export const DATE_TYPE: DateDataType = { kind: "DATE", name: "DATE" };

export function charType(length: number): CharacterDataType {
  return { kind: "CHAR", name: "CHAR", length };
}

export function varcharType(length: number = DEFAULT_VARCHAR_LENGTH): CharacterDataType {
  return { kind: "VARCHAR", name: "VARCHAR", length };
}

export function binaryType(length: number): BinaryDataType {
  return { kind: "BINARY", name: "BINARY", length };
}

export function varbinaryType(length: number = VARBINARY_MAX_LENGTH): BinaryDataType {
  return { kind: "VARBINARY", name: "VARBINARY", length };
}

export function integerType(bits: 16 | 32 | 64): IntegerDataType {
  return bits === 16 ? SMALLINT_TYPE : bits === 32 ? INTEGER_TYPE : BIGINT_TYPE;
}

export function decimalType(precision: number, scale: number): DecimalDataType {
  return { kind: "DECIMAL", name: "DECIMAL", precision, scale };
}

export function timeType(fractionalPrecision: number, withTimeZone: boolean): TimeDataType {
  return { kind: "TIME", name: withTimeZone ? "TIME WITH TIME ZONE" : "TIME", fractionalPrecision, withTimeZone };
}

export function timestampType(fractionalPrecision: number, withTimeZone: boolean): TimestampDataType {
  return {
    kind: "TIMESTAMP",
    name: withTimeZone ? "TIMESTAMP WITH TIME ZONE" : "TIMESTAMP",
    fractionalPrecision,
    withTimeZone,
  };
}

/** 종료 필드가 SECOND 가 아니면 소수 초 자릿수는 null 로 맞춘다. */
export function intervalType(
  startField: IntervalField,
  endField: IntervalField,
  leadingPrecision: number = DEFAULT_INTERVAL_LEADING_PRECISION,
  fractionalPrecision: number = DEFAULT_INTERVAL_FRACTIONAL_PRECISION,
): IntervalDataType {
  return {
    kind: "INTERVAL",
    name: "INTERVAL",
    startField,
    endField,
    leadingPrecision,
    fractionalPrecision: endField === "SECOND" ? fractionalPrecision : null,
  };
}

/**
 * 타입 정의를 SQL 표기로 적는다. 오류 메시지와 메타데이터 표시에 쓴다.
 * (예 : `VARCHAR(10)`, `DECIMAL(10,3)`, `TIMESTAMP(6) WITH TIME ZONE`, `INTERVAL DAY(2) TO SECOND(6)`)
 */
export function formatDataType(type: DataType): string {
  switch (type.kind) {
    case "CHAR":
    case "VARCHAR":
    case "BINARY":
    case "VARBINARY":
      return `${type.name}(${type.length})`;
    case "DECIMAL":
      return `DECIMAL(${type.precision},${type.scale})`;
    case "INTEGER":
    case "FLOAT":
    case "BOOLEAN":
    case "DATE":
      return type.name;
    case "TIME":
      return `TIME(${type.fractionalPrecision})${type.withTimeZone ? " WITH TIME ZONE" : ""}`;
    case "TIMESTAMP":
      return `TIMESTAMP(${type.fractionalPrecision})${type.withTimeZone ? " WITH TIME ZONE" : ""}`;
    case "INTERVAL": {
      const fraction = type.fractionalPrecision ?? 0;
      if (type.startField === type.endField) {
        return type.startField === "SECOND"
          ? `INTERVAL SECOND(${type.leadingPrecision},${fraction})`
          : `INTERVAL ${type.startField}(${type.leadingPrecision})`;
      }
      const end = type.endField === "SECOND" ? `SECOND(${fraction})` : type.endField;
      return `INTERVAL ${type.startField}(${type.leadingPrecision}) TO ${end}`;
    }
  }
}

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

const INTERVAL_END_FIELDS: Record<IntervalField, readonly IntervalField[]> = {
  YEAR: ["YEAR", "MONTH"],
  MONTH: ["MONTH"],
  DAY: ["DAY", "HOUR", "MINUTE", "SECOND"],
  HOUR: ["HOUR", "MINUTE", "SECOND"],
  MINUTE: ["MINUTE", "SECOND"],
  SECOND: ["SECOND"],
};

/**
 * INTERVAL 한정자를 타입 정의로 해석한다. SQL 구문 `INTERVAL 시작(선행 정밀도) [TO 종료(소수 초 자릿수)]` 에 대응한다.
 *  - endField 를 생략하면 단일 필드이다. `TO` 로 같은 필드를 다시 적은 것(`DAY TO DAY`)은 받지 않는다.
 *  - 선행 정밀도는 1 ~ 9 (생략 시 2), 소수 초 자릿수는 0 ~ 6 (생략 시 6)이며 종료 필드가 SECOND 일 때만 줄 수 있다.
 * 잘못된 조합이나 범위는 22023 이다.
 */
export function resolveIntervalType(
  startField: IntervalField,
  endField?: IntervalField,
  leadingPrecision?: number,
  fractionalPrecision?: number,
): IntervalDataType {
  const end = endField ?? startField;
  if ((endField !== undefined && endField === startField) || !INTERVAL_END_FIELDS[startField].includes(end)) {
    throw invalidParameter(`Invalid INTERVAL qualifier: ${startField} TO ${end}.`);
  }
  const leading = leadingPrecision ?? DEFAULT_INTERVAL_LEADING_PRECISION;
  validateRange("Interval leading precision", leading, 1, MAX_INTERVAL_LEADING_PRECISION);
  if (end !== "SECOND") {
    if (fractionalPrecision !== undefined) {
      throw invalidParameter("Fractional seconds precision requires an INTERVAL qualifier ending in SECOND.");
    }
    return { kind: "INTERVAL", name: "INTERVAL", startField, endField: end, leadingPrecision: leading, fractionalPrecision: null };
  }
  const fraction = fractionalPrecision ?? DEFAULT_INTERVAL_FRACTIONAL_PRECISION;
  validateRange("Interval fractional seconds precision", fraction, 0, 6);
  return { kind: "INTERVAL", name: "INTERVAL", startField, endField: end, leadingPrecision: leading, fractionalPrecision: fraction };
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
    case "NATIONAL CHAR":
      return "CHAR";
    case "VARCHAR":
    case "CHARACTER VARYING":
    case "CHAR VARYING":
    case "NVARCHAR":
    case "NATIONAL CHARACTER VARYING":
    case "NATIONAL CHAR VARYING":
    case "NCHAR VARYING":
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
  if (!INTERVAL_END_FIELDS[startField].includes(endField)) {
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
