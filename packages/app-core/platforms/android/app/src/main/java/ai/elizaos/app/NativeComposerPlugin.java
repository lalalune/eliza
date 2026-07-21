/**
 * Persists Android native-composer operations across WebView cold starts and
 * mirrors validated renderer events for app-owned native surfaces.
 */

package ai.elizaos.app;

import android.content.Context;
import android.content.SharedPreferences;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

import org.json.JSONException;

/**
 * Android host for the versioned native-composer operation/event log. External
 * activities enqueue operations before the WebView exists; the renderer drains
 * them after boot and publishes state events back into app-private preferences
 * so Android surfaces can inspect the latest acknowledged draft/send state.
 */
@CapacitorPlugin(name = "NativeComposer")
public class NativeComposerPlugin extends Plugin {
    private static final String SCHEMA = "eliza.native-composer/v1";
    private static final String PREFS = "eliza-native-composer-events";
    private static final String QUEUE_KEY = "pendingOperations";
    private static final Object QUEUE_LOCK = new Object();
    private static final Set<String> EVENT_TYPES = new HashSet<>(Arrays.asList(
        "draft.changed",
        "send.result",
        "focus.changed",
        "voice.state"
    ));
    private static NativeComposerPlugin activePlugin;

    @Override
    public void load() {
        super.load();
        activePlugin = this;
    }

    public static void enqueueOperations(Context context, List<JSObject> operations) {
        if (operations.isEmpty()) return;
        synchronized (QUEUE_LOCK) {
            List<JSObject> queued = readQueue(context);
            queued.addAll(operations);
            writeQueue(context, queued);
        }
        NativeComposerPlugin plugin = activePlugin;
        if (plugin != null) {
            plugin.notifyListeners("operationStream", envelope(operations));
        }
    }

    @PluginMethod
    public void drainOperations(PluginCall call) {
        try {
            List<JSObject> drained;
            synchronized (QUEUE_LOCK) {
                drained = readQueue(getContext());
                getPreferences(getContext()).edit().remove(QUEUE_KEY).commit();
            }
            call.resolve(envelope(drained));
        } catch (IllegalStateException error) {
            call.reject("Could not drain native composer operations", error);
        }
    }

    @PluginMethod
    public void publishEvent(PluginCall call) {
        if (!SCHEMA.equals(call.getString("schema"))) {
            call.reject("Unsupported native composer schema");
            return;
        }
        JSObject event = call.getObject("event");
        if (event == null || !EVENT_TYPES.contains(event.getString("type"))) {
            call.reject("Native composer event requires a type");
            return;
        }
        SharedPreferences preferences = getContext().getSharedPreferences(
            PREFS,
            Context.MODE_PRIVATE
        );
        preferences.edit()
            .putString(event.getString("type"), event.toString())
            .apply();
        call.resolve();
    }

    private static JSObject envelope(List<JSObject> operations) {
        JSArray values = new JSArray();
        for (JSObject operation : operations) values.put(operation);
        JSObject envelope = new JSObject();
        envelope.put("schema", SCHEMA);
        envelope.put("operations", values);
        return envelope;
    }

    private static SharedPreferences getPreferences(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static List<JSObject> readQueue(Context context) {
        String serialized = getPreferences(context).getString(QUEUE_KEY, null);
        List<JSObject> operations = new ArrayList<>();
        if (serialized == null) return operations;
        try {
            JSArray values = new JSArray(serialized);
            for (int index = 0; index < values.length(); index++) {
                operations.add(JSObject.fromJSONObject(values.getJSONObject(index)));
            }
            return operations;
        } catch (JSONException error) {
            throw new IllegalStateException("Native composer operation queue is corrupt", error);
        }
    }

    private static void writeQueue(Context context, List<JSObject> operations) {
        JSArray values = new JSArray();
        for (JSObject operation : operations) values.put(operation);
        boolean committed = getPreferences(context)
            .edit()
            .putString(QUEUE_KEY, values.toString())
            .commit();
        if (!committed) {
            throw new IllegalStateException("Could not persist native composer operation queue");
        }
    }
}
