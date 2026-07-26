package ai.elizaos.app;

import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.webkit.WebSettings;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

import ai.elizaos.app.BuildConfig;

import java.lang.reflect.Method;

public class MainActivity extends BridgeActivity {

    private static final String TAG = "ElizaMainActivity";

    private static final class UserAgentMarker {
        final String systemProp;
        final String uaPrefix;

        UserAgentMarker(String systemProp, String uaPrefix) {
            this.systemProp = systemProp;
            this.uaPrefix = uaPrefix;
        }
    }

    private static final UserAgentMarker[] BRAND_USER_AGENT_MARKERS = new UserAgentMarker[] {
        new UserAgentMarker("ro.elizaos.product", "ElizaOS/"),
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        if (BuildConfig.DEBUG) {
            WebView.setWebContentsDebuggingEnabled(true);
        }

        // Cloud builds keep the native glass tier: GlassBridgePlugin has no
        // local-agent dependencies (android.* + Capacitor only).
        registerPlugin(GlassBridgePlugin.class);

        super.onCreate(savedInstanceState);

        if (getBridge() != null) {
            getBridge().registerPlugin(SafePushNotificationsPlugin.class);
        }

        if (getBridge() != null && getBridge().getWebView() != null) {
            WebSettings settings = getBridge().getWebView().getSettings();
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
            applyBrandUserAgentMarkers(settings);
        }
    }

    @Override
    public void onStop() {
        super.onStop();
        if (!isFinishing()) {
            GatewayConnectionService.start(this);
        }
    }

    @Override
    public void onDestroy() {
        if (isFinishing()) {
            GatewayConnectionService.stop(this);
        }
        super.onDestroy();
    }

    private void applyBrandUserAgentMarkers(WebSettings settings) {
        StringBuilder newUa = null;
        String currentUa = settings.getUserAgentString();
        for (UserAgentMarker marker : BRAND_USER_AGENT_MARKERS) {
            if (marker.systemProp == null || marker.systemProp.isEmpty()) {
                continue;
            }
            String tag = readSystemProperty(marker.systemProp);
            if (tag == null || tag.isEmpty()) {
                continue;
            }
            String token = marker.uaPrefix + tag;
            if (currentUa != null && currentUa.contains(token)) {
                continue;
            }
            if (newUa == null) {
                newUa = new StringBuilder(currentUa == null ? "" : currentUa);
            }
            if (newUa.length() > 0) {
                newUa.append(" ");
            }
            newUa.append(token);
        }
        if (newUa != null) {
            settings.setUserAgentString(newUa.toString());
        }
    }

    private static String readSystemProperty(String key) {
        try {
            Class<?> spClass = Class.forName("android.os.SystemProperties");
            Method get = spClass.getMethod("get", String.class);
            Object result = get.invoke(null, key);
            return result instanceof String ? (String) result : "";
        } catch (ReflectiveOperationException | SecurityException e) {
            Log.w(TAG, "SystemProperties.get failed for " + key, e);
            return "";
        }
    }
}
