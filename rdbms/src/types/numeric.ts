/**
 * NUMERIC, DECIMAL 의 10진 정확 연산.
 *
 * 담당
 *  - 정밀도 38자리까지의 10진수 표현과 사칙연산, 비교
 *  - 소수부는 지정한 자릿수로 반올림한다. 정수부가 정밀도를 넘으면 오류이다.
 *  - 0 으로 나누면 오류이다.
 *  - 문자열과의 상호 변환
 *
 * 부동소수(number)를 거치면 안 된다. bigint 를 바탕으로 구현한다.
 * 값은 `unscaled / 10^scale` 이며 뒤쪽 0 을 정리하지 않는다. (scale 은 타입의 소수 자릿수와 맞춘다)
 *
 * 관련 사양 : AGENTS.md 상세 1-1, 1-2
 * 구현 단계 : 3단계
 */

import { internalError } from "../common/errors.js";
import { divisionByZero, invalidCastValue, numericOutOfRange, quoteForMessage } from "./errors.js";

/**
 * 반올림 방식.
 *  - HALF_UP : 0 에서 먼 쪽으로 반올림 (SQL 의 NUMERIC 반올림)
 *  - DOWN    : 0 방향으로 버림
 *  - FLOOR   : 음의 무한대 방향으로 내림
 *  - CEILING : 양의 무한대 방향으로 올림
 */
export type RoundingMode = "HALF_UP" | "DOWN" | "FLOOR" | "CEILING";

/** 연산 중간값이 가질 수 있는 소수 자릿수의 상한. 타입의 상한(38)보다 넉넉하게 둔다. */
const MAX_INTERNAL_SCALE = 1_000;
/** 문자열로 받는 수의 정수부 자릿수 상한. 이보다 크면 어떤 타입에도 담기지 않는다. */
const MAX_PARSE_INTEGER_DIGITS = 1_000;

const POWERS_OF_TEN: bigint[] = [1n];
/** 이 지수까지만 미리 계산한 값을 보관한다. */
const POWER_CACHE_LIMIT = 2_048;

/** 10 의 n 제곱. n 은 0 이상의 정수이다. */
export function pow10(n: number): bigint {
  if (!Number.isInteger(n) || n < 0) {
    throw internalError(`Invalid power of ten: ${n}.`);
  }
  if (n > POWER_CACHE_LIMIT) {
    return 10n ** BigInt(n);
  }
  for (let i = POWERS_OF_TEN.length; i <= n; i++) {
    POWERS_OF_TEN.push((POWERS_OF_TEN[i - 1] as bigint) * 10n);
  }
  return POWERS_OF_TEN[n] as bigint;
}

/** 정수 나눗셈의 몫을 지정한 방식으로 반올림한다. 0 으로 나누면 오류이다. */
export function divideRounded(numerator: bigint, denominator: bigint, mode: RoundingMode = "HALF_UP"): bigint {
  if (denominator === 0n) {
    throw divisionByZero();
  }
  const negative = (numerator < 0n) !== (denominator < 0n);
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  let quotient = n / d;
  const remainder = n % d;
  if (remainder !== 0n) {
    if (mode === "HALF_UP") {
      if (remainder * 2n >= d) quotient += 1n;
    } else if (mode === "FLOOR") {
      if (negative) quotient += 1n;
    } else if (mode === "CEILING") {
      if (!negative) quotient += 1n;
    }
  }
  return negative ? -quotient : quotient;
}

/** 절대값의 10진 자릿수. 0 은 1자리로 센다. */
export function countDigits(value: bigint): number {
  return (value < 0n ? -value : value).toString().length;
}

/** 10진 고정소수 값. 불변이다. */
export class Decimal {
  static readonly ZERO = new Decimal(0n, 0);
  static readonly ONE = new Decimal(1n, 0);

  readonly unscaled: bigint;
  readonly scale: number;

  constructor(unscaled: bigint, scale = 0) {
    if (!Number.isInteger(scale) || scale < 0 || scale > MAX_INTERNAL_SCALE) {
      throw internalError(`Invalid decimal scale: ${scale}.`);
    }
    this.unscaled = unscaled;
    this.scale = scale;
  }

  static fromBigInt(value: bigint): Decimal {
    return new Decimal(value, 0);
  }

  /**
   * 10진수 문자열을 정확히 해석한다. 지수 표기(1.5e3)도 받는다.
   * 앞뒤 공백은 무시한다. 형식이 틀리면 22018 이다.
   */
  static parse(text: string): Decimal {
    const match = /^\s*([+-])?(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?\s*$/.exec(text);
    if (match === null) {
      throw invalidCastValue(`Invalid numeric value: ${quoteForMessage(text)}.`);
    }
    const integerPart = match[2] ?? "";
    const fractionPart = match[3] ?? match[4] ?? "";
    let unscaled = BigInt(`${integerPart}${fractionPart}` || "0");
    let scale = fractionPart.length;

    if (match[5] !== undefined && unscaled !== 0n) {
      const exponent = Number(match[5]);
      const integerDigits = countDigits(unscaled) - scale + exponent;
      if (integerDigits > MAX_PARSE_INTEGER_DIGITS) {
        throw numericOutOfRange(`Numeric value out of range: ${quoteForMessage(text)}.`);
      }
      if (scale - exponent > MAX_INTERNAL_SCALE) {
        // 어떤 타입으로 받아도 0 으로 반올림되는 작은 수이다.
        return new Decimal(0n, 0);
      }
      scale -= exponent;
    }
    if (scale < 0) {
      unscaled *= pow10(-scale);
      scale = 0;
    }
    if (scale > MAX_INTERNAL_SCALE) {
      unscaled = divideRounded(unscaled, pow10(scale - MAX_INTERNAL_SCALE));
      scale = MAX_INTERNAL_SCALE;
    }
    if (countDigits(unscaled) - scale > MAX_PARSE_INTEGER_DIGITS) {
      throw numericOutOfRange(`Numeric value out of range: ${quoteForMessage(text)}.`);
    }
    return new Decimal(match[1] === "-" ? -unscaled : unscaled, scale);
  }

  /**
   * 부동소수를 10진수로 바꾼다. 그 값을 다시 읽었을 때 같은 부동소수가 되는 가장 짧은 10진 표기를 쓴다.
   * NaN 과 무한대는 22003 이다.
   */
  static fromNumber(value: number): Decimal {
    if (!Number.isFinite(value)) {
      throw numericOutOfRange("Non-finite floating point value cannot be converted to a numeric value.");
    }
    return Decimal.parse(value.toString());
  }

  /** 소수 자릿수를 그대로 드러낸 10진 표기. (예 : 1.50) */
  toString(): string {
    const negative = this.unscaled < 0n;
    let digits = (negative ? -this.unscaled : this.unscaled).toString();
    if (this.scale > 0) {
      if (digits.length <= this.scale) {
        digits = "0".repeat(this.scale - digits.length + 1) + digits;
      }
      const split = digits.length - this.scale;
      digits = `${digits.slice(0, split)}.${digits.slice(split)}`;
    }
    return negative ? `-${digits}` : digits;
  }

  /** 가장 가까운 배정도 부동소수. */
  toNumber(): number {
    return Number(this.toString());
  }

  /** 정수로 반올림한다. */
  toBigInt(mode: RoundingMode = "HALF_UP"): bigint {
    return this.scale === 0 ? this.unscaled : divideRounded(this.unscaled, pow10(this.scale), mode);
  }

  isZero(): boolean {
    return this.unscaled === 0n;
  }

  sign(): -1 | 0 | 1 {
    return this.unscaled === 0n ? 0 : this.unscaled < 0n ? -1 : 1;
  }

  negate(): Decimal {
    return new Decimal(-this.unscaled, this.scale);
  }

  abs(): Decimal {
    return this.unscaled < 0n ? this.negate() : this;
  }

  /** 정수부의 자릿수. 절대값이 1 보다 작으면 0 이다. */
  integerDigits(): number {
    if (this.unscaled === 0n) return 0;
    return Math.max(0, countDigits(this.unscaled) - this.scale);
  }

  add(other: Decimal): Decimal {
    const scale = Math.max(this.scale, other.scale);
    return new Decimal(this.unscaledAt(scale) + other.unscaledAt(scale), scale);
  }

  subtract(other: Decimal): Decimal {
    const scale = Math.max(this.scale, other.scale);
    return new Decimal(this.unscaledAt(scale) - other.unscaledAt(scale), scale);
  }

  /** 정확한 곱. 소수 자릿수는 두 값의 합이다. */
  multiply(other: Decimal): Decimal {
    const scale = this.scale + other.scale;
    if (scale > MAX_INTERNAL_SCALE) {
      throw numericOutOfRange("Numeric scale out of range.");
    }
    return new Decimal(this.unscaled * other.unscaled, scale);
  }

  /** 몫을 소수 scale 자리까지 구한다. 0 으로 나누면 22012 이다. */
  divide(other: Decimal, scale: number, mode: RoundingMode = "HALF_UP"): Decimal {
    if (other.unscaled === 0n) {
      throw divisionByZero();
    }
    const shift = scale + other.scale - this.scale;
    const numerator = shift >= 0 ? this.unscaled * pow10(shift) : this.unscaled;
    const denominator = shift >= 0 ? other.unscaled : other.unscaled * pow10(-shift);
    return new Decimal(divideRounded(numerator, denominator, mode), scale);
  }

  /** 0 방향으로 버린 나눗셈의 나머지. 부호는 나뉘는 수를 따른다. 0 으로 나누면 22012 이다. */
  remainder(other: Decimal): Decimal {
    if (other.unscaled === 0n) {
      throw divisionByZero();
    }
    const scale = Math.max(this.scale, other.scale);
    return new Decimal(this.unscaledAt(scale) % other.unscaledAt(scale), scale);
  }

  compare(other: Decimal): -1 | 0 | 1 {
    const scale = Math.max(this.scale, other.scale);
    const left = this.unscaledAt(scale);
    const right = other.unscaledAt(scale);
    return left === right ? 0 : left < right ? -1 : 1;
  }

  equals(other: Decimal): boolean {
    return this.compare(other) === 0;
  }

  /** 소수 자릿수를 scale 로 맞춘다. 줄일 때는 지정한 방식으로 반올림하고, 늘릴 때는 0 을 채운다. */
  round(scale: number, mode: RoundingMode = "HALF_UP"): Decimal {
    if (scale === this.scale) return this;
    if (scale > this.scale) {
      return new Decimal(this.unscaled * pow10(scale - this.scale), scale);
    }
    return new Decimal(divideRounded(this.unscaled, pow10(this.scale - scale), mode), scale);
  }

  /** 소수 자릿수가 scale 일 때의 unscaled 값. scale 은 현재 값 이상이어야 한다. */
  private unscaledAt(scale: number): bigint {
    return scale === this.scale ? this.unscaled : this.unscaled * pow10(scale - this.scale);
  }
}

/**
 * 값을 NUMERIC(precision, scale) 에 맞춘다.
 * 소수부는 scale 자리로 반올림하고, 정수부가 precision - scale 자리를 넘으면 22003 이다.
 */
export function fitDecimal(value: Decimal, precision: number, scale: number): Decimal {
  const rounded = value.round(scale);
  const limit = pow10(precision);
  if (rounded.unscaled >= limit || rounded.unscaled <= -limit) {
    throw numericOutOfRange(`Numeric value out of range for NUMERIC(${precision},${scale}).`);
  }
  return rounded;
}
