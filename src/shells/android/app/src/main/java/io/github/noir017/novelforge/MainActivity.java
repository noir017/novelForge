package io.github.noir017.novelforge;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Message;
import android.provider.Settings;
import android.text.InputType;
import android.util.Log;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.ConsoleMessage;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.RadioButton;
import android.widget.RadioGroup;
import android.widget.TextView;
import android.widget.Toast;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * WebView 壳。页面由服务端吐出来（独立版的同一个页面），壳只决定打开哪个地址：
 * - 本机模式：起内置服务端（{@link LocalServer}），带令牌登录后打开 http://127.0.0.1:端口；
 * - 远程模式：打开设置里填的服务器地址（比如部署在 NAS 上的 Docker 版），填了令牌就替作者登录。
 * 服务端设置是原生对话框：页面属于服务端，远程那台的版本不一定认识这个壳。入口是返回键弹出的菜单，
 * 连不上时的提示页上也有。
 */
public class MainActivity extends Activity {
    private static final String TAG = "NovelForge";
    private static final int REQ_STORAGE = 1;
    private static final int REQ_NOTIFY = 2;

    /** 进程级：Activity 重建不重启服务端 */
    private static LocalServer server;
    private static final ExecutorService bg = Executors.newSingleThreadExecutor();

    private SharedPreferences prefs;
    private WebView web;
    private LinearLayout panel;
    private TextView panelText;
    private LinearLayout panelButtons;
    /** 当前服务端的源（scheme://host:port）：同源的链接留在 WebView 里，别的交给浏览器 */
    private Uri base;
    private boolean starting;
    private boolean loadFailed;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences("novelforge", MODE_PRIVATE);
        if (server == null) server = new LocalServer(this, prefs);

        FrameLayout root = new FrameLayout(this);
        web = new WebView(this);
        root.addView(web);
        root.addView(buildPanel());
        setContentView(root);
        setupWebView();

        if (mode() == null) showServerSettings(true);
        else boot();
    }

    private View buildPanel() {
        panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setGravity(Gravity.CENTER);
        int pad = dp(32);
        panel.setPadding(pad, pad, pad, pad);
        TypedValue bgColor = new TypedValue();
        getTheme().resolveAttribute(android.R.attr.colorBackground, bgColor, true);
        panel.setBackgroundColor(bgColor.data);
        panelText = new TextView(this);
        panelText.setGravity(Gravity.CENTER);
        panelText.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        panel.addView(panelText);
        panelButtons = new LinearLayout(this);
        panelButtons.setGravity(Gravity.CENTER);
        panelButtons.setPadding(0, dp(16), 0, 0);
        Button retry = new Button(this);
        retry.setText("重试");
        retry.setOnClickListener(v -> boot());
        Button settings = new Button(this);
        settings.setText("服务端设置");
        settings.setOnClickListener(v -> showServerSettings(false));
        panelButtons.addView(retry);
        panelButtons.addView(settings);
        panel.addView(panelButtons);
        return panel;
    }

    private void showPanel(String text, boolean withButtons) {
        panelText.setText(text);
        panelButtons.setVisibility(withButtons ? View.VISIBLE : View.GONE);
        panel.setVisibility(View.VISIBLE);
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void setupWebView() {
        WebView.setWebContentsDebuggingEnabled((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setSupportMultipleWindows(true);
        s.setJavaScriptCanOpenWindowsAutomatically(true);
        // 字号由页面自己的设置管，不跟系统字体缩放（放大了窄屏布局会挤坏）
        s.setTextZoom(100);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (sameOrigin(u)) return false;
                openExternal(u);
                return true;
            }

            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                loadFailed = false;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                if (!loadFailed && !starting) panel.setVisibility(View.GONE);
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
                if (!req.isForMainFrame()) return;
                loadFailed = true;
                showPanel("连不上 " + base + "\n" + err.getDescription(), true);
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            /** window.open（外部链接）：交给系统浏览器 */
            @Override
            public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture, Message resultMsg) {
                WebView probe = new WebView(MainActivity.this);
                probe.setWebViewClient(new WebViewClient() {
                    @Override
                    public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
                        openExternal(req.getUrl());
                        v.destroy();
                        return true;
                    }
                });
                ((WebView.WebViewTransport) resultMsg.obj).setWebView(probe);
                resultMsg.sendToTarget();
                return true;
            }

            @Override
            public boolean onConsoleMessage(ConsoleMessage m) {
                Log.d(TAG, m.messageLevel() + " " + m.message() + " @" + m.sourceId() + ":" + m.lineNumber());
                return true;
            }
        });
    }

    /** "local" / "remote"；null = 还没选过 */
    private String mode() {
        return prefs.getString("mode", null);
    }

    /** 按当前模式启停内置服务端，再打开对应的地址 */
    private void boot() {
        if ("remote".equals(mode())) {
            starting = false;
            bg.execute(server::stop);
            ServerService.stop(this);
            String url = prefs.getString("remote_url", "");
            if (url.isEmpty()) {
                showServerSettings(false);
                return;
            }
            Uri u = Uri.parse(url);
            base = new Uri.Builder().scheme(u.getScheme()).encodedAuthority(u.getEncodedAuthority()).build();
            String token = prefs.getString("remote_token", "");
            // 地址不通时 WebView 要等半分钟才报错，这期间也得能改地址
            showPanel("正在连接 " + base + "…", true);
            if (token.isEmpty()) web.loadUrl(base + "/");
            else login(token);
            return;
        }
        if (!publicStorageGranted() && !prefs.getBoolean("storage_asked", false)) {
            askStorage();
            return;
        }
        askNotificationsOnce();
        starting = true;
        showPanel("正在启动本机服务…", false);
        ServerService.start(this);
        File books = booksDir();
        bg.execute(() -> {
            LocalServer.Status st = server.start(books);
            runOnUiThread(() -> {
                if (isDestroyed()) return;
                starting = false;
                if (!st.ok) {
                    ServerService.stop(this);
                    showPanel("本机服务没有启动：" + st.error, true);
                    return;
                }
                base = Uri.parse(st.url);
                login(st.token);
            });
        });
    }

    /** 走服务端自己的登录页：交令牌、种 cookie、跳回首页（首页再跳到最近打开的那本书） */
    private void login(String token) {
        String form = "token=" + Uri.encode(token) + "&next=%2F";
        web.postUrl(base + "/login", form.getBytes(StandardCharsets.UTF_8));
    }

    private boolean sameOrigin(Uri u) {
        return base != null && base.getScheme() != null && base.getScheme().equals(u.getScheme())
                && base.getEncodedAuthority() != null && base.getEncodedAuthority().equals(u.getEncodedAuthority());
    }

    // ── 书放在哪 ──────────────────────────────────────────────────

    private boolean publicStorageGranted() {
        if (Build.VERSION.SDK_INT >= 30) return Environment.isExternalStorageManager();
        return checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED;
    }

    /** 有权限放 Documents/NovelForge，没有就放 app 自己的目录（卸载时一起删） */
    private File booksDir() {
        if (publicStorageGranted()) {
            return new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOCUMENTS), "NovelForge");
        }
        File own = getExternalFilesDir("books");
        return own != null ? own : new File(getFilesDir(), "books");
    }

    private void askStorage() {
        new AlertDialog.Builder(this)
                .setTitle("书放在哪")
                .setMessage("建议放在「Documents/NovelForge」：文件管理器、同步盘都看得到，卸载 app 也不会删。"
                        + "这需要「所有文件访问」权限。\n\n不授权就放在 app 自己的目录，卸载 app 时会一起删掉。之后可以在「服务端设置」里改。")
                .setPositiveButton("去授权", (d, w) -> {
                    prefs.edit().putBoolean("storage_asked", true).apply();
                    requestStorage();
                })
                .setNegativeButton("放在 app 目录", (d, w) -> {
                    prefs.edit().putBoolean("storage_asked", true).apply();
                    boot();
                })
                .setCancelable(false)
                .show();
    }

    private void requestStorage() {
        if (Build.VERSION.SDK_INT >= 30) {
            try {
                startActivityForResult(new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
                        Uri.parse("package:" + getPackageName())), REQ_STORAGE);
            } catch (ActivityNotFoundException e) {
                startActivityForResult(new Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION), REQ_STORAGE);
            }
        } else {
            requestPermissions(new String[]{Manifest.permission.WRITE_EXTERNAL_STORAGE}, REQ_STORAGE);
        }
    }

    /** 常驻通知要通知权限（Android 13+）；不给服务照样跑，只是看不到那条通知，所以只问一次 */
    private void askNotificationsOnce() {
        if (Build.VERSION.SDK_INT < 33 || prefs.getBoolean("notify_asked", false)) return;
        prefs.edit().putBoolean("notify_asked", true).apply();
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIFY);
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_STORAGE) boot();
        else super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        if (requestCode == REQ_STORAGE) boot();
    }

    // ── 服务端设置 ─────────────────────────────────────────────────

    /** @param first 第一次打开：必须选一个，不能取消 */
    private void showServerSettings(boolean first) {
        LinearLayout form = new LinearLayout(this);
        form.setOrientation(LinearLayout.VERTICAL);
        int pad = dp(20);
        form.setPadding(pad, dp(8), pad, 0);

        RadioGroup modes = new RadioGroup(this);
        RadioButton local = new RadioButton(this);
        local.setId(View.generateViewId());
        local.setText("本机：在手机上跑内置服务");
        RadioButton remote = new RadioButton(this);
        remote.setId(View.generateViewId());
        remote.setText("远程：连接已经部署好的服务器");
        modes.addView(local);
        modes.addView(remote);
        form.addView(modes);

        TextView where = new TextView(this);
        where.setPadding(dp(32), 0, 0, dp(8));
        form.addView(where);
        Button grant = new Button(this);
        grant.setText("改放 Documents/NovelForge（授权）");
        grant.setAllCaps(false);
        grant.setOnClickListener(v -> requestStorage());
        form.addView(grant, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        EditText url = new EditText(this);
        url.setHint("地址，如 192.168.1.10:3680");
        url.setSingleLine(true);
        url.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        url.setText(prefs.getString("remote_url", ""));
        form.addView(url);
        EditText token = new EditText(this);
        token.setHint("访问令牌（可空）");
        // setSingleLine 会换掉遮挡字符的 TransformationMethod，必须排在设密码类型之前，不然令牌明文显示
        token.setSingleLine(true);
        token.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        token.setText(prefs.getString("remote_token", ""));
        form.addView(token);

        Runnable sync = () -> {
            boolean isLocal = modes.getCheckedRadioButtonId() == local.getId();
            where.setVisibility(isLocal ? View.VISIBLE : View.GONE);
            where.setText("书放在：" + booksDir());
            grant.setVisibility(isLocal && !publicStorageGranted() ? View.VISIBLE : View.GONE);
            url.setVisibility(isLocal ? View.GONE : View.VISIBLE);
            token.setVisibility(isLocal ? View.GONE : View.VISIBLE);
        };
        modes.check("remote".equals(mode()) ? remote.getId() : local.getId());
        modes.setOnCheckedChangeListener((g, id) -> sync.run());
        sync.run();

        AlertDialog.Builder b = new AlertDialog.Builder(this)
                .setTitle("服务端")
                .setView(form)
                .setPositiveButton("确定", null)
                .setCancelable(!first);
        if (!first) b.setNegativeButton("取消", null);
        AlertDialog dialog = b.show();
        // 自己接「确定」：地址不对时不关对话框
        dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v -> {
            boolean isLocal = modes.getCheckedRadioButtonId() == local.getId();
            SharedPreferences.Editor e = prefs.edit().putString("mode", isLocal ? "local" : "remote");
            if (!isLocal) {
                String normalized = normalizeUrl(url.getText().toString());
                if (normalized == null) {
                    url.setError("填服务器的地址，如 http://192.168.1.10:3680");
                    return;
                }
                e.putString("remote_url", normalized).putString("remote_token", token.getText().toString().trim());
            }
            e.apply();
            dialog.dismiss();
            boot();
        });
    }

    /** 补上 http://、去掉路径：服务端的页面、/ws、/login 都挂在根上 */
    static String normalizeUrl(String raw) {
        String s = raw.trim();
        if (s.isEmpty()) return null;
        if (!s.contains("://")) s = "http://" + s;
        Uri u = Uri.parse(s);
        String scheme = u.getScheme();
        if (u.getHost() == null || u.getHost().isEmpty() || !("http".equals(scheme) || "https".equals(scheme))) return null;
        return scheme + "://" + u.getEncodedAuthority();
    }

    // ── 返回键与生命周期 ───────────────────────────────────────────

    /** 页面是单页，没有「上一页」可回；返回键弹出壳的菜单 */
    @Override
    public void onBackPressed() {
        new AlertDialog.Builder(this)
                .setItems(new CharSequence[]{"服务端设置…", "退出 Novel Forge"}, (d, which) -> {
                    if (which == 0) showServerSettings(false);
                    else quit();
                })
                .show();
    }

    private void quit() {
        shutdownServer();
        ServerService.stop(this);
        finishAndRemoveTask();
    }

    /** 本机服务进程意外退出了（或书的位置变了）：回到前台时重新起 */
    @Override
    protected void onResume() {
        super.onResume();
        if ("local".equals(mode()) && base != null && !starting && !server.isRunning(booksDir())) boot();
    }

    @Override
    protected void onPause() {
        super.onPause();
        CookieManager.getInstance().flush();
    }

    static void shutdownServer() {
        if (server != null) bg.execute(server::stop);
    }

    @Override
    protected void onDestroy() {
        if (isFinishing()) {
            shutdownServer();
            ServerService.stop(this);
        }
        web.destroy();
        super.onDestroy();
    }

    private void openExternal(Uri u) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, u));
        } catch (ActivityNotFoundException e) {
            Toast.makeText(this, u.toString(), Toast.LENGTH_SHORT).show();
        }
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }
}
