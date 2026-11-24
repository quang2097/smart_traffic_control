package com.smarttraffic.android;

import android.webkit.CookieManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

// Preserve Capacitor's asset loader while streaming only approved camera paths
// through the local app origin. HttpOnly session cookies never enter JavaScript.
public class CameraWebViewClient extends BridgeWebViewClient {
    private volatile String backend;
    private final Set<HttpURLConnection> connections = ConcurrentHashMap.newKeySet();
    public CameraWebViewClient(Bridge bridge) { super(bridge); }
    public synchronized void setBackend(String origin) {
        if (!origin.equals(backend)) { cancelAll(); backend = origin; }
    }
    public void cancelAll() { for (HttpURLConnection connection : connections) connection.disconnect(); connections.clear(); }
    private WebResourceResponse error(int status, String message) {
        Map<String, String> headers = new HashMap<>(); headers.put("Cache-Control", "no-store");
        return new WebResourceResponse("application/json", "UTF-8", status, "Camera request failed", headers,
            new ByteArrayInputStream(("{\"message\":\"" + message + "\"}").getBytes(StandardCharsets.UTF_8)));
    }
    @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        String path = request.getUrl().getPath();
        if ("https".equals(request.getUrl().getScheme()) && "localhost".equals(request.getUrl().getHost())
            && (request.getUrl().getPort() == -1 || request.getUrl().getPort() == 443)
            && path != null && path.startsWith("/api/demo/videos/")) return video(request, path);

        if (!"https".equals(request.getUrl().getScheme()) || !"localhost".equals(request.getUrl().getHost())
            || (request.getUrl().getPort() != -1 && request.getUrl().getPort() != 443)
            || path == null || !path.startsWith("/api/cameras/")) return super.shouldInterceptRequest(view, request);
        if (!"GET".equals(request.getMethod()) || !path.matches("/api/cameras/[a-z0-9][a-z0-9-]{0,79}/(snapshot|stream)"))
            return error(400, "Đường dẫn camera không hợp lệ.");
        String origin = backend;
        if (origin == null) return error(403, "Chưa chọn máy chủ camera.");
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(origin + path).openConnection();
            connections.add(connection);
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(10000); connection.setReadTimeout(12000);
            connection.setRequestProperty("Accept", path.endsWith("/stream") ? "multipart/x-mixed-replace" : "image/svg+xml,image/jpeg,image/png,image/webp");
            String cookies = CookieManager.getInstance().getCookie(origin + path);
            if (cookies != null) connection.setRequestProperty("Cookie", cookies);
            if (!origin.equals(backend)) throw new IOException("Backend changed");
            int status = connection.getResponseCode();
            if (status != 200) { connections.remove(connection); connection.disconnect(); return error(status == 401 ? 401 : 502, "Camera không khả dụng hoặc phiên đăng nhập đã hết hạn."); }
            boolean streaming = path.endsWith("/stream");
            String type = connection.getContentType();
            String received = connection.getHeaderField("X-Camera-Received-At");
            if (type == null || !(streaming ? type.toLowerCase().matches("multipart/x-mixed-replace\\s*;\\s*boundary=.+") : type.toLowerCase().matches("image/(svg\\+xml|jpeg|png|webp)(;.*)?"))) throw new IOException("Unsupported camera format");
            HttpURLConnection owned = connection;
            InputStream data;
            if (!streaming) {
                ByteArrayOutputStream bytes = new ByteArrayOutputStream();
                long deadline = System.nanoTime() + 12000000000L;
                try (InputStream input = connection.getInputStream()) {
                    byte[] buffer = new byte[8192]; int count;
                    while ((count = input.read(buffer)) != -1) {
                        if (bytes.size() + count > 5 * 1024 * 1024 || System.nanoTime() > deadline || !origin.equals(backend)) throw new IOException("Snapshot limit reached");
                        bytes.write(buffer, 0, count);
                    }
                }
                connections.remove(connection); connection.disconnect();
                data = new ByteArrayInputStream(bytes.toByteArray());
            } else data = new FilterInputStream(connection.getInputStream()) {
                private long bytes = 0;
                private final long deadline = System.nanoTime() + (streaming ? 65000000000L : 12000000000L);
                private final long limit = (streaming ? 64L : 5L) * 1024 * 1024;
                private void bound(int count) throws IOException {
                    if (count > 0) bytes += count;
                    if (bytes > limit || System.nanoTime() > deadline || !origin.equals(backend)) { close(); throw new IOException("Camera limit reached"); }
                }
                @Override public int read() throws IOException { int value = super.read(); bound(value == -1 ? 0 : 1); return value; }
                @Override public int read(byte[] buffer, int offset, int length) throws IOException { int count = in.read(buffer, offset, length); bound(count); return count; }
                @Override public void close() throws IOException { try { super.close(); } finally { connections.remove(owned); owned.disconnect(); } }
            };
            Map<String, String> headers = new HashMap<>();
            headers.put("Content-Type", type); headers.put("Cache-Control", "no-store"); headers.put("X-Content-Type-Options", "nosniff");
            if (received != null) headers.put("X-Camera-Received-At", received);
            return new WebResourceResponse(type.split(";")[0], null, 200, "OK", headers, data);
        } catch (Exception failure) {
            if (connection != null) { connections.remove(connection); connection.disconnect(); }
            return error(502, "Không thể kết nối camera.");
        }
    }
    private WebResourceResponse video(WebResourceRequest request, String path) {
        if (!"GET".equals(request.getMethod()) || !path.matches("/api/demo/videos/[a-f0-9]{24}/stream") || request.getUrl().getQuery() != null)
            return error(400, "Invalid video path");
        String origin = backend;
        if (origin == null) return error(403, "Choose a backend first");
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(origin + path).openConnection();
            connections.add(connection); connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(10000); connection.setReadTimeout(30000);
            connection.setRequestProperty("Accept", "video/mp4,video/webm");
            for (Map.Entry<String,String> header : request.getRequestHeaders().entrySet()) {
                if (header.getKey().equalsIgnoreCase("Range")) {
                    if (!header.getValue().matches("bytes=[0-9]*-[0-9]*")) throw new IOException("Invalid range");
                    connection.setRequestProperty("Range",header.getValue());
                }
            }
            String cookies = CookieManager.getInstance().getCookie(origin + path);
            if (cookies != null) connection.setRequestProperty("Cookie",cookies);
            int status = connection.getResponseCode();
            if (status != 200 && status != 206) { connections.remove(connection); connection.disconnect(); return error(status == 401 ? 401 : 502,"Server video unavailable"); }
            String type = connection.getContentType();
            if (type == null || !type.toLowerCase().matches("video/(mp4|webm)(;.*)?")) throw new IOException("Invalid video format");
            Map<String,String> headers = new HashMap<>();
            headers.put("Content-Type",type); headers.put("Cache-Control","no-store"); headers.put("X-Content-Type-Options","nosniff");
            for (String key : new String[]{"Accept-Ranges","Content-Range","Content-Length"}) { String value=connection.getHeaderField(key); if(value!=null) headers.put(key,value); }
            final HttpURLConnection owned = connection;
            InputStream stream = new FilterInputStream(connection.getInputStream()) {
                private long bytes=0;
                private void bound(int count) throws IOException { if(count>0)bytes+=count; if(bytes>2L*1024*1024*1024 || !origin.equals(backend)) { close(); throw new IOException("Video stream limit"); } }
                @Override public int read() throws IOException { int value=in.read(); bound(value<0?0:1); return value; }
                @Override public int read(byte[] buffer,int offset,int length) throws IOException { int count=in.read(buffer,offset,length); bound(count); return count; }
                @Override public void close() throws IOException { try{super.close();}finally{connections.remove(owned);owned.disconnect();} }
            };
            return new WebResourceResponse(type.split(";")[0], null, status, status==206?"Partial Content":"OK",headers,stream);
        } catch(Exception failure) { if(connection!=null){connections.remove(connection);connection.disconnect();} return error(502,"Unable to open server video"); }
    }

}
