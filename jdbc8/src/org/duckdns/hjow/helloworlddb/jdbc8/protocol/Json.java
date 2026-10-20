package org.duckdns.hjow.helloworlddb.jdbc8.protocol;

import java.io.IOException;
import java.math.BigDecimal;
import java.nio.ByteBuffer;
import java.nio.charset.Charset;
import java.nio.charset.CodingErrorAction;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 외부 의존성 없는 엄격한 JSON/UTF-8 코덱이다.
 * <p>HelloWorldDB 서버와 주고받는 UTF-8 JSON 메시지를 인코딩·디코딩한다.
 * 공통 코드는 Java 6으로 컴파일하므로 Java 6 문법·API 범위만 사용한다.</p>
 */
public final class Json {
    /** 인스턴스 생성을 막는 전용 생성자이다. */
    private Json() { }
    /**
     * 키·값 쌍을 순서대로 받아 연결 맵을 만든다.
     * <p>서버 요청 메시지를 만들 때 사용하며, 짝수 개 인자를 키·값 순서로 받는다.</p>
     *
     * @param pairs 키(문자열)와 값의 나열. 길이는 짝수이어야 한다
     * @return 입력 순서를 유지하는 맵
     */
    public static Map<String, Object> object(Object... pairs) {
        Map<String, Object> map = new LinkedHashMap<String, Object>();
        for (int i = 0; i < pairs.length; i += 2) map.put((String) pairs[i], pairs[i + 1]);
        return map;
    }
    /**
     * 자바 값을 JSON 문서의 UTF-8 바이트 배열로 인코딩한다.
     * <p>문자열, 불리언, 숫자, 맵, 리스트와 null만 허용한다.</p>
     *
     * @param value 인코딩할 값
     * @return UTF-8로 인코딩된 JSON 문서
     * @throws IOException 지원하지 않는 값 종류나 중첩 한도 초과 시
     */
    public static byte[] encode(Object value) throws IOException {
        StringBuilder out = new StringBuilder();
        write(value, out, 0);
        return out.toString().getBytes("UTF-8");
    }
    /**
     * UTF-8 바이트 배열을 JSON 값으로 디코딩한다.
     * <p>잘못된 UTF-8 바이트열, 뒤에 남은 데이터가 있으면 오류로 처리한다.
     * 정수는 {@link Long}, 소수는 {@link BigDecimal}로 읽어 정밀도를 보존한다.</p>
     *
     * @param bytes UTF-8 JSON 문서
     * @return 디코딩된 값(맵, 리스트, 문자열, 숫자, 불리언, null 중 하나)
     * @throws IOException 잘못된 UTF-8, 문법 오류, 남은 데이터가 있을 때
     */
    public static Object decode(byte[] bytes) throws IOException {
        String text = Charset.forName("UTF-8").newDecoder().onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString();
        Parser p = new Parser(text);
        Object value = p.value(0);
        p.space();
        if (p.at != text.length()) throw new IOException("Trailing JSON data.");
        return value;
    }
    /**
     * 자바 값을 JSON 텍스트로 직렬화한다.
     *
     * @param v 직렬화할 값
     * @param out 결과를 쌓을 버퍼
     * @param depth 현재 중첩 깊이. 128을 넘으면 오류로 처리한다
     * @throws IOException 지원하지 않는 값, 잘못된 숫자, 중첩 한도 초과 시
     */
    private static void write(Object v, StringBuilder out, int depth) throws IOException {
        if (depth > 128) throw new IOException("JSON nesting limit exceeded.");
        if (v == null) out.append("null");
        else if (v instanceof String) quote((String) v, out);
        else if (v instanceof Boolean || v instanceof Number) {
            String s = v.toString();
            if (!s.matches("-?(0|[1-9][0-9]*)(\\.[0-9]+)?([eE][+-]?[0-9]+)?" ) && !(v instanceof Boolean))
                throw new IOException("Invalid JSON number.");
            out.append(s);
        } else if (v instanceof Map<?, ?>) {
            out.append('{'); boolean first = true;
            for (Map.Entry<?, ?> e : ((Map<?, ?>) v).entrySet()) {
                if (!(e.getKey() instanceof String)) throw new IOException("Invalid JSON key.");
                if (!first) out.append(','); first = false;
                quote((String) e.getKey(), out); out.append(':'); write(e.getValue(), out, depth + 1);
            }
            out.append('}');
        } else if (v instanceof List<?>) {
            out.append('['); boolean first = true;
            for (Object item : (List<?>) v) {
                if (!first) out.append(','); first = false; write(item, out, depth + 1);
            }
            out.append(']');
        } else throw new IOException("Unsupported JSON value.");
    }
    /**
     * 문자열을 큰따옴표로 감싸 JSON 문자열 리터럴로 쓴다.
     * <p>서러게이트 쌍은 그대로 보존하고, 제어 문자는 U+XXXX 형식으로 이스케이프한다.</p>
     *
     * @param s 원본 문자열
     * @param out 결과를 쌓을 버퍼
     * @throws IOException 잘못된 서러게이트 쌍이 있을 때
     */
    private static void quote(String s, StringBuilder out) throws IOException {
        out.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (Character.isHighSurrogate(c)) {
                if (++i >= s.length() || !Character.isLowSurrogate(s.charAt(i))) throw new IOException("Invalid Unicode surrogate.");
                out.append(c).append(s.charAt(i));
            } else if (Character.isLowSurrogate(c)) throw new IOException("Invalid Unicode surrogate.");
            else if (c == '"' || c == '\\') out.append('\\').append(c);
            else if (c < 32) out.append(String.format("\\u%04x", Integer.valueOf(c)));
            else out.append(c);
        }
        out.append('"');
    }
    /**
     * JSON 문서 파서이다.
     * <p>객체의 중복 키와 과도한 중첩을 거부하는 엄격한 파서로,
     * 서버 응답의 구조 검증을 위해 사용한다.</p>
     */
    private static final class Parser {
        /** 파싱 중인 전체 문서이다. */
        final String text;
        /** 다음에 읽을 문자의 위치이다. */
        int at;
        /**
         * 파서를 생성한다.
         *
         * @param text 파싱할 JSON 문서 전체
         */
        Parser(String text) { this.text = text; }
        /**
         * 공백 문자(공백, 탭, CR, LF)를 건너뛴다.
         */
        void space() { while (at < text.length() && " \t\r\n".indexOf(text.charAt(at)) >= 0) at++; }
        /**
         * 문자 하나를 읽어 앞으로 이동한다.
         *
         * @return 읽은 문자
         * @throws IOException 문서 끝에 도달한 경우
         */
        char take() throws IOException { if (at >= text.length()) throw new IOException("Incomplete JSON."); return text.charAt(at++); }
        /**
         * JSON 값 하나를 파싱한다.
         *
         * @param depth 현재 중첩 깊이. 128을 넘으면 오류로 처리한다
         * @return 파싱된 값(맵, 리스트, 문자열, 숫자, 불리언, null 중 하나)
         * @throws IOException 문법 오류, 잘못된 값, 깊이 초과 시
         */
        Object value(int depth) throws IOException {
            if (depth > 128) throw new IOException("JSON nesting limit exceeded.");
            space(); char c = take();
            if (c == '"') return string();
            if (c == '{') {
                Map<String, Object> map = new LinkedHashMap<String, Object>(); space();
                if (at < text.length() && text.charAt(at) == '}') { at++; return map; }
                do {
                    space(); if (take() != '"') throw new IOException("Expected JSON key.");
                    String key = string(); space(); if (take() != ':') throw new IOException("Expected colon.");
                    if (map.containsKey(key)) throw new IOException("Duplicate JSON key.");
                    map.put(key, value(depth + 1)); space(); c = take();
                    if (c == '}') return map;
                } while (c == ',');
                throw new IOException("Invalid JSON object.");
            }
            if (c == '[') {
                List<Object> list = new ArrayList<Object>(); space();
                if (at < text.length() && text.charAt(at) == ']') { at++; return list; }
                do { list.add(value(depth + 1)); space(); c = take(); if (c == ']') return list; } while (c == ',');
                throw new IOException("Invalid JSON array.");
            }
            int start = at - 1;
            while (at < text.length() && ",]} \r\n\t".indexOf(text.charAt(at)) < 0) at++;
            String token = text.substring(start, at);
            if ("null".equals(token)) return null;
            if ("true".equals(token)) return Boolean.TRUE;
            if ("false".equals(token)) return Boolean.FALSE;
            if (!token.matches("-?(0|[1-9][0-9]*)(\\.[0-9]+)?([eE][+-]?[0-9]+)?")) throw new IOException("Invalid JSON value.");
            try { return token.indexOf('.') < 0 && token.indexOf('e') < 0 && token.indexOf('E') < 0
                ? (Object) Long.valueOf(token) : new BigDecimal(token); }
            catch (NumberFormatException e) { throw new IOException("Invalid JSON number.", e); }
        }
        /**
         * 여는 큰따옴표 다음 위치에서 문자열 본문을 읽는다.
         * <p>읽은 문자열을 다시 인용 부호로 감쌀 수 있는지 확인하여
         * 잘못된 서로게이트가 섞이지 않도록 한다.</p>
         *
         * @return 이스케이프가 해석된 문자열
         * @throws IOException 제어 문자, 잘못된 이스케이프, 서러게이트 오류 시
         */
        String string() throws IOException {
            StringBuilder out = new StringBuilder(); char c;
            while ((c = take()) != '"') {
                if (c < 32) throw new IOException("Invalid JSON string.");
                if (c == '\\') {
                    c = take();
                    if (c == 'u') {
                        try { String digits = text.substring(at, at + 4); if (!digits.matches("[0-9a-fA-F]{4}")) throw new NumberFormatException(); c = (char) Integer.parseInt(digits, 16); at += 4; }
                        catch (RuntimeException e) { throw new IOException("Invalid Unicode escape.", e); }
                    } else {
                        int p = "\"\\/bfnrt".indexOf(c);
                        if (p < 0) throw new IOException("Invalid JSON escape.");
                        c = "\"\\/\b\f\n\r\t".charAt(p);
                    }
                }
                out.append(c);
            }
            String s = out.toString(); quote(s, new StringBuilder()); return s;
        }
    }
}
