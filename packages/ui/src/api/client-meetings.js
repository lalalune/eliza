/**
 * Meeting-bot API client methods (#11856) — request / list / get / stop over
 * `/api/meetings`. Declaration-merged onto `ElizaClient` (the side-effect
 * import in `client.ts` installs the prototype methods), matching
 * `client-transcripts.ts` and the other `client-*` domain modules.
 *
 * Also exports the runtime guards that narrow the untyped agent-WebSocket
 * envelope (`onWsEvent` hands the UI `Record<string, unknown>`) into the
 * shared `MeetingWsEvent` shapes.
 */
import { ElizaClient } from "./client-base";
ElizaClient.prototype.requestMeetingBot = async function (input) {
    return this.fetch("/api/meetings", {
        method: "POST",
        body: JSON.stringify(input),
    });
};
ElizaClient.prototype.listMeetings = async function (options) {
    const q = options?.active ? "?active=1" : "";
    return this.fetch(`/api/meetings${q}`);
};
ElizaClient.prototype.getMeeting = async function (id) {
    return this.fetch(`/api/meetings/${encodeURIComponent(id)}`);
};
ElizaClient.prototype.stopMeeting = async function (id) {
    return this.fetch(`/api/meetings/${encodeURIComponent(id)}`, {
        method: "DELETE",
    });
};
function isSegmentArray(value) {
    return (Array.isArray(value) &&
        value.every((s) => typeof s === "object" &&
            s !== null &&
            typeof s.id === "string" &&
            typeof s.text === "string"));
}
/** Narrow a ws envelope into a live-transcript event, or null when malformed. */
export function parseMeetingTranscriptEvent(data) {
    if (data.type !== "meeting-transcript" ||
        typeof data.sessionId !== "string" ||
        typeof data.transcriptId !== "string" ||
        !isSegmentArray(data.confirmed) ||
        !isSegmentArray(data.pending)) {
        return null;
    }
    return {
        type: "meeting-transcript",
        sessionId: data.sessionId,
        transcriptId: data.transcriptId,
        confirmed: data.confirmed,
        pending: data.pending,
    };
}
/** Narrow a ws envelope into a session-status event, or null when malformed. */
export function parseMeetingStatusEvent(data) {
    if (data.type !== "meeting-status")
        return null;
    const session = data.session;
    if (typeof session !== "object" ||
        session === null ||
        typeof session.id === "undefined") {
        return null;
    }
    return { type: "meeting-status", session: session };
}
