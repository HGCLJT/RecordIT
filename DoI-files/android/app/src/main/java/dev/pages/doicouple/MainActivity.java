package dev.pages.doicouple;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Insets;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.os.Process;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.webkit.CookieManager;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.SslErrorHandler;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.window.OnBackInvokedDispatcher;

import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Pattern;

public final class MainActivity extends Activity {
    private static final String HOST = BuildConfig.DOI_HOST;
    private static final String ORIGIN = "https://" + HOST;
    private static final int DOCUMENT_REQUEST = 41;
    private static final int MEDIA_REQUEST = 42;
    private static final int MAX_BACKUP_BYTES = 10 * 1024 * 1024;
    private static final Pattern FILE_NAME = Pattern.compile("DoI-backup-\\d{4}-\\d{2}-\\d{2}\\.json");
    private static final Pattern REQUEST_ID = Pattern.compile("[0-9a-f-]{36}");

    private final ExecutorService files = Executors.newSingleThreadExecutor();
    private FrameLayout root;
    private LinearLayout overlay;
    private TextView launchStatus;
    private Button retry;
    private WebView webView;
    private boolean pageFailed;
    private boolean browserReady;
    private boolean backPending;
    private PendingDocument pendingDocument;
    private ValueCallback<Uri[]> pendingMedia;

    private record PendingDocument(String id, byte[] contents, JavaScriptReplyProxy reply) {
        boolean writing() {
            return contents != null;
        }
    }

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        root = new FrameLayout(this);
        root.setBackgroundColor(getColor(R.color.doi_surface));
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
            root.setOnApplyWindowInsetsListener((view, insets) -> {
                Insets visible = insets.getInsets(WindowInsets.Type.systemBars()
                        | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
                view.setPadding(visible.left, visible.top, visible.right, visible.bottom);
                return WindowInsets.CONSUMED;
            });
        }
        createOverlay();
        setContentView(root);
        if (Build.VERSION.SDK_INT >= 33) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                    OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::handleBack);
        }
        loadApp();
    }

    private void createOverlay() {
        overlay = new LinearLayout(this);
        overlay.setOrientation(LinearLayout.VERTICAL);
        overlay.setGravity(Gravity.CENTER);
        int padding = (int) (24 * getResources().getDisplayMetrics().density);
        overlay.setPadding(padding, padding, padding, padding);
        overlay.setBackgroundColor(getColor(R.color.doi_surface));
        launchStatus = new TextView(this);
        launchStatus.setGravity(Gravity.CENTER);
        launchStatus.setTextColor(getColor(R.color.doi_ink));
        launchStatus.setTextSize(16);
        overlay.addView(launchStatus);
        retry = new Button(this);
        retry.setText(R.string.retry);
        retry.setOnClickListener(view -> loadApp());
        overlay.addView(retry);
        root.addView(overlay, new FrameLayout.LayoutParams(-1, -1));
    }

    private void loadApp() {
        pageFailed = false;
        browserReady = false;
        launchStatus.setText(R.string.launch_loading);
        retry.setVisibility(View.GONE);
        overlay.setVisibility(View.VISIBLE);

        if (webView == null) {
            webView = new WebView(this);
            if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
                webView.destroy();
                webView = null;
                showFailure(R.string.webview_update_required);
                return;
            }
            configure(webView);
            root.addView(webView, 0, new FrameLayout.LayoutParams(-1, -1));
        }
        webView.loadUrl(ORIGIN + "/");
    }

    private void configure(WebView view) {
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setSupportMultipleWindows(false);
        CookieManager.getInstance().setAcceptThirdPartyCookies(view, false);
        view.setBackgroundColor(getColor(R.color.doi_surface));
        view.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView web, ValueCallback<Uri[]> callback, FileChooserParams params) {
                String pageUrl = web.getUrl();
                if (pageUrl == null || !isDoI(Uri.parse(pageUrl)) || pendingDocument != null || pendingMedia != null
                        || params.getMode() != FileChooserParams.MODE_OPEN) {
                    callback.onReceiveValue(null);
                    return true;
                }
                Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT).setType("*/*")
                        .addCategory(Intent.CATEGORY_OPENABLE)
                        .putExtra(Intent.EXTRA_MIME_TYPES, new String[]{"image/*", "video/*"});
                pendingMedia = callback;
                try {
                    startActivityForResult(intent, MEDIA_REQUEST);
                } catch (ActivityNotFoundException unavailable) {
                    finishMedia(null);
                }
                return true;
            }
        });
        view.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView web, WebResourceRequest request) {
                return !isDoI(request.getUrl());
            }

            @Override
            public void onPageStarted(WebView web, String url, android.graphics.Bitmap icon) {
                browserReady = false;
            }

            @Override
            public void onPageFinished(WebView web, String url) {
                if (!pageFailed && isDoI(Uri.parse(url))) {
                    browserReady = true;
                    overlay.setVisibility(View.GONE);
                }
            }

            @Override
            public void onReceivedError(WebView web, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) showFailure(R.string.launch_failed);
            }

            @Override
            public void onReceivedHttpError(WebView web, WebResourceRequest request, WebResourceResponse response) {
                if (request.isForMainFrame()) showFailure(R.string.launch_failed);
            }

            @Override
            public void onReceivedSslError(WebView web, SslErrorHandler handler, SslError error) {
                handler.cancel();
                if (isDoI(Uri.parse(error.getUrl()))) showFailure(R.string.launch_failed);
            }

            @Override
            public boolean onRenderProcessGone(WebView web, RenderProcessGoneDetail detail) {
                pendingDocument = null;
                releaseWebView();
                showFailure(R.string.launch_failed);
                return true;
            }
        });
        WebViewCompat.addWebMessageListener(view, "DoiAndroid", Collections.singleton(ORIGIN),
                (web, message, source, isMainFrame, reply) -> {
                    if (isMainFrame && isDoI(source)) receiveDocumentRequest(message.getData(), reply);
                });
    }

    private static boolean isDoI(Uri url) {
        return url != null
                && "https".equalsIgnoreCase(url.getScheme())
                && HOST.equalsIgnoreCase(url.getHost())
                && url.getUserInfo() == null
                && (url.getPort() == -1 || url.getPort() == 443);
    }

    private void showFailure(int message) {
        pageFailed = true;
        browserReady = false;
        launchStatus.setText(message);
        retry.setVisibility(View.VISIBLE);
        overlay.setVisibility(View.VISIBLE);
    }

    private void receiveDocumentRequest(String raw, JavaScriptReplyProxy reply) {
        if (raw == null || raw.length() > MAX_BACKUP_BYTES * 6 + 512) return;
        JSONObject request;
        try {
            request = new JSONObject(raw);
        } catch (JSONException invalid) {
            return;
        }
        String id = request.optString("id");
        if (!REQUEST_ID.matcher(id).matches()) return;
        if (pendingDocument != null || pendingMedia != null) {
            sendResult(reply, id, "busy", null);
            return;
        }
        Intent intent;
        byte[] backupContents = null;
        String action = request.optString("action");
        if ("save".equals(action)) {
            String name = request.optString("name");
            String text = request.optString("contents");
            if (!FILE_NAME.matcher(name).matches() || text.isEmpty() || text.length() > MAX_BACKUP_BYTES) {
                sendResult(reply, id, "invalid", null);
                return;
            }
            backupContents = text.getBytes(StandardCharsets.UTF_8);
            if (backupContents.length > MAX_BACKUP_BYTES) {
                sendResult(reply, id, "tooLarge", null);
                return;
            }
            intent = new Intent(Intent.ACTION_CREATE_DOCUMENT)
                    .setType("application/json").putExtra(Intent.EXTRA_TITLE, name);
        } else if ("open".equals(action)) {
            intent = new Intent(Intent.ACTION_OPEN_DOCUMENT).setType("*/*")
                    .putExtra(Intent.EXTRA_MIME_TYPES, new String[]{
                            "application/json", "text/plain", "application/octet-stream"
                    });
        } else {
            sendResult(reply, id, "invalid", null);
            return;
        }
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        pendingDocument = new PendingDocument(id, backupContents, reply);
        try {
            startActivityForResult(intent, DOCUMENT_REQUEST);
        } catch (ActivityNotFoundException unavailable) {
            pendingDocument = null;
            sendResult(reply, id, "unavailable", null);
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == MEDIA_REQUEST) {
            Uri uri = resultCode == RESULT_OK && data != null ? data.getData() : null;
            boolean readable = uri != null && "content".equals(uri.getScheme())
                    && checkUriPermission(uri, Process.myPid(), Process.myUid(), Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    == PackageManager.PERMISSION_GRANTED;
            finishMedia(readable ? uri : null);
            return;
        }
        if (requestCode != DOCUMENT_REQUEST || pendingDocument == null) return;

        PendingDocument operation = pendingDocument;
        Uri uri = data == null ? null : data.getData();
        if (resultCode != RESULT_OK || uri == null) {
            finishDocument(operation, "cancelled", null);
        } else if (!"content".equals(uri.getScheme())) {
            finishDocument(operation, "invalid", null);
        } else {
            files.execute(() -> performDocumentOperation(operation, uri));
        }
    }

    private void finishMedia(Uri uri) {
        ValueCallback<Uri[]> chooser = pendingMedia;
        pendingMedia = null;
        if (chooser != null) chooser.onReceiveValue(uri == null ? null : new Uri[]{uri});
    }

    private void performDocumentOperation(PendingDocument operation, Uri uri) {
        try {
            if (operation.writing()) {
                try (OutputStream stream = getContentResolver().openOutputStream(uri, "wt")) {
                    if (stream == null) throw new IOException();
                    stream.write(operation.contents());
                }
                runOnUiThread(() -> finishDocument(operation, "ok", null));
            } else {
                String contents = readDocument(uri);
                runOnUiThread(() -> finishDocument(operation, "ok", contents));
            }
        } catch (IOException | SecurityException failure) {
            runOnUiThread(() -> finishDocument(operation, "ioError", null));
        }
    }

    private String readDocument(Uri uri) throws IOException {
        try (InputStream input = getContentResolver().openInputStream(uri)) {
            if (input == null) throw new IOException();
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            for (int size; (size = input.read(buffer)) != -1; ) {
                if (size > MAX_BACKUP_BYTES - output.size()) throw new IOException();
                output.write(buffer, 0, size);
            }
            return StandardCharsets.UTF_8.newDecoder().decode(ByteBuffer.wrap(output.toByteArray())).toString();
        }
    }

    private void finishDocument(PendingDocument operation, String status, String contents) {
        if (pendingDocument != operation) return;
        pendingDocument = null;
        sendResult(operation.reply(), operation.id(), status, contents);
    }

    private static void sendResult(JavaScriptReplyProxy reply, String id, String status, String contents) {
        try {
            JSONObject result = new JSONObject();
            result.put("id", id);
            result.put("status", status);
            if (contents != null) result.put("contents", contents);
            reply.postMessage(result.toString());
        } catch (JSONException | IllegalStateException discardedPage) {
            // The original page may have closed while the document picker was open.
        }
    }

    @Override
    public void onBackPressed() {
        handleBack();
    }

    private void handleBack() {
        if (backPending) return;
        if (!browserReady || webView == null) {
            finish();
            return;
        }
        backPending = true;
        webView.evaluateJavascript(
                "!window.dispatchEvent(new Event('doi:android-back', {cancelable: true}))",
                result -> {
                    backPending = false;
                    if (!"true".equals(result) && !isFinishing()) finish();
                });
    }

    @Override
    protected void onStop() {
        super.onStop();
        CookieManager.getInstance().flush();
    }

    private void releaseWebView() {
        if (webView == null) return;
        finishMedia(null);
        root.removeView(webView);
        webView.destroy();
        webView = null;
    }

    @Override
    protected void onDestroy() {
        pendingDocument = null;
        files.shutdownNow();
        releaseWebView();
        super.onDestroy();
    }
}
