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
import java.util.UUID;

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
        List<JSObject> deliveries = wrapDeliveries(operations);
        synchronized (QUEUE_LOCK) {
            List<JSObject> queued = readQueue(context);
            queued.addAll(deliveries);
            writeQueue(context, queued);
        }
        NativeComposerPlugin plugin = activePlugin;
        if (plugin != null) {
            plugin.notifyListeners("operationStream", envelope(deliveries));
        }
    }

    @PluginMethod
    public void drainOperations(PluginCall call) {
        try {
            List<JSObject> drained;
            synchronized (QUEUE_LOCK) {
                drained = readQueue(getContext());
            }
            call.resolve(envelope(drained));
        } catch (IllegalStateException error) {
            call.reject("Could not drain native composer operations", error);
        }
    }

    @PluginMethod
    public void acknowledgeOperation(PluginCall call) {
        if (!SCHEMA.equals(call.getString("schema"))) {
            call.reject("Unsupported native composer schema");
            return;
        }
        JSObject acknowledgment = call.getObject("acknowledgment");
        String deliveryId = acknowledgment == null ? null : acknowledgment.getString("deliveryId");
        String disposition = acknowledgment == null ? null : acknowledgment.getString("disposition");
        String resultStatus = acknowledgment == null ? null : acknowledgment.getString("resultStatus");
        if (
            deliveryId == null || deliveryId.isEmpty() ||
            (!"persisted".equals(disposition) && !"rejected".equals(disposition)) ||
            resultStatus == null || resultStatus.isEmpty()
        ) {
            call.reject("Native composer acknowledgment is invalid");
            return;
        }
        try {
            boolean removed;
            synchronized (QUEUE_LOCK) {
                List<JSObject> queued = readQueue(getContext());
                int before = queued.size();
                queued.removeIf(delivery -> deliveryId.equals(delivery.getString("deliveryId")));
                removed = queued.size() != before;
                if (removed) {
                    boolean committed = queued.isEmpty()
                        ? getPreferences(getContext()).edit().remove(QUEUE_KEY).commit()
                        : commitQueue(getContext(), queued);
                    if (!committed) {
                        throw new IllegalStateException("Could not persist native composer acknowledgment");
                    }
                }
            }
            JSObject result = new JSObject();
            result.put("removed", removed);
            call.resolve(result);
        } catch (IllegalStateException error) {
            call.reject("Could not acknowledge native composer operation", error);
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

    private static List<JSObject> wrapDeliveries(List<JSObject> operations) {
        List<JSObject> deliveries = new ArrayList<>();
        for (JSObject operation : operations) {
            JSObject delivery = new JSObject();
            delivery.put("deliveryId", UUID.randomUUID().toString());
            delivery.put("operation", operation);
            deliveries.add(delivery);
        }
        return deliveries;
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
            boolean changed = false;
            for (int index = 0; index < values.length(); index++) {
                JSObject value = JSObject.fromJSONObject(values.getJSONObject(index));
                if (
                    value.getString("deliveryId") != null &&
                    !value.getString("deliveryId").isEmpty() &&
                    value.has("operation")
                ) {
                    operations.add(value);
                } else {
                    operations.add(wrapDeliveries(Arrays.asList(value)).get(0));
                    changed = true;
                }
            }
            if (changed) writeQueue(context, operations);
            return operations;
        } catch (JSONException error) {
            throw new IllegalStateException("Native composer operation queue is corrupt", error);
        }
    }

    private static void writeQueue(Context context, List<JSObject> operations) {
        if (!commitQueue(context, operations)) {
            throw new IllegalStateException("Could not persist native composer operation queue");
        }
    }

    private static boolean commitQueue(Context context, List<JSObject> operations) {
        JSArray values = new JSArray();
        for (JSObject operation : operations) values.put(operation);
        return getPreferences(context)
            .edit()
            .putString(QUEUE_KEY, values.toString())
            .commit();
    }
}
