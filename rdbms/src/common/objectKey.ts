/**
 * 테이블스페이스명과 객체명의 쌍을 충돌 없는 내부 키로 만든다.
 * 따옴표 식별자의 점과 제어 문자도 JSON으로 구별한다. 저장 형식이나 표시용 이름에는 쓰지 않는다.
 */
export function objectKey(tablespace: string, name: string): string {
  return JSON.stringify([tablespace, name]);
}
