package com.arcguard.app;

import android.Manifest;
import android.app.Activity;
import android.app.DownloadManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.view.inputmethod.EditorInfo;
import android.webkit.JavascriptInterface;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;

import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Arc Guard Android app: shows the backend's live dashboard (served by FastAPI on the laptop)
 * in a WebView, and turns detection events into phone notifications + vibration.
 *
 * Connection options:
 *  - USB cable:  run `adb reverse tcp:8000 tcp:8000` on the laptop, then use http://localhost:8000
 *  - Wi-Fi:      phone on the same network as the laptop, use http://<laptop-ip>:8000
 */
public class MainActivity extends Activity {

    private static final String PREFS = "arcguard";
    private static final String KEY_SERVER = "server";
    private static final String KEY_NOTIFY = "notify";
    private static final String KEY_AWAKE = "keep_awake";
    private static final String CHANNEL_ID = "arcguard_events";
    private static final int REQ_FILE = 41;
    private static final int REQ_NOTIF = 42;

    private static final int BG = Color.parseColor("#0b1017");
    private static final int PANEL = Color.parseColor("#121a24");
    private static final int LINE = Color.parseColor("#233246");
    private static final int TEXT = Color.parseColor("#e6edf5");
    private static final int MUTED = Color.parseColor("#8898ad");
    private static final int ACCENT = Color.parseColor("#3fb6ff");
    private static final int OK = Color.parseColor("#34d399");
    private static final int BAD = Color.parseColor("#f87171");

    private SharedPreferences prefs;
    private FrameLayout root;
    private WebView web;
    private View setupView;
    private View errorView;
    private TextView errorText;
    private ValueCallback<Uri[]> fileCallback;
    private boolean inForeground;
    private boolean mainFrameFailed;
    private int notifId = 1000;
    private final Handler ui = new Handler(Looper.getMainLooper());

    // ------------------------------------------------------------------ lifecycle
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        createChannel();
        requestNotificationPermission();

        root = new FrameLayout(this);
        root.setBackgroundColor(BG);
        setContentView(root);

        web = buildWebView();
        root.addView(web, match());
        applyKeepAwake();

        String server = prefs.getString(KEY_SERVER, null);
        if (server == null) showSetup();
        else load(server, hashFrom(getIntent()));
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        String hash = hashFrom(intent);
        if (hash != null && setupView == null) web.evaluateJavascript("location.hash='" + hash + "'", null);
    }

    @Override protected void onResume() { super.onResume(); inForeground = true; }
    // The WebView is deliberately NOT paused, so the live connection keeps running (and can
    // raise notifications) while the app is in the background, until Android stops the app.
    @Override protected void onPause() { super.onPause(); inForeground = false; }

    @Override
    protected void onDestroy() {
        if (web != null) { web.stopLoading(); web.destroy(); }
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        if (setupView != null && prefs.getString(KEY_SERVER, null) != null) { hideSetup(); return; }
        if (setupView == null && errorView == null && web.canGoBack()) { web.goBack(); return; }
        super.onBackPressed();
    }

    private static String hashFrom(Intent i) {
        return i == null ? null : i.getStringExtra("hash");
    }

    // ------------------------------------------------------------------ web view
    private WebView buildWebView() {
        WebView w = new WebView(this);
        w.setBackgroundColor(BG);
        WebSettings s = w.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setBuiltInZoomControls(true);
        s.setDisplayZoomControls(false);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setUserAgentString(s.getUserAgentString() + " ArcGuardApp/1.0");
        w.addJavascriptInterface(new Bridge(), "ArcGuardNative");

        w.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                String server = prefs.getString(KEY_SERVER, "");
                // Pages of the backend stay in the app; anything else opens in the phone's browser.
                if (u.toString().startsWith(server)) return false;
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception ignored) { }
                return true;
            }

            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                mainFrameFailed = false;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                if (!mainFrameFailed) hideError();
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
                if (req.isForMainFrame()) {
                    mainFrameFailed = true;
                    showError("Can't reach the Arc Guard backend at\n" + prefs.getString(KEY_SERVER, "?")
                            + "\n\n" + err.getDescription());
                }
            }
        });

        w.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = cb;
                try {
                    startActivityForResult(params.createIntent(), REQ_FILE);
                } catch (Exception e) {
                    fileCallback = null;
                    return false;
                }
                return true;
            }
        });

        // "Download CSV" on the Events tab
        w.setDownloadListener((url, userAgent, contentDisposition, mimetype, contentLength) -> {
            try {
                String name = URLUtil.guessFileName(url, contentDisposition, mimetype);
                if (!name.contains(".")) name = "arcguard_events.csv";
                DownloadManager.Request r = new DownloadManager.Request(Uri.parse(url));
                r.setMimeType(mimetype);
                r.setTitle(name);
                r.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                r.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name);
                ((DownloadManager) getSystemService(DOWNLOAD_SERVICE)).enqueue(r);
                Toast.makeText(this, "Downloading " + name, Toast.LENGTH_SHORT).show();
            } catch (Exception e) {
                try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url))); } catch (Exception ignored) { }
            }
        });
        return w;
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_FILE && fileCallback != null) {
            fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
            fileCallback = null;
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    private void load(String server, String hash) {
        hideSetup();
        hideError();
        web.loadUrl(server + "/" + (hash != null ? "#" + hash : ""));
    }

    /** Called from the dashboard page (window.ArcGuardNative). */
    private class Bridge {
        @JavascriptInterface
        public void onEvent(String json) {
            ui.post(() -> handleEvent(json));
        }

        @JavascriptInterface
        public void openSettings() {
            ui.post(MainActivity.this::showSetup);
        }

        @JavascriptInterface
        public String version() {
            return "1.0";
        }
    }

    // ------------------------------------------------------------------ events -> notifications
    private void handleEvent(String json) {
        if (!prefs.getBoolean(KEY_NOTIFY, true)) return;
        String category = "EVENT", sensor = "", detail = "";
        try {
            JSONObject e = new JSONObject(json);
            category = e.optString("category", "EVENT");
            int sid = e.optInt("sensor_id", 0);
            sensor = sid == 3 ? "Scanning sensor" : sid > 0 ? "Sensor " + sid : "";
            if (!e.isNull("angle_deg")) detail += "at " + e.optInt("angle_deg") + "°  ";
            if (!e.isNull("distance_cm")) detail += Math.round(e.optDouble("distance_cm")) + " cm  ";
            detail += e.optString("kind", "");
        } catch (Exception ignored) { }
        boolean movement = "MOVEMENT".equals(category);
        vibrate(movement ? new long[]{0, 400, 150, 400} : new long[]{0, 200});
        if (inForeground) return; // the dashboard already shows a toast
        String title = (movement ? "Possible movement" : "Anomaly") + (sensor.isEmpty() ? "" : " · " + sensor);
        postNotification(title, detail.trim());
    }

    private void vibrate(long[] pattern) {
        Vibrator v = (Vibrator) getSystemService(VIBRATOR_SERVICE);
        if (v == null || !v.hasVibrator()) return;
        if (Build.VERSION.SDK_INT >= 26) v.vibrate(VibrationEffect.createWaveform(pattern, -1));
        else v.vibrate(pattern, -1);
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "Detection events", NotificationManager.IMPORTANCE_HIGH);
        ch.setDescription("Possible movement and anomalies reported by Arc Guard");
        ch.enableVibration(true);
        getSystemService(NotificationManager.class).createNotificationChannel(ch);
    }

    private void requestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIF);
        }
    }

    private void postNotification(String title, String text) {
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return;
        Intent open = new Intent(this, MainActivity.class).putExtra("hash", "events")
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pi = PendingIntent.getActivity(this, 0, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this).setPriority(Notification.PRIORITY_HIGH);
        b.setSmallIcon(R.drawable.ic_fg)
                .setColor(ACCENT)
                .setContentTitle(title)
                .setContentText(text)
                .setAutoCancel(true)
                .setContentIntent(pi)
                .setWhen(System.currentTimeMillis())
                .setShowWhen(true);
        getSystemService(NotificationManager.class).notify(notifId++, b.build());
    }

    private void applyKeepAwake() {
        if (prefs.getBoolean(KEY_AWAKE, false)) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }

    // ------------------------------------------------------------------ setup screen
    private void showSetup() {
        if (setupView != null) return;
        hideError();
        String current = prefs.getString(KEY_SERVER, "http://localhost:8000");

        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        int p = dp(20);
        col.setPadding(p, dp(28), p, p);

        TextView brand = text("ARC GUARD", 22, TEXT, true);
        brand.setLetterSpacing(0.12f);
        col.addView(brand);
        col.addView(spaced(text("Connect to the Arc Guard backend running on your laptop.", 14, MUTED, false), 4, 18));

        LinearLayout card = card();
        card.addView(text("Backend address", 12, MUTED, true));
        EditText url = new EditText(this);
        url.setText(current);
        url.setSingleLine(true);
        url.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        url.setImeOptions(EditorInfo.IME_ACTION_GO);
        url.setTextColor(TEXT);
        url.setHintTextColor(MUTED);
        url.setHint("http://192.168.1.5:8000");
        url.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        card.addView(url);

        LinearLayout presets = new LinearLayout(this);
        presets.setOrientation(LinearLayout.HORIZONTAL);
        Button usb = button("USB cable", false);
        usb.setOnClickListener(v -> url.setText("http://localhost:8000"));
        Button wifi = button("Wi-Fi", false);
        wifi.setOnClickListener(v -> { url.setText("http://192.168.1."); url.setSelection(url.length()); });
        presets.addView(usb, weighted());
        presets.addView(wifi, weighted());
        card.addView(spaced(presets, 6, 0));

        TextView status = text("", 13, MUTED, false);
        card.addView(spaced(status, 8, 0));

        LinearLayout actions = new LinearLayout(this);
        actions.setOrientation(LinearLayout.HORIZONTAL);
        Button test = button("Test", false);
        Button go = button("Connect", true);
        actions.addView(test, weighted());
        actions.addView(go, weighted());
        card.addView(spaced(actions, 10, 0));
        col.addView(card);

        LinearLayout opts = card();
        CheckBox notify = checkbox("Notify + vibrate on movement / anomaly events", prefs.getBoolean(KEY_NOTIFY, true));
        CheckBox awake = checkbox("Keep the screen on while the app is open", prefs.getBoolean(KEY_AWAKE, false));
        opts.addView(notify);
        opts.addView(awake);
        col.addView(spaced(opts, 14, 0));

        LinearLayout help = card();
        help.addView(text("How to connect", 14, TEXT, true));
        help.addView(spaced(text(
                "1. On the laptop, start the backend (in C:\\IOTProject\\backend):\n"
                        + "   python -m uvicorn app.main:app --host 0.0.0.0 --port 8000\n\n"
                        + "USB cable: on the laptop run\n"
                        + "   adb reverse tcp:8000 tcp:8000\n"
                        + "then use http://localhost:8000 (redo it after re-plugging the phone).\n\n"
                        + "Wi-Fi: put the phone on the same network as the laptop and use the laptop's IPv4 "
                        + "address from `ipconfig`, e.g. http://192.168.1.5:8000. If it does not load, allow "
                        + "Python through Windows Firewall (private networks).",
                13, MUTED, false), 6, 0));
        col.addView(spaced(help, 14, 0));

        ScrollView sv = new ScrollView(this);
        sv.setBackgroundColor(BG);
        sv.setFillViewport(true);
        sv.addView(col);
        setupView = sv;
        root.addView(sv, match());

        Runnable connect = () -> {
            String s = normalise(url.getText().toString());
            if (s == null) { status.setTextColor(BAD); status.setText("Enter an address like http://192.168.1.5:8000"); return; }
            prefs.edit().putString(KEY_SERVER, s)
                    .putBoolean(KEY_NOTIFY, notify.isChecked())
                    .putBoolean(KEY_AWAKE, awake.isChecked()).apply();
            applyKeepAwake();
            load(s, null);
        };
        go.setOnClickListener(v -> connect.run());
        url.setOnEditorActionListener((v, actionId, ev) -> { connect.run(); return true; });
        test.setOnClickListener(v -> {
            String s = normalise(url.getText().toString());
            if (s == null) { status.setTextColor(BAD); status.setText("Enter an address like http://192.168.1.5:8000"); return; }
            status.setTextColor(MUTED);
            status.setText("Testing " + s + " …");
            new Thread(() -> {
                String result;
                boolean ok = false;
                try {
                    HttpURLConnection c = (HttpURLConnection) new URL(s + "/api/status").openConnection();
                    c.setConnectTimeout(4000);
                    c.setReadTimeout(4000);
                    int code = c.getResponseCode();
                    ok = code == 200;
                    result = ok ? "Backend reachable ✓" : "Server answered HTTP " + code + " — is this the Arc Guard backend?";
                    c.disconnect();
                } catch (Exception e) {
                    result = "Not reachable: " + e.getMessage();
                }
                final String r = result;
                final boolean good = ok;
                ui.post(() -> { status.setTextColor(good ? OK : BAD); status.setText(r); });
            }).start();
        });
    }

    private void hideSetup() {
        if (setupView == null) return;
        root.removeView(setupView);
        setupView = null;
    }

    private static String normalise(String raw) {
        String s = raw.trim();
        if (s.isEmpty()) return null;
        if (!s.startsWith("http://") && !s.startsWith("https://")) s = "http://" + s;
        while (s.endsWith("/")) s = s.substring(0, s.length() - 1);
        try {
            URL u = new URL(s);
            if (u.getHost() == null || u.getHost().isEmpty()) return null;
        } catch (Exception e) {
            return null;
        }
        return s;
    }

    // ------------------------------------------------------------------ error panel
    private void showError(String message) {
        if (errorView == null) {
            LinearLayout col = new LinearLayout(this);
            col.setOrientation(LinearLayout.VERTICAL);
            col.setGravity(Gravity.CENTER);
            col.setBackgroundColor(BG);
            int p = dp(24);
            col.setPadding(p, p, p, p);
            col.addView(text("Not connected", 20, TEXT, true));
            errorText = text("", 14, MUTED, false);
            errorText.setGravity(Gravity.CENTER);
            col.addView(spaced(errorText, 10, 18));
            Button retry = button("Retry", true);
            retry.setOnClickListener(v -> load(prefs.getString(KEY_SERVER, "http://localhost:8000"), null));
            Button change = button("Change server", false);
            change.setOnClickListener(v -> showSetup());
            col.addView(retry, new LinearLayout.LayoutParams(dp(220), ViewGroup.LayoutParams.WRAP_CONTENT));
            col.addView(spaced(change, 8, 0), new LinearLayout.LayoutParams(dp(220), ViewGroup.LayoutParams.WRAP_CONTENT));
            errorView = col;
            root.addView(col, match());
        }
        errorText.setText(message);
        // auto-retry while the error is shown (e.g. backend still starting, cable re-plugged)
        ui.removeCallbacks(autoRetry);
        ui.postDelayed(autoRetry, 5000);
    }

    private final Runnable autoRetry = () -> {
        if (errorView != null && setupView == null) web.reload();
    };

    private void hideError() {
        ui.removeCallbacks(autoRetry);
        if (errorView == null) return;
        root.removeView(errorView);
        errorView = null;
    }

    // ------------------------------------------------------------------ small view helpers
    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    private static FrameLayout.LayoutParams match() {
        return new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
    }

    private LinearLayout.LayoutParams weighted() {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        lp.setMargins(dp(3), 0, dp(3), 0);
        return lp;
    }

    private TextView text(String s, int sp, int color, boolean bold) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        t.setTextColor(color);
        if (bold) t.setTypeface(Typeface.DEFAULT_BOLD);
        return t;
    }

    private <T extends View> T spaced(T v, int topDp, int bottomDp) {
        v.setPadding(v.getPaddingLeft(), v.getPaddingTop() + dp(topDp), v.getPaddingRight(), v.getPaddingBottom() + dp(bottomDp));
        return v;
    }

    private LinearLayout card() {
        LinearLayout c = new LinearLayout(this);
        c.setOrientation(LinearLayout.VERTICAL);
        GradientDrawable g = new GradientDrawable();
        g.setColor(PANEL);
        g.setStroke(dp(1), LINE);
        g.setCornerRadius(dp(12));
        c.setBackground(g);
        c.setPadding(dp(16), dp(14), dp(16), dp(14));
        return c;
    }

    private Button button(String label, boolean primary) {
        Button b = new Button(this);
        b.setText(label);
        b.setAllCaps(false);
        b.setTextColor(primary ? BG : TEXT);
        b.setTypeface(Typeface.DEFAULT_BOLD);
        GradientDrawable g = new GradientDrawable();
        g.setColor(primary ? ACCENT : Color.parseColor("#172231"));
        g.setStroke(dp(1), primary ? ACCENT : LINE);
        g.setCornerRadius(dp(8));
        b.setBackground(g);
        return b;
    }

    private CheckBox checkbox(String label, boolean checked) {
        CheckBox c = new CheckBox(this);
        c.setText(label);
        c.setTextColor(TEXT);
        c.setChecked(checked);
        c.setButtonTintList(android.content.res.ColorStateList.valueOf(ACCENT));
        return c;
    }
}
