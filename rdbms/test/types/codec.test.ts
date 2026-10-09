/**
 * 담당 : 행 인코딩의 왕복, 인덱스 키의 순서 보존(ASC, DESC, NULL, 복합 키), 손상된 바이트열의 처리.
 * 관련 사양 : AGENTS.md 상세 1-1, 2, 3.
 * 구현 단계 : 3단계.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeRow, decodeUtf8, encodeKey, encodeRow, encodeUtf8, prefixUpperBound } from "../../src/types/codec.js";
import type { KeyColumn } from "../../src/types/codec.js";
import type { DataType } from "../../src/types/dataType.js";
import { IntervalValue, TimestampValue, TimeValue, DateValue } from "../../src/types/datetime.js";
import { Decimal } from "../../src/types/numeric.js";
import { compareForSort, conformValue } from "../../src/types/value.js";
import type { SqlValue } from "../../src/types/value.js";
import { assertSqlState, createRandom, type, value } from "./helpers.js";

/** 타입별 표본 값. 경계값과 순서가 헷갈리기 쉬운 값을 넣는다. */
const SAMPLES: [string, (string | null)[]][] = [
  ["CHAR(6)", ["", "a", "ab", "ab c", "b", "한글", "😀", "～", "a\u0001", "A", null]],
  ["VARCHAR(20)", ["", " ", "a", "a ", "a\u0000", "a\u0000b", "a\u0001", "ab", "b", "가", "가나", "😀", "￿", null]],
  ["BINARY(3)", ["", "00", "0001", "01", "FF", "FFFFFF", "00FF", null]],
  ["VARBINARY(8)", ["", "00", "0000", "0001", "01", "00FF", "FF", "FF00", "FFFF", null]],
  ["SMALLINT", ["-32768", "-1", "0", "1", "255", "256", "32767", null]],
  ["INTEGER", ["-2147483648", "-65536", "-1", "0", "1", "65535", "2147483647", null]],
  ["BIGINT", ["-9223372036854775808", "-4294967296", "-1", "0", "1", "4294967296", "9223372036854775807", null]],
  ["DECIMAL(2,1)", ["-9.9", "-0.1", "0", "0.1", "9.9", null]],
  ["DECIMAL(4,2)", ["-99.99", "-1.28", "-1.27", "0", "1.27", "1.28", "99.99", null]],
  ["DECIMAL(9,3)", ["-999999.999", "-0.001", "0", "0.001", "32.768", "999999.999", null]],
  ["DECIMAL(18,0)", ["-999999999999999999", "-1", "0", "1", "999999999999999999", null]],
  ["DECIMAL(38,10)", [`-${"9".repeat(28)}.${"9".repeat(10)}`, "-0.0000000001", "0", "0.0000000001", "12345678901234567890.5", `${"9".repeat(28)}.${"9".repeat(10)}`, null]],
  ["REAL", ["-3.4e38", "-1.5", "-1e-30", "0", "1e-30", "1.5", "3.4e38", null]],
  ["DOUBLE PRECISION", ["-1.7976931348623157e308", "-2.5", "-5e-324", "0", "5e-324", "2.5", "1.7976931348623157e308", null]],
  ["BOOLEAN", ["FALSE", "TRUE", null]],
  ["DATE", ["0001-01-01", "1969-12-31", "1970-01-01", "1970-01-02", "2026-10-09", "9999-12-31", null]],
  ["TIME(6)", ["00:00:00", "00:00:00.000001", "12:00:00", "23:59:59.999999", null]],
  ["TIME(6) WITH TIME ZONE", ["00:00:00+14:00", "00:00:00+00:00", "09:00:00+09:00", "12:00:00-05:00", "23:59:59.999999-12:00", null]],
  ["TIMESTAMP(6)", ["0001-01-01 00:00:00", "1969-12-31 23:59:59.999999", "1970-01-01 00:00:00", "2026-10-09 12:34:56.789012", "9999-12-31 23:59:59.999999", null]],
  ["TIMESTAMP(6) WITH TIME ZONE", ["0001-01-01 00:00:00+14:00", "1970-01-01 09:00:00+09:00", "1970-01-01 00:00:00+00:00", "2026-10-09 12:00:00-05:00", "9999-12-31 23:59:59.999999-12:00", null]],
  ["INTERVAL YEAR(9) TO MONTH", ["-999999999-11", "-0-01", "0-00", "0-01", "1-00", "999999999-11", null]],
  ["INTERVAL DAY(9) TO SECOND(6)", ["-999999999 23:59:59.999999", "-1 00:00:00", "-0 00:00:00.000001", "0 00:00:00", "0 00:00:00.000001", "1 00:00:00", "999999999 23:59:59.999999", null]],
  ["INTERVAL HOUR(4) TO MINUTE", ["-9999:59", "0:00", "0:01", "9999:59", null]],
];

function sampleValues(typeText: string, texts: (string | null)[]): SqlValue[] {
  return texts.map((text) => value(text, typeText));
}

test("행을 바이트열로 바꾸었다가 되돌리면 같은 값이다", () => {
  for (const [typeText, texts] of SAMPLES) {
    const dataType = type(typeText);
    for (const sample of sampleValues(typeText, texts)) {
      const decoded = decodeRow(encodeRow([sample], [dataType]), [dataType]);
      assert.deepEqual(decoded, [sample], `${typeText}`);
    }
  }
  // 모든 타입을 한 행에 넣는다.
  const types = SAMPLES.map(([typeText]) => type(typeText));
  for (let index = 0; index < 8; index++) {
    const row = SAMPLES.map(([typeText, texts]) => value(texts[index % texts.length] as string | null, typeText));
    assert.deepEqual(decodeRow(encodeRow(row, types), types), row);
  }
});

test("NULL 은 비트맵으로만 표시하고 값 영역을 쓰지 않는다", () => {
  const types = Array.from({ length: 17 }, () => type("INTEGER"));
  const allNull = new Array<SqlValue>(17).fill(null);
  assert.equal(encodeRow(allNull, types).length, 1 + 3);
  assert.deepEqual(decodeRow(encodeRow(allNull, types), types), allNull);
  const mixed = allNull.map((_, index) => (index % 3 === 0 ? BigInt(index) : null));
  assert.equal(encodeRow(mixed, types).length, 1 + 3 + 6 * 4);
  assert.deepEqual(decodeRow(encodeRow(mixed, types), types), mixed);
  assert.deepEqual(decodeRow(encodeRow([], []), []), []);
  assert.equal(encodeRow([], []).length, 1);
});

test("빈 문자열은 NULL 과 다른 값으로 저장된다", () => {
  const types = [type("VARCHAR(10)"), type("VARCHAR(10)")];
  const decoded = decodeRow(encodeRow(["", null], types), types);
  assert.equal(decoded[0], "");
  assert.equal(decoded[1], null);
  assert.notDeepEqual(encodeRow([""], [types[0] as DataType]), encodeRow([null], [types[0] as DataType]));
});

test("CHAR 는 채움 공백을 저장하지 않고 읽을 때 다시 채운다", () => {
  const charType = type("CHAR(2000)");
  const stored = encodeRow([conformValue("ab", charType)], [charType]);
  assert.ok(stored.length < 16);
  assert.equal(decodeRow(stored, [charType])[0], "ab".padEnd(2000, " "));
  const wide = type("CHAR(4)");
  assert.equal(decodeRow(encodeRow([conformValue("한😀", wide)], [wide]), [wide])[0], "한😀  ");
});

test("긴 값과 여러 바이트 길이 필드를 가진 행", () => {
  const types = [type("VARCHAR"), type("VARBINARY"), type("VARCHAR")];
  const row: SqlValue[] = ["가".repeat(65_535), Buffer.alloc(65_535, 0xab), "x".repeat(200)];
  const encoded = encodeRow(row, types);
  assert.equal(encoded.length, 1 + 1 + (3 + 65_535 * 3) + (3 + 65_535) + (2 + 200));
  assert.deepEqual(decodeRow(encoded, types), row);
});

test("컬럼을 뒤에 추가한 테이블에서 예전 행의 새 컬럼은 NULL 로 읽는다", () => {
  const oldTypes = [type("INTEGER"), type("VARCHAR(10)")];
  const newTypes = [...oldTypes, type("DATE"), type("DECIMAL(10,3)")];
  assert.deepEqual(decodeRow(encodeRow([1n, "a"], oldTypes), newTypes), [1n, "a", null, null]);
});

test("손상된 행은 XX001 이다", () => {
  const types = [type("INTEGER"), type("VARCHAR(10)")];
  const encoded = encodeRow([1n, "abc"], types);
  assertSqlState(() => decodeRow(encoded.subarray(0, encoded.length - 1), types), "XX001");
  assertSqlState(() => decodeRow(Buffer.concat([encoded, Buffer.from([0])]), types), "XX001");
  assertSqlState(() => decodeRow(Buffer.alloc(0), types), "XX001");
  // 저장된 컬럼이 정의보다 많다.
  assertSqlState(() => decodeRow(encoded, [type("INTEGER")]), "XX001");
  // 올바르지 않은 UTF-8
  const text = encodeRow(["abc"], [type("VARCHAR(10)")]);
  text[text.length - 1] = 0xff;
  assertSqlState(() => decodeRow(text, [type("VARCHAR(10)")]), "XX001");
  // 0, 1 이 아닌 논리값
  const flag = encodeRow([true], [type("BOOLEAN")]);
  flag[flag.length - 1] = 2;
  assertSqlState(() => decodeRow(flag, [type("BOOLEAN")]), "XX001");
  // 끝나지 않는 길이 필드
  assertSqlState(() => decodeRow(Buffer.alloc(9, 0xff), types), "XX001");
});

test("타입과 맞지 않는 값은 저장하지 않는다", () => {
  assertSqlState(() => encodeRow([1n], [type("VARCHAR(10)")]), "XX000");
  assertSqlState(() => encodeRow(["1"], [type("INTEGER")]), "XX000");
  assertSqlState(() => encodeRow([1n, 2n], [type("INTEGER")]), "XX000");
  assertSqlState(() => encodeRow([new TimeValue(0, null)], [type("TIME WITH TIME ZONE")]), "XX000");
  assertSqlState(() => encodeRow([new TimestampValue(0n, 0)], [type("TIMESTAMP")]), "XX000");
  assertSqlState(() => encodeRow(["a\ud800"], [type("VARCHAR(10)")]), "22021");
  assertSqlState(() => encodeKey([1n], [{ type: type("VARCHAR(10)") }]), "XX000");
  assertSqlState(() => encodeKey([1n, 2n], [{ type: type("INTEGER") }]), "XX000");
  assertSqlState(() => encodeKey([Number.NaN], [{ type: type("DOUBLE PRECISION") }]), "XX000");
  assertSqlState(() => encodeKey([40_000n], [{ type: type("SMALLINT") }]), "XX000");
});

test("UTF-8 변환은 올바르지 않은 입력을 22021 로 거부한다", () => {
  assert.equal(decodeUtf8(encodeUtf8("Hello 세계 😀")), "Hello 세계 😀");
  assert.equal(decodeUtf8(Buffer.from([0xef, 0xbb, 0xbf, 0x61])), "﻿a");
  for (const bytes of [[0xff], [0xc0, 0x80], [0xe3, 0x81], [0xed, 0xa0, 0x80], [0xf8, 0x88, 0x80, 0x80, 0x80]]) {
    assertSqlState(() => decodeUtf8(Buffer.from(bytes)), "22021");
  }
  assertSqlState(() => encodeUtf8("\udc00"), "22021");
});

function sign(value: number): number {
  return value < 0 ? -1 : value > 0 ? 1 : 0;
}

test("인덱스 키의 바이트 순서는 값의 정렬 순서와 같다 (ASC, DESC)", () => {
  for (const [typeText, texts] of SAMPLES) {
    const dataType = type(typeText);
    const values = sampleValues(typeText, texts);
    const ignoreTrailingSpaces = dataType.kind === "CHAR";
    for (const descending of [false, true]) {
      const columns: KeyColumn[] = [{ type: dataType, descending }];
      for (const left of values) {
        for (const right of values) {
          const expected = sign(compareForSort(left, right, { descending, ignoreTrailingSpaces }));
          const actual = sign(Buffer.compare(encodeKey([left], columns), encodeKey([right], columns)));
          assert.equal(actual, expected, `${typeText} ${descending ? "DESC" : "ASC"}`);
        }
      }
    }
  }
});

test("NULL 은 ASC 에서 마지막, DESC 에서 처음에 온다", () => {
  const integer = type("INTEGER");
  const ascending = [null, 5n, -1n, null, 0n].map((item) => encodeKey([item], [{ type: integer }]));
  ascending.sort(Buffer.compare);
  assert.deepEqual(ascending.map((key) => key.toString("hex")), ["007fffffff", "0080000000", "0080000005", "01", "01"]);
  const descending = [null, 5n, -1n, 0n].map((item) => encodeKey([item], [{ type: integer, descending: true }]));
  descending.sort(Buffer.compare);
  assert.deepEqual(descending.map((key) => key.toString("hex")), ["fe", "ff7ffffffa", "ff7fffffff", "ff80000000"]);
});

test("같은 값으로 비교되는 것은 같은 키가 된다", () => {
  const key = (item: SqlValue, typeText: string): string => encodeKey([item], [{ type: type(typeText) }]).toString("hex");
  // CHAR 의 채움 공백
  assert.equal(key("ab   ", "CHAR(5)"), key("ab", "CHAR(5)"));
  assert.notEqual(key("ab ", "VARCHAR(5)"), key("ab", "VARCHAR(5)"));
  // 음의 0
  assert.equal(key(-0, "DOUBLE PRECISION"), key(0, "DOUBLE PRECISION"));
  assert.equal(key(-0, "REAL"), key(0, "REAL"));
  // 소수 자릿수만 다른 값
  assert.equal(key(Decimal.parse("1.5"), "DECIMAL(10,3)"), key(Decimal.parse("1.500"), "DECIMAL(10,3)"));
  // 오프셋만 다른 같은 시각
  assert.equal(
    key(value("2026-10-09 21:00:00+09:00", "TIMESTAMP WITH TIME ZONE"), "TIMESTAMP WITH TIME ZONE"),
    key(value("2026-10-09 12:00:00+00:00", "TIMESTAMP WITH TIME ZONE"), "TIMESTAMP WITH TIME ZONE"),
  );
  assert.equal(
    key(value("21:00:00+09:00", "TIME WITH TIME ZONE"), "TIME WITH TIME ZONE"),
    key(value("12:00:00+00:00", "TIME WITH TIME ZONE"), "TIME WITH TIME ZONE"),
  );
  // 필드 구성이 달라도 같은 길이의 기간
  assert.equal(key(IntervalValue.dayTime(86_400_000_000n), "INTERVAL DAY"), key(value("24", "INTERVAL HOUR"), "INTERVAL HOUR"));
  assert.equal(key(new DateValue(0), "DATE"), "0080000000");
});

test("복합 키는 앞 컬럼부터 순서를 정하고, 값의 경계가 섞이지 않는다", () => {
  const random = createRandom(20261009);
  const texts = ["", "a", "a\u0000", "a\u0000b", "a\u0001", "ab", "b", "ÿ", "가", null];
  const numbers = [null, -3n, -1n, 0n, 1n, 2n, 300n];
  const dates = [null, "0001-01-01", "2026-10-09", "9999-12-31"].map((text) => value(text, "DATE"));
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;

  for (const directions of [[false, false, false], [true, false, true], [false, true, false], [true, true, true]]) {
    const columns: KeyColumn[] = [
      { type: type("VARCHAR(10)"), descending: directions[0] as boolean },
      { type: type("INTEGER"), descending: directions[1] as boolean },
      { type: type("DATE"), descending: directions[2] as boolean },
    ];
    const rows: SqlValue[][] = [];
    for (let i = 0; i < 300; i++) rows.push([pick(texts), pick(numbers), pick(dates)]);
    const compareRows = (left: SqlValue[], right: SqlValue[]): number => {
      for (let i = 0; i < columns.length; i++) {
        const result = compareForSort(left[i] as SqlValue, right[i] as SqlValue, { descending: directions[i] as boolean });
        if (result !== 0) return result;
      }
      return 0;
    };
    for (let i = 0; i < rows.length; i++) {
      const left = rows[i] as SqlValue[];
      const right = rows[(i * 7 + 13) % rows.length] as SqlValue[];
      assert.equal(
        sign(Buffer.compare(encodeKey(left, columns), encodeKey(right, columns))),
        sign(compareRows(left, right)),
        JSON.stringify([left, right, directions], (_, item) => (typeof item === "bigint" ? item.toString() : item)),
      );
    }
  }
});

test("무작위 값에서도 키의 순서가 정렬 순서와 같다", () => {
  const random = createRandom(7);
  /** 부호 있는 bits 비트 정수. 자릿수가 고르게 나오도록 유효 비트 수부터 고른다. */
  const integer = (bits: number): bigint => {
    const width = Math.floor(random() * bits);
    let magnitude = 0n;
    for (let produced = 0; produced < width; produced += 16) {
      magnitude = (magnitude << 16n) | BigInt(Math.floor(random() * 65_536));
    }
    magnitude &= (1n << BigInt(width)) - 1n;
    return random() < 0.5 ? -magnitude - 1n : magnitude;
  };
  const text = (): string => {
    const alphabet = ["a", "b", " ", "\u0000", "\u0001", "가", "😀", "￿", "z"];
    let result = "";
    const length = Math.floor(random() * 5);
    for (let i = 0; i < length; i++) result += alphabet[Math.floor(random() * alphabet.length)] as string;
    return result;
  };
  const generators: [string, () => SqlValue][] = [
    ["SMALLINT", () => integer(16)],
    ["BIGINT", () => integer(64)],
    ["DECIMAL(38,5)", () => new Decimal(integer(120), 5)],
    ["DOUBLE PRECISION", () => (random() - 0.5) * 10 ** Math.floor(random() * 600 - 300)],
    ["REAL", () => Math.fround((random() - 0.5) * 10 ** Math.floor(random() * 60 - 30))],
    ["VARCHAR(10)", text],
    ["CHAR(10)", () => conformValue(text(), type("CHAR(10)"))],
    ["VARBINARY(10)", () => Buffer.from(text(), "utf8").subarray(0, 10)],
    ["TIMESTAMP(6)", () => new TimestampValue(integer(56), null)],
    ["INTERVAL DAY(9) TO SECOND(6)", () => IntervalValue.dayTime(integer(66))],
  ];
  for (const [typeText, generate] of generators) {
    const dataType = type(typeText);
    const ignoreTrailingSpaces = dataType.kind === "CHAR";
    const values: SqlValue[] = [];
    for (let i = 0; i < 200; i++) values.push(random() < 0.05 ? null : generate());
    for (const descending of [false, true]) {
      const columns: KeyColumn[] = [{ type: dataType, descending }];
      const byKey = values
        .map((item) => ({ item, key: encodeKey([item], columns) }))
        .sort((left, right) => Buffer.compare(left.key, right.key));
      for (let i = 1; i < byKey.length; i++) {
        const previous = byKey[i - 1] as { item: SqlValue; key: Buffer };
        const current = byKey[i] as { item: SqlValue; key: Buffer };
        const expected = sign(compareForSort(previous.item, current.item, { descending, ignoreTrailingSpaces }));
        assert.equal(sign(Buffer.compare(previous.key, current.key)), expected, `${typeText} ${descending ? "DESC" : "ASC"}`);
        assert.ok(expected <= 0);
      }
    }
  }
});

test("접두 키와 그 상한으로 앞쪽 컬럼이 같은 키만 고른다", () => {
  const columns: KeyColumn[] = [{ type: type("VARCHAR(10)") }, { type: type("INTEGER"), descending: true }];
  const keys = [["a", 1n], ["a", 9n], ["a", null], ["a\u0000", 1n], ["ab", 1n], ["b", 0n], [null, 1n], ["", 1n]]
    .map((row) => ({ row, key: encodeKey(row as SqlValue[], columns) }));
  const inRange = (prefix: Buffer): string[] => {
    const upper = prefixUpperBound(prefix);
    return keys
      .filter(({ key }) => Buffer.compare(key, prefix) >= 0 && (upper === null || Buffer.compare(key, upper) < 0))
      .sort((left, right) => Buffer.compare(left.key, right.key))
      .map(({ row }) => JSON.stringify(row, (_, item) => (typeof item === "bigint" ? Number(item) : item)));
  };
  assert.deepEqual(inRange(encodeKey(["a"], columns)), ['["a",null]', '["a",9]', '["a",1]']);
  assert.deepEqual(inRange(encodeKey([null], columns)), ["[null,1]"]);
  assert.deepEqual(inRange(encodeKey([""], columns)), ['["",1]']);
  assert.deepEqual(inRange(encodeKey(["a", 9n], columns)), ['["a",9]']);
  assert.equal(inRange(encodeKey([], columns)).length, keys.length);

  assert.equal(prefixUpperBound(Buffer.alloc(0)), null);
  assert.equal(prefixUpperBound(Buffer.from([0xff, 0xff])), null);
  assert.deepEqual(prefixUpperBound(Buffer.from([0x01, 0xff])), Buffer.from([0x02]));
  assert.deepEqual(prefixUpperBound(Buffer.from([0x00, 0x61])), Buffer.from([0x00, 0x62]));
});

test("저장 엔진의 B+Tree 와 같은 비교(Buffer.compare)로 범위 조건을 표현할 수 있다", () => {
  // 인덱스 (AMOUNT DECIMAL(10,3)) 에서 AMOUNT >= 10 AND AMOUNT < 20 인 키를 고른다.
  const columns: KeyColumn[] = [{ type: type("DECIMAL(10,3)") }];
  const amounts = ["-5", "9.999", "10", "10.001", "19.999", "20", "1000", null].map((text) => value(text, "DECIMAL(10,3)"));
  const lower = encodeKey([value("10", "DECIMAL(10,3)")], columns);
  const upper = encodeKey([value("20", "DECIMAL(10,3)")], columns);
  const matched = amounts
    .filter((amount) => {
      const key = encodeKey([amount], columns);
      return Buffer.compare(key, lower) >= 0 && Buffer.compare(key, upper) < 0;
    })
    .map((amount) => (amount as Decimal).toString());
  assert.deepEqual(matched, ["10.000", "10.001", "19.999"]);
});

test("저장 형식의 고정 검증값 : 의도하지 않은 형식 변경을 잡는다", () => {
  // docs/storage-v1.md 의 "행과 인덱스 키의 값 인코딩" 과 같은 값이다.
  // 형식을 일부러 바꿀 때는 문서와 이 값을 함께 고친다.
  const vectors: [string, string | null, string, string][] = [
    ["CHAR(4)", "ab", "026162", "0061620000"],
    ["VARCHAR(10)", "한a", "04ed959c61", "00ed959c610000"],
    ["BINARY(2)", "0A", "020a00", "000a00ff0000"],
    ["VARBINARY(4)", "00FF", "0200ff", "0000ffff0000"],
    ["SMALLINT", "-2", "feff", "007ffe"],
    ["INTEGER", "1", "01000000", "0080000001"],
    ["BIGINT", "-1", "ffffffffffffffff", "007fffffffffffffff"],
    ["DECIMAL(10,3)", "-1.5", "0224fa", "007ffffffffffffa24"],
    ["DECIMAL(10,3)", "0", "00", "008000000000000000"],
    ["REAL", "1.5", "0000c03f", "00bfc00000"],
    ["DOUBLE PRECISION", "-2", "00000000000000c0", "003fffffffffffffff"],
    ["BOOLEAN", "TRUE", "01", "0001"],
    ["DATE", "1970-01-02", "01000000", "0080000001"],
    ["TIME(6)", "00:00:01", "40420f0000000000", "0080000000000f4240"],
    ["TIME(6) WITH TIME ZONE", "09:00:00+09:00", "00000000000000001c02", "008000000000000000"],
    ["TIMESTAMP(6)", "1970-01-01 00:00:00.000001", "0100000000000000", "008000000000000001"],
    ["TIMESTAMP(6) WITH TIME ZONE", "1970-01-01 09:00:00+09:00", "00000000000000001c02", "008000000000000000"],
    ["INTERVAL YEAR TO MONTH", "1-01", "010d", "00800000000000000d"],
    ["INTERVAL DAY TO SECOND", "-0 00:00:00.000001", "01ff", "007fffffffffffffffffffffff"],
    ["INTEGER", null, "", "01"],
  ];
  const types = vectors.map(([typeText]) => type(typeText));
  const values = vectors.map(([typeText, text]) => value(text, typeText));
  // 컬럼 수(20), NULL 비트맵(마지막 컬럼만 NULL), 값들
  const expectedRow = `14000008${vectors.map(([, , row]) => row).join("")}`;
  assert.equal(encodeRow(values, types).toString("hex"), expectedRow);
  assert.deepEqual(decodeRow(Buffer.from(expectedRow, "hex"), types), values);
  vectors.forEach(([typeText, , , key], index) => {
    const column = { type: types[index] as DataType };
    assert.equal(encodeKey([values[index] as SqlValue], [column]).toString("hex"), key, typeText);
    // DESC 는 같은 바이트열의 모든 비트를 뒤집은 것이다.
    const inverted = Buffer.from(key, "hex").map((byte) => ~byte & 0xff);
    assert.deepEqual(
      encodeKey([values[index] as SqlValue], [{ ...column, descending: true }]),
      Buffer.from(inverted),
      typeText,
    );
  });
});
