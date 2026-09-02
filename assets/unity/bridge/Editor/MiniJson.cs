// MiniJson — the bridge's self-contained JSON reader/writer. Written fresh
// for this package so it carries ZERO dependencies beyond the BCL:
// UnityEngine.JsonUtility cannot represent dictionaries (the wire's args are
// open maps), and Newtonsoft is not a default project package. Reads into
// Dictionary<string, object> / List<object> / string / double / bool / null;
// writes the same shapes back. Bounded by the caller (the server caps frame
// bytes before parsing). Malformed input throws; the server catches and
// answers a typed error — nothing here ever crashes the editor.

using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace Mercury.UnityBridge
{
    internal static class MiniJson
    {
        public static object Parse(string json)
        {
            if (json == null) throw new ArgumentNullException(nameof(json));
            int pos = 0;
            object value = ParseValue(json, ref pos);
            SkipWhitespace(json, ref pos);
            if (pos != json.Length) throw new FormatException("trailing content after JSON value");
            return value;
        }

        // ── reading ──────────────────────────────────────────────────────────

        private static object ParseValue(string s, ref int pos)
        {
            SkipWhitespace(s, ref pos);
            if (pos >= s.Length) throw new FormatException("unexpected end of JSON");
            char c = s[pos];
            switch (c)
            {
                case '{': return ParseObject(s, ref pos);
                case '[': return ParseArray(s, ref pos);
                case '"': return ParseString(s, ref pos);
                case 't': Expect(s, ref pos, "true"); return true;
                case 'f': Expect(s, ref pos, "false"); return false;
                case 'n': Expect(s, ref pos, "null"); return null;
                default: return ParseNumber(s, ref pos);
            }
        }

        private static Dictionary<string, object> ParseObject(string s, ref int pos)
        {
            var obj = new Dictionary<string, object>();
            pos++; // '{'
            SkipWhitespace(s, ref pos);
            if (pos < s.Length && s[pos] == '}') { pos++; return obj; }
            while (true)
            {
                SkipWhitespace(s, ref pos);
                if (pos >= s.Length || s[pos] != '"') throw new FormatException("object key expected");
                string key = ParseString(s, ref pos);
                SkipWhitespace(s, ref pos);
                if (pos >= s.Length || s[pos] != ':') throw new FormatException("':' expected");
                pos++;
                obj[key] = ParseValue(s, ref pos);
                SkipWhitespace(s, ref pos);
                if (pos >= s.Length) throw new FormatException("unterminated object");
                if (s[pos] == ',') { pos++; continue; }
                if (s[pos] == '}') { pos++; return obj; }
                throw new FormatException("',' or '}' expected");
            }
        }

        private static List<object> ParseArray(string s, ref int pos)
        {
            var arr = new List<object>();
            pos++; // '['
            SkipWhitespace(s, ref pos);
            if (pos < s.Length && s[pos] == ']') { pos++; return arr; }
            while (true)
            {
                arr.Add(ParseValue(s, ref pos));
                SkipWhitespace(s, ref pos);
                if (pos >= s.Length) throw new FormatException("unterminated array");
                if (s[pos] == ',') { pos++; continue; }
                if (s[pos] == ']') { pos++; return arr; }
                throw new FormatException("',' or ']' expected");
            }
        }

        private static string ParseString(string s, ref int pos)
        {
            var sb = new StringBuilder();
            pos++; // opening quote
            while (true)
            {
                if (pos >= s.Length) throw new FormatException("unterminated string");
                char c = s[pos++];
                if (c == '"') return sb.ToString();
                if (c == '\\')
                {
                    if (pos >= s.Length) throw new FormatException("unterminated escape");
                    char e = s[pos++];
                    switch (e)
                    {
                        case '"': sb.Append('"'); break;
                        case '\\': sb.Append('\\'); break;
                        case '/': sb.Append('/'); break;
                        case 'b': sb.Append('\b'); break;
                        case 'f': sb.Append('\f'); break;
                        case 'n': sb.Append('\n'); break;
                        case 'r': sb.Append('\r'); break;
                        case 't': sb.Append('\t'); break;
                        case 'u':
                            if (pos + 4 > s.Length) throw new FormatException("truncated \\u escape");
                            sb.Append((char)ushort.Parse(s.Substring(pos, 4), NumberStyles.HexNumber, CultureInfo.InvariantCulture));
                            pos += 4;
                            break;
                        default: throw new FormatException("unknown escape '\\" + e + "'");
                    }
                }
                else
                {
                    sb.Append(c);
                }
            }
        }

        private static object ParseNumber(string s, ref int pos)
        {
            int start = pos;
            while (pos < s.Length && ("+-0123456789.eE".IndexOf(s[pos]) >= 0)) pos++;
            string token = s.Substring(start, pos - start);
            if (!double.TryParse(token, NumberStyles.Float, CultureInfo.InvariantCulture, out double n))
            {
                throw new FormatException("malformed number '" + token + "'");
            }
            return n;
        }

        private static void Expect(string s, ref int pos, string literal)
        {
            if (pos + literal.Length > s.Length || s.Substring(pos, literal.Length) != literal)
            {
                throw new FormatException("'" + literal + "' expected");
            }
            pos += literal.Length;
        }

        private static void SkipWhitespace(string s, ref int pos)
        {
            while (pos < s.Length && (s[pos] == ' ' || s[pos] == '\t' || s[pos] == '\n' || s[pos] == '\r')) pos++;
        }

        // ── writing ──────────────────────────────────────────────────────────

        public static string Serialize(object value)
        {
            var sb = new StringBuilder();
            Write(sb, value);
            return sb.ToString();
        }

        private static void Write(StringBuilder sb, object value)
        {
            if (value == null) { sb.Append("null"); return; }
            switch (value)
            {
                case string s: WriteString(sb, s); return;
                case bool b: sb.Append(b ? "true" : "false"); return;
                case IDictionary dict:
                {
                    sb.Append('{');
                    bool first = true;
                    foreach (DictionaryEntry e in dict)
                    {
                        if (!first) sb.Append(',');
                        first = false;
                        WriteString(sb, e.Key.ToString());
                        sb.Append(':');
                        Write(sb, e.Value);
                    }
                    sb.Append('}');
                    return;
                }
                case IEnumerable list when !(value is string):
                {
                    sb.Append('[');
                    bool first = true;
                    foreach (object item in list)
                    {
                        if (!first) sb.Append(',');
                        first = false;
                        Write(sb, item);
                    }
                    sb.Append(']');
                    return;
                }
                default:
                {
                    // Numbers (int, long, float, double) and anything else
                    // numeric-convertible; invariant culture keeps the wire
                    // locale-proof.
                    if (value is float f) { sb.Append(f.ToString("R", CultureInfo.InvariantCulture)); return; }
                    if (value is double d) { sb.Append(d.ToString("R", CultureInfo.InvariantCulture)); return; }
                    if (value is int || value is long || value is short || value is byte)
                    {
                        sb.Append(Convert.ToInt64(value, CultureInfo.InvariantCulture).ToString(CultureInfo.InvariantCulture));
                        return;
                    }
                    WriteString(sb, value.ToString());
                    return;
                }
            }
        }

        private static void WriteString(StringBuilder sb, string s)
        {
            sb.Append('"');
            foreach (char c in s)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\b': sb.Append("\\b"); break;
                    case '\f': sb.Append("\\f"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < ' ')
                        {
                            sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                        }
                        else
                        {
                            sb.Append(c);
                        }
                        break;
                }
            }
            sb.Append('"');
        }
    }
}
