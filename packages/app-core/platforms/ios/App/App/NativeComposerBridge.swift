/**
 * Persists iOS native-composer operations across WebView cold starts and mirrors
 * validated renderer events into the shared App Group for native extensions.
 */

import Capacitor
import Foundation

/// iOS host for `eliza.native-composer/v1`. App Intents enqueue operations
/// before the WebView is ready; the renderer drains them and publishes its
/// acknowledged draft/send events into the shared App Group for extensions.
@objc(NativeComposerPlugin)
public class NativeComposerPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NativeComposerPlugin"
    public let jsName = "NativeComposer"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "drainOperations", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "acknowledgeOperation", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "publishEvent", returnType: CAPPluginReturnPromise),
    ]

    private static let schema = "eliza.native-composer/v1"
    private static let queueLock = NSLock()
    private static let queueKey = "nativeComposer.pendingOperations"
    private static let eventTypes: Set<String> = [
        "draft.changed",
        "send.result",
        "focus.changed",
        "voice.state",
    ]
    private static weak var activePlugin: NativeComposerPlugin?

    public override func load() {
        super.load()
        Self.activePlugin = self
    }

    static func enqueue(_ operations: [[String: Any]]) throws {
        guard !operations.isEmpty else { return }
        let deliveries = operations.map { operation in
            ["deliveryId": UUID().uuidString, "operation": operation] as [String: Any]
        }
        do {
            queueLock.lock()
            defer { queueLock.unlock() }
            var queuedOperations = try readQueuedOperations()
            queuedOperations.append(contentsOf: deliveries)
            try writeQueuedOperations(queuedOperations)
        }
        activePlugin?.notifyListeners(
            "operationStream",
            data: ["schema": schema, "operations": deliveries]
        )
    }

    @objc public func drainOperations(_ call: CAPPluginCall) {
        do {
            let operations: [[String: Any]]
            do {
                Self.queueLock.lock()
                defer { Self.queueLock.unlock() }
                operations = try Self.readQueuedOperations()
            }
            call.resolve(["schema": Self.schema, "operations": operations])
        } catch {
            call.reject("Could not drain native composer operations: \(error.localizedDescription)")
        }
    }

    @objc public func acknowledgeOperation(_ call: CAPPluginCall) {
        guard call.getString("schema") == Self.schema else {
            call.reject("Unsupported native composer schema")
            return
        }
        guard
            let acknowledgment = call.getObject("acknowledgment"),
            let deliveryId = acknowledgment["deliveryId"] as? String,
            !deliveryId.isEmpty,
            let disposition = acknowledgment["disposition"] as? String,
            disposition == "persisted" || disposition == "rejected",
            let resultStatus = acknowledgment["resultStatus"] as? String,
            !resultStatus.isEmpty
        else {
            call.reject("Native composer acknowledgment is invalid")
            return
        }
        do {
            let removed: Bool
            do {
                Self.queueLock.lock()
                defer { Self.queueLock.unlock() }
                var operations = try Self.readQueuedOperations()
                let before = operations.count
                operations.removeAll { operation in
                    operation["deliveryId"] as? String == deliveryId
                }
                removed = operations.count != before
                if removed {
                    if operations.isEmpty {
                        Self.sharedDefaults.removeObject(forKey: Self.queueKey)
                    } else {
                        try Self.writeQueuedOperations(operations)
                    }
                }
            }
            call.resolve(["removed": removed])
        } catch {
            call.reject("Could not acknowledge native composer operation: \(error.localizedDescription)")
        }
    }

    @objc public func publishEvent(_ call: CAPPluginCall) {
        guard call.getString("schema") == Self.schema else {
            call.reject("Unsupported native composer schema")
            return
        }
        guard
            let event = call.getObject("event"),
            let type = event["type"] as? String,
            Self.eventTypes.contains(type)
        else {
            call.reject("Native composer event requires a type")
            return
        }
        guard JSONSerialization.isValidJSONObject(event) else {
            call.reject("Native composer event is not JSON serializable")
            return
        }
        do {
            let data = try JSONSerialization.data(withJSONObject: event)
            Self.sharedDefaults.set(data, forKey: "nativeComposer.event.\(type)")
            call.resolve()
        } catch {
            call.reject("Could not persist native composer event: \(error.localizedDescription)")
        }
    }

    private static var sharedDefaults: UserDefaults {
        let bundleId = Bundle.main.bundleIdentifier ?? "ai.elizaos.app"
        let suffix = bundleId.hasSuffix(".App") ? String(bundleId.dropLast(4)) : bundleId
        return UserDefaults(suiteName: "group.\(suffix)") ?? .standard
    }

    private static func readQueuedOperations() throws -> [[String: Any]] {
        guard let data = sharedDefaults.data(forKey: queueKey) else { return [] }
        let value = try JSONSerialization.jsonObject(with: data)
        guard let operations = value as? [[String: Any]] else {
            throw NSError(
                domain: "NativeComposerPlugin",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "native composer operation queue is corrupt"]
            )
        }
        var changed = false
        let deliveries = operations.map { operation -> [String: Any] in
            if
                let deliveryId = operation["deliveryId"] as? String,
                !deliveryId.isEmpty,
                operation["operation"] != nil
            {
                return operation
            }
            changed = true
            return ["deliveryId": UUID().uuidString, "operation": operation]
        }
        if changed {
            try writeQueuedOperations(deliveries)
        }
        return deliveries
    }

    private static func writeQueuedOperations(_ operations: [[String: Any]]) throws {
        guard JSONSerialization.isValidJSONObject(operations) else {
            throw NSError(
                domain: "NativeComposerPlugin",
                code: 2,
                userInfo: [NSLocalizedDescriptionKey: "native composer operations are not JSON serializable"]
            )
        }
        let data = try JSONSerialization.data(withJSONObject: operations)
        sharedDefaults.set(data, forKey: queueKey)
    }
}
