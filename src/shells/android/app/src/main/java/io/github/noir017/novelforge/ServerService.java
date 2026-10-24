package io.github.noir017.novelforge;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

/**
 * 本机模式的前台服务：只为挂一条常驻通知。写一章要跑几分钟，切到别的 app 时系统会把后台 app 连同它起的 node
 * 一起冻住（Android 11+ 的 cached apps freezer），模型的流断在半路；有前台服务的 app 不算后台，node 接着跑。
 * node 进程本身归 {@link LocalServer} 管，这里不碰它，只在作者把 app 从最近任务里划掉时一起收掉。
 */
public class ServerService extends Service {
    private static final String CHANNEL = "server";
    private static final int NOTIFICATION_ID = 1;

    static void start(Context ctx) {
        ctx.startForegroundService(new Intent(ctx, ServerService.class));
    }

    static void stop(Context ctx) {
        ctx.stopService(new Intent(ctx, ServerService.class));
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        NotificationManager nm = getSystemService(NotificationManager.class);
        nm.createNotificationChannel(new NotificationChannel(CHANNEL, "本机服务", NotificationManager.IMPORTANCE_LOW));
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class),
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification n = new Notification.Builder(this, CHANNEL)
                .setSmallIcon(android.R.drawable.ic_menu_edit)
                .setContentTitle("Novel Forge 本机服务在运行")
                .setContentText("切到别的 app 时，正在写的章节不会断")
                .setContentIntent(open)
                .setOngoing(true)
                .build();
        if (Build.VERSION.SDK_INT >= 34) startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        else startForeground(NOTIFICATION_ID, n);
        // 被系统杀了不自己重启：服务端由 Activity 起，重启的服务手里没有它
        return START_NOT_STICKY;
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        MainActivity.shutdownServer();
        stopSelf();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
