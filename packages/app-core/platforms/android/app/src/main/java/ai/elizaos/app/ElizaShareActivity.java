/**
 * Receives Android share-sheet and Process Text intents, stages their content
 * as reviewable native-composer operations, and opens the main chat activity.
 */

package ai.elizaos.app;

import android.app.Activity;
import android.content.ClipData;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.provider.OpenableColumns;
import android.text.TextUtils;
import android.util.Base64;
import android.util.Log;
import android.widget.Toast;

import com.getcapacitor.JSObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.Arrays;
import java.util.List;
import java.util.Set;
import java.util.UUID;

public class ElizaShareActivity extends Activity {
    private static final String TAG = "ElizaShareActivity";
    private static final int MAX_ATTACHMENTS = 4;
    private static final int MAX_IMAGE_BYTES = 3_932_160;
    private static final int MAX_MEDIA_BYTES = 11_796_480;
    private static final Set<String> IMAGE_MIME_TYPES = new HashSet<>(Arrays.asList(
        "image/jpeg", "image/png", "image/gif", "image/webp"
    ));
    private static final Set<String> UPLOAD_MIME_TYPES = new HashSet<>(Arrays.asList(
        "image/jpeg", "image/png", "image/gif", "image/webp",
        "audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/wave",
        "audio/ogg", "audio/webm", "audio/mp4", "audio/aac", "audio/flac",
        "video/mp4", "video/webm", "video/quicktime", "video/ogg",
        "application/pdf", "text/plain", "text/csv", "text/markdown", "application/json"
    ));

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        Intent source = getIntent();
        String launchId = UUID.randomUUID().toString();
        try {
            NativeComposerPlugin.enqueueOperations(this, buildComposerOperations(source, launchId));
        } catch (IllegalStateException error) {
            // error-policy:J4 the deep-link fallback still opens a reviewable
            // text draft, while the user sees that attachments were unavailable.
            Log.e(TAG, "Could not persist native composer operations", error);
            Toast.makeText(this, "Eliza could not attach the shared files.", Toast.LENGTH_LONG).show();
        }
        Uri route = buildRoute(source, launchId);

        Intent launch = new Intent(this, MainActivity.class);
        launch.setAction(Intent.ACTION_VIEW);
        launch.setData(route);
        launch.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        copySharedContentGrant(source, launch);
        startActivity(launch);
        finish();
    }

    private static Uri buildRoute(Intent source, String launchId) {
        String sourceTag = resolveSourceTag(source);
        Uri.Builder route = Uri.parse("elizaos://chat")
                .buildUpon()
                .appendQueryParameter("source", sourceTag)
                .appendQueryParameter("action", "smart-reply")
                .appendQueryParameter("assistant.launchId", launchId);

        String text = extractText(source);
        if (!TextUtils.isEmpty(text)) {
            route.appendQueryParameter("text", text);
        }

        if (source != null) {
            String subject = source.getStringExtra(Intent.EXTRA_SUBJECT);
            if (!TextUtils.isEmpty(subject)) {
                route.appendQueryParameter("subject", subject);
            }
            String mimeType = source.getType();
            if (!TextUtils.isEmpty(mimeType)) {
                route.appendQueryParameter("mimeType", mimeType);
            }
            if (Intent.ACTION_PROCESS_TEXT.equals(source.getAction())) {
                route.appendQueryParameter(
                        "readonly",
                        String.valueOf(
                                source.getBooleanExtra(Intent.EXTRA_PROCESS_TEXT_READONLY, true)));
            }
            if (hasSharedStream(source)) {
                route.appendQueryParameter("attachment", "1");
            }
        }

        return route.build();
    }

    private List<JSObject> buildComposerOperations(Intent source, String launchId) {
        List<JSObject> operations = new ArrayList<>();
        String text = extractText(source);
        if (!TextUtils.isEmpty(text)) {
            JSObject textOperation = operation("text.set", launchId + ":text");
            textOperation.put("text", text);
            operations.add(textOperation);
        }

        List<Uri> streams = sharedStreams(source);
        if (streams.size() > MAX_ATTACHMENTS) {
            Toast.makeText(
                this,
                "Eliza accepts up to " + MAX_ATTACHMENTS + " attachments per message.",
                Toast.LENGTH_LONG
            ).show();
            streams = streams.subList(0, MAX_ATTACHMENTS);
        }
        for (int index = 0; index < streams.size(); index++) {
            Uri stream = streams.get(index);
            try {
                String mimeType = getContentResolver().getType(stream);
                if (TextUtils.isEmpty(mimeType) && source != null) {
                    mimeType = source.getType();
                }
                if (TextUtils.isEmpty(mimeType) || !UPLOAD_MIME_TYPES.contains(mimeType)) {
                    throw new IOException("Shared attachment has an unsupported MIME type");
                }
                int byteCap = IMAGE_MIME_TYPES.contains(mimeType)
                    ? MAX_IMAGE_BYTES
                    : MAX_MEDIA_BYTES;
                byte[] bytes = readCapped(stream, byteCap);
                String attachmentId = launchId + ":attachment:" + index;
                JSObject attachment = new JSObject();
                attachment.put("source", "inline");
                attachment.put("mimeType", mimeType);
                attachment.put("bytesBase64", Base64.encodeToString(bytes, Base64.NO_WRAP));
                attachment.put("name", resolveDisplayName(stream, index));
                JSObject add = operation("attachment.add", attachmentId + ":add");
                add.put("attachmentId", attachmentId);
                add.put("attachment", attachment);
                operations.add(add);
            } catch (IOException | SecurityException error) {
                // error-policy:J4 the selected item is individually unavailable;
                // other shared items and text still reach the reviewable draft.
                Log.w(TAG, "Could not read shared attachment " + stream, error);
                Toast.makeText(
                    this,
                    "Eliza could not attach " + resolveDisplayName(stream, index) + ".",
                    Toast.LENGTH_LONG
                ).show();
            }
        }

        JSObject focus = operation("focus.set", launchId + ":focus");
        focus.put("focused", true);
        focus.put("keyboard", "shown");
        operations.add(focus);
        return operations;
    }

    private static JSObject operation(String type, String opId) {
        JSObject operation = new JSObject();
        operation.put("type", type);
        operation.put("opId", opId);
        operation.put("at", System.currentTimeMillis());
        return operation;
    }

    private List<Uri> sharedStreams(Intent source) {
        List<Uri> streams = new ArrayList<>();
        if (source == null) return streams;
        Set<String> seen = new HashSet<>();
        Uri single = source.getParcelableExtra(Intent.EXTRA_STREAM);
        if (single != null && seen.add(single.toString())) streams.add(single);
        ArrayList<Uri> multiple = source.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
        if (multiple != null) {
            for (Uri stream : multiple) {
                if (stream != null && seen.add(stream.toString())) streams.add(stream);
            }
        }
        ClipData clipData = source.getClipData();
        if (clipData != null) {
            for (int index = 0; index < clipData.getItemCount(); index++) {
                Uri stream = clipData.getItemAt(index).getUri();
                if (stream != null && seen.add(stream.toString())) streams.add(stream);
            }
        }
        return streams;
    }

    private byte[] readCapped(Uri stream, int byteCap) throws IOException {
        try (InputStream input = getContentResolver().openInputStream(stream)) {
            if (input == null) throw new IOException("Content resolver returned no stream");
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            byte[] chunk = new byte[16 * 1024];
            int total = 0;
            int read;
            while ((read = input.read(chunk)) != -1) {
                total += read;
                if (total > byteCap) {
                    throw new IOException("Shared attachment exceeds chat upload limit");
                }
                output.write(chunk, 0, read);
            }
            if (total == 0) throw new IOException("Shared attachment is empty");
            return output.toByteArray();
        }
    }

    private String resolveDisplayName(Uri stream, int index) {
        try (android.database.Cursor cursor = getContentResolver().query(
            stream,
            new String[]{OpenableColumns.DISPLAY_NAME},
            null,
            null,
            null
        )) {
            if (cursor != null && cursor.moveToFirst()) {
                int column = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (column >= 0) {
                    String name = cursor.getString(column);
                    if (!TextUtils.isEmpty(name)) return cappedName(name);
                }
            }
        } catch (SecurityException error) {
            // error-policy:J4 display metadata is optional; URI bytes remain
            // authoritative and a deterministic name keeps the item sendable.
            Log.w(TAG, "Could not read shared attachment display name", error);
        }
        String last = stream.getLastPathSegment();
        String name = TextUtils.isEmpty(last) ? "attachment-" + index : last;
        return cappedName(name);
    }

    private static String cappedName(String name) {
        return name.length() <= 255 ? name : name.substring(0, 255);
    }

    private static String resolveSourceTag(Intent source) {
        if (source == null) {
            return "android-share-sheet";
        }
        String action = source.getAction();
        if (Intent.ACTION_PROCESS_TEXT.equals(action)) {
            return "android-process-text";
        }
        if (Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            return "android-share-sheet-multiple";
        }
        return "android-share-sheet";
    }

    private static String extractText(Intent source) {
        if (source == null) {
            return null;
        }

        CharSequence processText = source.getCharSequenceExtra(Intent.EXTRA_PROCESS_TEXT);
        if (!TextUtils.isEmpty(processText)) {
            return processText.toString();
        }

        CharSequence extraText = source.getCharSequenceExtra(Intent.EXTRA_TEXT);
        if (!TextUtils.isEmpty(extraText)) {
            return extraText.toString();
        }

        return null;
    }

    private static void copySharedContentGrant(Intent source, Intent launch) {
        if (source == null) {
            return;
        }
        ClipData clipData = source.getClipData();
        if (clipData != null) {
            launch.setClipData(clipData);
            launch.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        }

        Uri stream = source.getParcelableExtra(Intent.EXTRA_STREAM);
        if (stream != null) {
            launch.putExtra(Intent.EXTRA_STREAM, stream);
            launch.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            return;
        }

        ArrayList<Uri> streams = source.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
        if (streams != null && !streams.isEmpty()) {
            launch.putParcelableArrayListExtra(Intent.EXTRA_STREAM, streams);
            launch.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        }
    }

    private static boolean hasSharedStream(Intent source) {
        if (source == null) {
            return false;
        }
        Uri stream = source.getParcelableExtra(Intent.EXTRA_STREAM);
        if (stream != null) {
            return true;
        }
        ArrayList<Uri> streams = source.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
        return streams != null && !streams.isEmpty();
    }
}
