package dev.watchboard.app;

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
import java.util.Iterator;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Minimal HTTP client for the web layer. Native requests are not bound by browser CORS
 * rules, which the W&B API needs. Unlike the built-in CapacitorHttp plugin, this one never
 * parses response bodies, so streamed JSON lines from Weave arrive intact.
 */
@CapacitorPlugin(name = "RawHttp")
public class RawHttpPlugin extends Plugin {

    private static final int MAX_BODY_BYTES = 16 * 1024 * 1024;
    private final ExecutorService pool = Executors.newFixedThreadPool(4);

    @PluginMethod
    public void request(PluginCall call) {
        String url = call.getString("url");
        String method = call.getString("method", "GET");
        JSObject headers = call.getObject("headers", new JSObject());
        String body = call.getString("body");
        int timeout = call.getInt("timeoutMs", 45000);
        if (url == null || !(url.startsWith("https://") || url.startsWith("http://"))) {
            call.reject("Only http and https URLs are supported.");
            return;
        }
        if (!"GET".equals(method) && !"POST".equals(method)) {
            call.reject("Only GET and POST are supported.");
            return;
        }

        pool.execute(() -> {
            HttpURLConnection conn = null;
            try {
                // Redirects are followed by hand so the Authorization header never leaves the
                // original host (W&B file URLs redirect to signed storage URLs).
                String originHost = new URL(url).getHost();
                URL current = new URL(url);
                int status;
                int hops = 0;
                while (true) {
                    conn = (HttpURLConnection) current.openConnection();
                    conn.setRequestMethod(method);
                    conn.setConnectTimeout(timeout);
                    conn.setReadTimeout(timeout);
                    conn.setInstanceFollowRedirects(false);
                    conn.setUseCaches(false);
                    boolean sameHost = current.getHost().equalsIgnoreCase(originHost);
                    Iterator<String> keys = headers.keys();
                    while (keys.hasNext()) {
                        String key = keys.next();
                        String value = headers.getString(key);
                        if (value == null || (!sameHost && "authorization".equalsIgnoreCase(key))) continue;
                        conn.setRequestProperty(key, value);
                    }
                    if (body != null && "POST".equals(method)) {
                        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
                        conn.setDoOutput(true);
                        conn.setFixedLengthStreamingMode(bytes.length);
                        try (OutputStream out = conn.getOutputStream()) {
                            out.write(bytes);
                        }
                    }
                    status = conn.getResponseCode();
                    String location = conn.getHeaderField("Location");
                    boolean redirect = status == 301 || status == 302 || status == 303 || status == 307 || status == 308;
                    if (!redirect || location == null || !"GET".equals(method) || hops >= 5) break;
                    current = new URL(current, location);
                    if (!"https".equals(current.getProtocol()) && !"http".equals(current.getProtocol())) break;
                    conn.disconnect();
                    hops++;
                }
                InputStream in = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
                JSObject result = new JSObject();
                result.put("status", status);
                result.put("body", in == null ? "" : readAll(in));
                call.resolve(result);
            } catch (Exception e) {
                call.reject(e.getClass().getSimpleName() + ": " + e.getMessage());
            } finally {
                if (conn != null) conn.disconnect();
            }
        });
    }

    private static String readAll(InputStream in) throws IOException {
        try (InputStream stream = in; ByteArrayOutputStream buf = new ByteArrayOutputStream()) {
            byte[] chunk = new byte[16384];
            int total = 0;
            int n;
            while ((n = stream.read(chunk)) != -1) {
                total += n;
                if (total > MAX_BODY_BYTES) throw new IOException("Response is larger than 16 MB.");
                buf.write(chunk, 0, n);
            }
            return new String(buf.toByteArray(), StandardCharsets.UTF_8);
        }
    }

    @Override
    protected void handleOnDestroy() {
        pool.shutdownNow();
    }
}
