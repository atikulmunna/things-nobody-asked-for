package dev.cloudboard.app;

import java.io.ByteArrayOutputStream;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TimeZone;
import java.util.TreeMap;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/** AWS Signature Version 4, kept free of Android classes so it can be unit tested on the JVM. */
final class SigV4 {

    private SigV4() {}

    /** A validated request target with its canonical path and query. */
    static final class Target {
        String service;
        String region;
        String hostHeader;
        String canonicalPath;
        String canonicalQuery;
        final List<String[]> query = new ArrayList<>();

        /** Only https URLs on amazonaws.com are accepted; the service is derived from the host. */
        static Target parse(String raw, String region) throws Exception {
            if (raw == null) throw new SecurityException("Missing URL.");
            URI uri = new URI(raw);
            if (!"https".equalsIgnoreCase(uri.getScheme())) throw new SecurityException("Only https is allowed.");
            String host = uri.getHost() == null ? "" : uri.getHost().toLowerCase(Locale.ROOT);
            if (!host.endsWith(".amazonaws.com") || uri.getUserInfo() != null || (uri.getPort() != -1 && uri.getPort() != 443)) {
                throw new SecurityException("cloudBoard only sends requests to amazonaws.com.");
            }
            if (region == null || !region.matches("[a-z]{2}(-[a-z]+)+-\\d")) throw new SecurityException("Unknown region.");
            return build(host, serviceFor(host), region, uri.getRawPath(), uri.getRawQuery());
        }

        static Target build(String host, String service, String region, String rawPath, String rawQuery) {
            Target t = new Target();
            t.service = service;
            t.region = region;
            t.hostHeader = host;
            if (rawPath == null || rawPath.isEmpty()) rawPath = "/";
            StringBuilder path = new StringBuilder();
            String[] segments = rawPath.split("/", -1);
            for (int i = 1; i < segments.length; i++) path.append('/').append(uriEncode(percentDecode(segments[i])));
            t.canonicalPath = path.length() == 0 ? "/" : path.toString();
            if (rawQuery != null && !rawQuery.isEmpty()) {
                for (String pair : rawQuery.split("&")) {
                    if (pair.isEmpty()) continue;
                    int eq = pair.indexOf('=');
                    t.query.add(new String[] {
                        percentDecode(eq < 0 ? pair : pair.substring(0, eq)),
                        percentDecode(eq < 0 ? "" : pair.substring(eq + 1)),
                    });
                }
            }
            t.canonicalQuery = canonicalQuery(t.query);
            return t;
        }

        String requestUrl() {
            return "https://" + hostHeader + canonicalPath + (canonicalQuery.isEmpty() ? "" : "?" + canonicalQuery);
        }

        static String serviceFor(String host) {
            // S3 first: a bucket called "logs" has the virtual host logs.s3.<region>.amazonaws.com.
            if (host.startsWith("s3.") || host.startsWith("s3-") || host.contains(".s3.") || host.contains(".s3-")) return "s3";
            if (host.startsWith("sqs.")) return "sqs";
            if (host.startsWith("monitoring.")) return "monitoring";
            if (host.startsWith("logs.")) return "logs";
            if (host.startsWith("sts.")) return "sts";
            if (host.startsWith("ecs.")) return "ecs";
            if (host.startsWith("ec2.")) return "ec2";
            if (host.equals("iam.amazonaws.com")) return "iam";
            if (host.startsWith("lambda.")) return "lambda";
            if (host.equals("ce.us-east-1.amazonaws.com")) return "ce";
            if (host.startsWith("dynamodb.")) return "dynamodb";
            if (host.startsWith("rds.")) return "rds";
            if (host.startsWith("sns.")) return "sns";
            throw new SecurityException("cloudBoard does not talk to " + host + ".");
        }
    }

    static String authorization(String accessKeyId, String secret, Target t, String method,
                                TreeMap<String, String> signed, String payloadHash, String amzDate) throws Exception {
        StringBuilder names = new StringBuilder();
        for (String k : signed.keySet()) {
            if (names.length() > 0) names.append(';');
            names.append(k);
        }
        String signedHeaders = names.toString();
        String canonicalRequest = method + "\n" + t.canonicalPath + "\n" + t.canonicalQuery + "\n"
            + canonicalHeaders(signed) + "\n" + signedHeaders + "\n" + payloadHash;
        String scope = amzDate.substring(0, 8) + "/" + t.region + "/" + t.service + "/aws4_request";
        return "AWS4-HMAC-SHA256 Credential=" + accessKeyId + "/" + scope
            + ", SignedHeaders=" + signedHeaders
            + ", Signature=" + signature(secret, t.region, t.service, amzDate, canonicalRequest);
    }

    static String signature(String secret, String region, String service, String amzDate, String canonicalRequest) throws Exception {
        String date = amzDate.substring(0, 8);
        String scope = date + "/" + region + "/" + service + "/aws4_request";
        String toSign = "AWS4-HMAC-SHA256\n" + amzDate + "\n" + scope + "\n" + hex(sha256(canonicalRequest.getBytes(StandardCharsets.UTF_8)));
        byte[] k = hmac(("AWS4" + secret).getBytes(StandardCharsets.UTF_8), date);
        k = hmac(k, region);
        k = hmac(k, service);
        k = hmac(k, "aws4_request");
        return hex(hmac(k, toSign));
    }

    static String canonicalHeaders(TreeMap<String, String> signed) {
        StringBuilder sb = new StringBuilder();
        for (Map.Entry<String, String> e : signed.entrySet()) {
            sb.append(e.getKey()).append(':').append(e.getValue().trim().replaceAll("\\s+", " ")).append('\n');
        }
        return sb.toString();
    }

    static String canonicalQuery(List<String[]> query) {
        List<String[]> enc = new ArrayList<>();
        for (String[] kv : query) enc.add(new String[] {uriEncode(kv[0]), uriEncode(kv[1])});
        Collections.sort(enc, (a, b) -> a[0].equals(b[0]) ? a[1].compareTo(b[1]) : a[0].compareTo(b[0]));
        StringBuilder sb = new StringBuilder();
        for (String[] kv : enc) {
            if (sb.length() > 0) sb.append('&');
            sb.append(kv[0]).append('=').append(kv[1]);
        }
        return sb.toString();
    }

    static String uriEncode(String s) {
        StringBuilder sb = new StringBuilder();
        for (byte b : s.getBytes(StandardCharsets.UTF_8)) {
            int c = b & 0xff;
            if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.' || c == '~') {
                sb.append((char) c);
            } else {
                sb.append('%').append(Character.toUpperCase(Character.forDigit(c >> 4, 16))).append(Character.toUpperCase(Character.forDigit(c & 15, 16)));
            }
        }
        return sb.toString();
    }

    /** Percent-decodes without treating '+' as a space (paths and SigV4 queries keep '+'). */
    static String percentDecode(String s) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        for (int i = 0; i < s.length(); i++) {
            char ch = s.charAt(i);
            if (ch == '%' && i + 2 < s.length()) {
                int hi = Character.digit(s.charAt(i + 1), 16);
                int lo = Character.digit(s.charAt(i + 2), 16);
                if (hi >= 0 && lo >= 0) {
                    out.write((hi << 4) | lo);
                    i += 2;
                    continue;
                }
            }
            if (Character.isHighSurrogate(ch) && i + 1 < s.length()) {
                byte[] bytes = s.substring(i, i + 2).getBytes(StandardCharsets.UTF_8);
                out.write(bytes, 0, bytes.length);
                i += 1;
                continue;
            }
            byte[] bytes = String.valueOf(ch).getBytes(StandardCharsets.UTF_8);
            out.write(bytes, 0, bytes.length);
        }
        return new String(out.toByteArray(), StandardCharsets.UTF_8);
    }

    static String amzDate(Date d) {
        SimpleDateFormat f = new SimpleDateFormat("yyyyMMdd'T'HHmmss'Z'", Locale.US);
        f.setTimeZone(TimeZone.getTimeZone("UTC"));
        return f.format(d);
    }

    static byte[] sha256(byte[] data) throws Exception {
        return MessageDigest.getInstance("SHA-256").digest(data);
    }

    static byte[] hmac(byte[] key, String data) throws Exception {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(key, "HmacSHA256"));
        return mac.doFinal(data.getBytes(StandardCharsets.UTF_8));
    }

    static String hex(byte[] bytes) {
        StringBuilder sb = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) sb.append(Character.forDigit((b >> 4) & 15, 16)).append(Character.forDigit(b & 15, 16));
        return sb.toString();
    }
}
