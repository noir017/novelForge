package io.github.noir017.novelforge;

import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.util.Log;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.PrintWriter;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.ArrayDeque;
import java.util.Map;
import java.util.TimeZone;
import java.util.concurrent.TimeUnit;

/**
 * 内置服务端：Termux 编的 node（jniLibs 里的 libnode.so，见 scripts/fetch-node.sh）跑 assets/server.cjs
 * ——独立版打成的 node 单文件（scripts/build-android-server.js）。
 * Android 10+ 只允许执行 nativeLibraryDir 里的文件，所以 node 不能放进数据目录。
 * 只监听 127.0.0.1，但手机上任何 app 都能连回环地址（包括 /mcp），所以一律带每台设备随机生成的令牌。
 */
final class LocalServer {
    static final class Status {
        final String url;
        final String token;
        final boolean ok;
        final String error;

        Status(String url, String token, boolean ok, String error) {
            this.url = url;
            this.token = token;
            this.ok = ok;
            this.error = error;
        }
    }

    private static final String TAG = "NovelForgeServer";
    /** 与独立版缺省端口相同；被占用才随机 */
    private static final int PREFERRED_PORT = 36800;
    private static final long START_TIMEOUT_MS = 30_000;

    private final Context ctx;
    private final SharedPreferences prefs;
    private Process proc;
    private Status status;
    private File booksDir;
    /** 最近的输出，启动失败时拿来当原因 */
    private final ArrayDeque<String> tail = new ArrayDeque<>();

    LocalServer(Context ctx, SharedPreferences prefs) {
        this.ctx = ctx.getApplicationContext();
        this.prefs = prefs;
    }

    /** 在跑、而且书的位置没变 */
    synchronized boolean isRunning(File books) {
        return proc != null && proc.isAlive() && status != null && status.ok && books.equals(booksDir);
    }

    /**
     * 启动并等到能连上（阻塞，别在主线程调）；已在跑、书的位置也没变就直接返回。
     * @param books 放书的目录：node 的家目录，「新建一本书」「打开文件夹」都从这里起
     */
    synchronized Status start(File books) {
        if (isRunning(books)) return status;
        stop();
        String token = token();
        int port = pickPort();
        String url = "http://127.0.0.1:" + port;
        try {
            File script = installServer();
            File nativeDir = new File(ctx.getApplicationInfo().nativeLibraryDir);
            File node = new File(nativeDir, "libnode.so");
            if (!node.exists()) return status = new Status(url, token, false, "APK 里没有 node（libnode.so）");

            File config = new File(ctx.getFilesDir(), "novelforge");
            File tmp = new File(ctx.getCacheDir(), "server-tmp");
            //noinspection ResultOfMethodCallIgnored
            tmp.mkdirs();
            //noinspection ResultOfMethodCallIgnored
            books.mkdirs();

            // --use-bundled-ca：Termux 版 node 默认去 Termux 目录找根证书，这里没有，调模型的 HTTPS 会失败。
            // node:sqlite 每次开库都打一行 ExperimentalWarning，只会把日志刷满。
            ProcessBuilder pb = new ProcessBuilder(node.getPath(), "--use-bundled-ca", "--disable-warning=ExperimentalWarning",
                    script.getPath(), "--port", String.valueOf(port), "--no-open")
                    .directory(books)
                    .redirectErrorStream(true);
            Map<String, String> env = pb.environment();
            env.put("LD_LIBRARY_PATH", nativeDir.getPath());
            env.put("HOME", books.getPath());
            // 配置与 API Key 留在 app 私有目录，别跟着家目录落到别的 app 也读得到的地方（src/core/stores.ts）
            env.put("NOVELFORGE_HOME", config.getPath());
            env.put("NOVELFORGE_TOKEN", token);
            env.put("TMPDIR", tmp.getPath());
            env.put("TZ", TimeZone.getDefault().getID());
            proc = pb.start();
            booksDir = books;
            pumpOutput(proc.getInputStream());
            return status = waitReady(url, token);
        } catch (IOException e) {
            Log.e(TAG, "start failed", e);
            stop();
            return status = new Status(url, token, false, String.valueOf(e.getMessage()));
        }
    }

    synchronized void stop() {
        status = null;
        booksDir = null;
        if (proc == null) return;
        proc.destroy();
        try {
            if (!proc.waitFor(2, TimeUnit.SECONDS)) proc.destroyForcibly();
        } catch (InterruptedException e) {
            proc.destroyForcibly();
            Thread.currentThread().interrupt();
        }
        proc = null;
    }

    /** 登录页不要令牌，它回 200 就是服务起来了 */
    private Status waitReady(String url, String token) {
        long deadline = System.currentTimeMillis() + START_TIMEOUT_MS;
        while (System.currentTimeMillis() < deadline) {
            if (!proc.isAlive()) return new Status(url, token, false, "node 退出（" + proc.exitValue() + "）：" + lastOutput());
            try {
                HttpURLConnection c = (HttpURLConnection) new URL(url + "/login").openConnection();
                c.setConnectTimeout(500);
                c.setReadTimeout(1000);
                int code = c.getResponseCode();
                c.disconnect();
                if (code == 200) return new Status(url, token, true, null);
            } catch (IOException ignored) {
                // 还没开始监听
            }
            try {
                Thread.sleep(200);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                break;
            }
        }
        return new Status(url, token, false, "启动超时：" + lastOutput());
    }

    private String token() {
        String t = prefs.getString("server_token", null);
        if (t == null) {
            byte[] b = new byte[24];
            new SecureRandom().nextBytes(b);
            StringBuilder sb = new StringBuilder();
            for (byte x : b) sb.append(String.format("%02x", x));
            t = sb.toString();
            prefs.edit().putString("server_token", t).apply();
        }
        return t;
    }

    private static int pickPort() {
        try (ServerSocket s = new ServerSocket(PREFERRED_PORT, 1, InetAddress.getByName("127.0.0.1"))) {
            return s.getLocalPort();
        } catch (IOException e) {
            try (ServerSocket s = new ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))) {
                return s.getLocalPort();
            } catch (IOException e2) {
                return PREFERRED_PORT;
            }
        }
    }

    /** 把 assets/server.cjs 拷到 files/server/；APK 没更新过就沿用上次拷好的 */
    private File installServer() throws IOException {
        File dir = new File(ctx.getFilesDir(), "server");
        File script = new File(dir, "server.cjs");
        long stamp;
        try {
            stamp = ctx.getPackageManager().getPackageInfo(ctx.getPackageName(), 0).lastUpdateTime;
        } catch (PackageManager.NameNotFoundException e) {
            stamp = -1;
        }
        if (script.isFile() && prefs.getLong("server_stamp", 0) == stamp) return script;
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        File part = new File(dir, "server.cjs.part");
        byte[] buf = new byte[64 * 1024];
        try (InputStream in = ctx.getAssets().open("server.cjs"); OutputStream out = new FileOutputStream(part)) {
            for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
        }
        if (!part.renameTo(script)) throw new IOException("写不进 " + script);
        prefs.edit().putLong("server_stamp", stamp).apply();
        return script;
    }

    /** node 的输出进 logcat 和 files/server.log（覆盖写，只留本次运行） */
    private void pumpOutput(InputStream in) {
        File log = new File(ctx.getFilesDir(), "server.log");
        synchronized (tail) {
            tail.clear();
        }
        Thread t = new Thread(() -> {
            try (BufferedReader r = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8));
                 PrintWriter w = new PrintWriter(new FileOutputStream(log), true)) {
                for (String line; (line = r.readLine()) != null; ) {
                    Log.i(TAG, line);
                    w.println(line);
                    synchronized (tail) {
                        tail.addLast(line);
                        if (tail.size() > 5) tail.removeFirst();
                    }
                }
            } catch (IOException ignored) {
                // 进程结束
            }
        }, "server-log");
        t.setDaemon(true);
        t.start();
    }

    private String lastOutput() {
        synchronized (tail) {
            return tail.isEmpty() ? "无输出" : String.join(" / ", tail);
        }
    }
}
