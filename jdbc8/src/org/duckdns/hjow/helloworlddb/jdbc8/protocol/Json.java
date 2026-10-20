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

/** 외부 의존성 없는 엄격한 JSON/UTF-8 코덱. 공통 코드는 Java 6으로 컴파일한다. */
public final class Json {
    private Json() { }
    public static Map<String, Object> object(Object... pairs) {
        Map<String, Object> map = new LinkedHashMap<String, Object>();
        for (int i = 0; i < pairs.length; i += 2) map.put((String) pairs[i], pairs[i + 1]);
        return map;
    }
    public static byte[] encode(Object value) throws IOException {
        StringBuilder out = new StringBuilder();
        write(value, out, 0);
        return out.toString().getBytes("UTF-8");
    }
    public static Object decode(byte[] bytes) throws IOException {
        String text = Charset.forName("UTF-8").newDecoder().onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString();
        Parser p = new Parser(text);
        Object value = p.value(0);
        p.space();
        if (p.at != text.length()) throw new IOException("Trailing JSON data.");
        return value;
    }
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
    private static final class Parser {
        final String text; int at;
        Parser(String text) { this.text = text; }
        void space() { while (at < text.length() && " \t\r\n".indexOf(text.charAt(at)) >= 0) at++; }
        char take() throws IOException { if (at >= text.length()) throw new IOException("Incomplete JSON."); return text.charAt(at++); }
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
