package dev.cloudboard.app;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Date;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONObject;

/**
 * Holds the AWS credentials and signs every request on the native side.
 *
 * The keys are encrypted with an AES key that lives in the Android Keystore and never leaves
 * it. The web layer can save or clear credentials but can never read the secret back.
 *
 * The app is read-only by design, and this class enforces it: requests only go to
 * *.amazonaws.com over HTTPS, S3 only allows GET and HEAD, and every other call must be on an
 * allowlist of read actions (see ReadOnlyPolicy).
 */
@CapacitorPlugin(name = "Aws")
public class AwsPlugin extends Plugin {

    private static final String PREFS = "cloudboard_vault";
    private static final String PREF_BLOB = "credentials";
    private static final String KEY_ALIAS = "cloudboard_credentials";
    private static final int MAX_BODY_BYTES = 16 * 1024 * 1024;
    private static final Set<String> PASS_HEADERS = new HashSet<>(Arrays.asList("content-type", "x-amz-target", "range", "accept"));

    private final ExecutorService pool = Executors.newFixedThreadPool(6);
    private volatile Creds cached;

    private static final class Creds {
        final String accessKeyId;
        final String secretAccessKey;
        final String sessionToken;

        Creds(String accessKeyId, String secretAccessKey, String sessionToken) {
            this.accessKeyId = accessKeyId;
            this.secretAccessKey = secretAccessKey;
            this.sessionToken = sessionToken;
        }
    }

    // ------------------------------------------------------------------------------------------
    // Credentials

    @PluginMethod
    public void status(PluginCall call) {
        pool.execute(() -> {
            JSObject out = new JSObject();
            try {
                Creds c = loadCreds();
                out.put("hasCredentials", c != null);
                if (c != null) {
                    out.put("accessKeyId", mask(c.accessKeyId));
                    out.put("temporary", c.sessionToken != null);
                }
            } catch (Exception e) {
                // A Keystore key that can no longer decrypt the blob counts as no credentials.
                out.put("hasCredentials", false);
            }
            call.resolve(out);
        });
    }

    @PluginMethod
    public void save(PluginCall call) {
        String id = trim(call.getString("accessKeyId"));
        String secret = trim(call.getString("secretAccessKey"));
        String token = trim(call.getString("sessionToken"));
        if (id == null || !id.matches("[A-Z0-9]{16,128}")) {
            call.reject("That access key ID does not look right. It starts with AKIA or ASIA and is 20 capital letters and digits.");
            return;
        }
        if (secret == null || secret.length() < 16 || secret.matches(".*\\s.*")) {
            call.reject("That secret access key does not look right. Paste it again without spaces.");
            return;
        }
        pool.execute(() -> {
            try {
                JSONObject json = new JSONObject();
                json.put("a", id);
                json.put("s", secret);
                if (token != null) json.put("t", token);
                prefs().edit().putString(PREF_BLOB, encrypt(json.toString())).apply();
                cached = new Creds(id, secret, token);
                JSObject out = new JSObject();
                out.put("accessKeyId", mask(id));
                call.resolve(out);
            } catch (Exception e) {
                call.reject("Could not store the keys securely: " + e.getMessage());
            }
        });
    }

    @PluginMethod
    public void clear(PluginCall call) {
        pool.execute(() -> {
            cached = null;
            prefs().edit().remove(PREF_BLOB).apply();
            try {
                KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
                ks.load(null);
                if (ks.containsAlias(KEY_ALIAS)) ks.deleteEntry(KEY_ALIAS);
            } catch (Exception ignored) {
                // The encrypted blob is already gone, so a leftover key protects nothing.
            }
            call.resolve();
        });
    }

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private Creds loadCreds() throws Exception {
        Creds c = cached;
        if (c != null) return c;
        String blob = prefs().getString(PREF_BLOB, null);
        if (blob == null) return null;
        JSONObject json = new JSONObject(decrypt(blob));
        c = new Creds(json.getString("a"), json.getString("s"), json.has("t") ? json.getString("t") : null);
        cached = c;
        return c;
    }

    private static SecretKey keystoreKey() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        if (ks.containsAlias(KEY_ALIAS)) {
            return ((KeyStore.SecretKeyEntry) ks.getEntry(KEY_ALIAS, null)).getSecretKey();
        }
        KeyGenerator kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        kg.init(new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .build());
        return kg.generateKey();
    }

    private static String encrypt(String plain) throws Exception {
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.ENCRYPT_MODE, keystoreKey());
        byte[] ct = c.doFinal(plain.getBytes(StandardCharsets.UTF_8));
        return Base64.encodeToString(c.getIV(), Base64.NO_WRAP) + ":" + Base64.encodeToString(ct, Base64.NO_WRAP);
    }

    private static String decrypt(String blob) throws Exception {
        String[] parts = blob.split(":", 2);
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.DECRYPT_MODE, keystoreKey(), new GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)));
        return new String(c.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)), StandardCharsets.UTF_8);
    }

    private static String mask(String id) {
        if (id.length() <= 8) return id;
        return id.substring(0, 4) + "\u2026" + id.substring(id.length() - 4);
    }

    // ------------------------------------------------------------------------------------------
    // Signed requests

    @PluginMethod
    public void request(PluginCall call) {
        String rawUrl = call.getString("url");
        String method = call.getString("method", "GET").toUpperCase(Locale.ROOT);
        String region = call.getString("region", "us-east-1");
        JSObject headers = call.getObject("headers", new JSObject());
        String body = call.getString("body", "");
        boolean base64 = "base64".equals(call.getString("responseType", "text"));
        int timeout = call.getInt("timeoutMs", 30000);

        pool.execute(() -> {
            HttpURLConnection conn = null;
            try {
                Creds creds = loadCreds();
                if (creds == null) {
                    call.reject("No AWS keys are saved on this phone.", "NO_CREDENTIALS");
                    return;
                }
                SigV4.Target t = SigV4.Target.parse(rawUrl, region);

                Map<String, String> pass = new TreeMap<>();
                Iterator<String> keys = headers.keys();
                while (keys.hasNext()) {
                    String k = keys.next();
                    String v = headers.getString(k);
                    String lk = k.toLowerCase(Locale.ROOT);
                    if (v != null && PASS_HEADERS.contains(lk)) pass.put(lk, v.trim());
                }
                String payload = ReadOnlyPolicy.enforce(t.service, method, pass.get("x-amz-target"), body == null ? "" : body);
                byte[] bodyBytes = payload.getBytes(StandardCharsets.UTF_8);

                String amzDate = SigV4.amzDate(new Date());
                String payloadHash = SigV4.hex(SigV4.sha256(bodyBytes));
                TreeMap<String, String> signed = new TreeMap<>();
                signed.put("host", t.hostHeader);
                signed.put("x-amz-date", amzDate);
                signed.put("x-amz-content-sha256", payloadHash);
                if (creds.sessionToken != null) signed.put("x-amz-security-token", creds.sessionToken);
                if (pass.containsKey("content-type")) signed.put("content-type", pass.get("content-type"));
                if (pass.containsKey("x-amz-target")) signed.put("x-amz-target", pass.get("x-amz-target"));
                String authorization = SigV4.authorization(creds.accessKeyId, creds.secretAccessKey, t, method, signed, payloadHash, amzDate);

                conn = (HttpURLConnection) new URL(t.requestUrl()).openConnection();
                conn.setRequestMethod(method);
                conn.setConnectTimeout(timeout);
                conn.setReadTimeout(timeout);
                conn.setInstanceFollowRedirects(false);
                conn.setUseCaches(false);
                for (Map.Entry<String, String> e : signed.entrySet()) {
                    if (!"host".equals(e.getKey())) conn.setRequestProperty(e.getKey(), e.getValue());
                }
                for (Map.Entry<String, String> e : pass.entrySet()) conn.setRequestProperty(e.getKey(), e.getValue());
                conn.setRequestProperty("Authorization", authorization);
                if ("POST".equals(method)) {
                    conn.setDoOutput(true);
                    conn.setFixedLengthStreamingMode(bodyBytes.length);
                    try (OutputStream out = conn.getOutputStream()) {
                        out.write(bodyBytes);
                    }
                }

                int status = conn.getResponseCode();
                JSObject respHeaders = new JSObject();
                for (Map.Entry<String, List<String>> e : conn.getHeaderFields().entrySet()) {
                    if (e.getKey() == null) continue;
                    respHeaders.put(e.getKey().toLowerCase(Locale.ROOT), join(e.getValue()));
                }
                JSObject result = new JSObject();
                result.put("status", status);
                result.put("headers", respHeaders);
                if ("HEAD".equals(method)) {
                    result.put("body", "");
                } else {
                    InputStream in = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
                    byte[] data = in == null ? new byte[0] : readAll(in);
                    result.put("body", base64 && status < 400
                        ? Base64.encodeToString(data, Base64.NO_WRAP)
                        : new String(data, StandardCharsets.UTF_8));
                }
                call.resolve(result);
            } catch (SecurityException e) {
                call.reject(e.getMessage(), "BLOCKED");
            } catch (Exception e) {
                call.reject(e.getClass().getSimpleName() + ": " + e.getMessage(), "NETWORK");
            } finally {
                if (conn != null) conn.disconnect();
            }
        });
    }

    /** A time-limited link to read one S3 object, for opening in the browser. */
    @PluginMethod
    public void presign(PluginCall call) {
        String rawUrl = call.getString("url");
        String region = call.getString("region", "us-east-1");
        int expires = Math.max(60, Math.min(call.getInt("expiresSeconds", 900), 3600));
        pool.execute(() -> {
            try {
                Creds creds = loadCreds();
                if (creds == null) {
                    call.reject("No AWS keys are saved on this phone.", "NO_CREDENTIALS");
                    return;
                }
                SigV4.Target t = SigV4.Target.parse(rawUrl, region);
                if (!"s3".equals(t.service)) throw new SecurityException("Only S3 objects can be opened as links.");
                String amzDate = SigV4.amzDate(new Date());
                String scope = amzDate.substring(0, 8) + "/" + t.region + "/s3/aws4_request";
                List<String[]> q = new ArrayList<>(t.query);
                q.add(new String[] {"X-Amz-Algorithm", "AWS4-HMAC-SHA256"});
                q.add(new String[] {"X-Amz-Credential", creds.accessKeyId + "/" + scope});
                q.add(new String[] {"X-Amz-Date", amzDate});
                q.add(new String[] {"X-Amz-Expires", String.valueOf(expires)});
                q.add(new String[] {"X-Amz-SignedHeaders", "host"});
                if (creds.sessionToken != null) q.add(new String[] {"X-Amz-Security-Token", creds.sessionToken});
                String canonicalQuery = SigV4.canonicalQuery(q);
                TreeMap<String, String> signed = new TreeMap<>();
                signed.put("host", t.hostHeader);
                String canonicalRequest = "GET\n" + t.canonicalPath + "\n" + canonicalQuery + "\n"
                    + SigV4.canonicalHeaders(signed) + "\nhost\nUNSIGNED-PAYLOAD";
                String signature = SigV4.signature(creds.secretAccessKey, t.region, "s3", amzDate, canonicalRequest);
                JSObject out = new JSObject();
                out.put("url", "https://" + t.hostHeader + t.canonicalPath + "?" + canonicalQuery + "&X-Amz-Signature=" + signature);
                call.resolve(out);
            } catch (SecurityException e) {
                call.reject(e.getMessage(), "BLOCKED");
            } catch (Exception e) {
                call.reject(e.getMessage());
            }
        });
    }

    @PluginMethod
    public void openExternal(PluginCall call) {
        String url = call.getString("url", "");
        if (!url.startsWith("https://")) {
            call.reject("Only https links can be opened.");
            return;
        }
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("No app on this phone can open that link.");
        }
    }

    // ------------------------------------------------------------------------------------------
    // Small helpers

    private static byte[] readAll(InputStream in) throws IOException {
        try (InputStream stream = in; ByteArrayOutputStream buf = new ByteArrayOutputStream()) {
            byte[] chunk = new byte[16384];
            int total = 0;
            int n;
            while ((n = stream.read(chunk)) != -1) {
                total += n;
                if (total > MAX_BODY_BYTES) throw new IOException("Response is larger than 16 MB.");
                buf.write(chunk, 0, n);
            }
            return buf.toByteArray();
        }
    }

    private static String trim(String s) {
        if (s == null) return null;
        String t = s.trim();
        return t.isEmpty() ? null : t;
    }

    private static String join(List<String> parts) {
        StringBuilder sb = new StringBuilder();
        for (String p : parts) {
            if (sb.length() > 0) sb.append(',');
            sb.append(p);
        }
        return sb.toString();
    }

    @Override
    protected void handleOnDestroy() {
        pool.shutdownNow();
    }
}
