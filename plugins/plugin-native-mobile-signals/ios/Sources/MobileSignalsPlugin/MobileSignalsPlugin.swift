/**
 * Capacitor bridge for iOS device-state and HealthKit snapshots.
 *
 * Monitoring callbacks carry an ownership generation so HealthKit completions
 * from a stopped renderer cannot publish into its successor. Listener teardown
 * closes and drains publication before releasing Capacitor callback ownership.
 */
import Foundation
import Capacitor
import HealthKit
import UIKit
import UserNotifications

@objc(MobileSignalsPlugin)
public class MobileSignalsPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "MobileSignalsPlugin"
    public let jsName = "MobileSignals"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "checkPermissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestPermissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openSettings", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startMonitoring", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopMonitoring", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "releaseSignalListeners", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getSnapshot", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "scheduleBackgroundRefresh", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancelBackgroundRefresh", returnType: CAPPluginReturnPromise),
    ]

    private struct HealthCapture {
        let source: String
        let screenTime: [String: Any]
        let permissions: [String: Bool]
        let sleep: [String: Any]
        let biometrics: [String: Any]
        let warnings: [String]
    }

    private struct SleepEpisode {
        let startDate: Date
        let endDate: Date
        let durationMinutes: Double
        let latestStageValue: Int
    }

    private var monitoring = false
    private let monitoringGeneration = MonitoringGeneration()
    private let monitoringHealthQueries = MonitoringResourceRegistry<HKQuery>()
    private let listenerCalls = RetryableReleaseRegistry<CAPPluginCall>()
    private let signalListenerLifecycle = SignalListenerLifecycleGate()
    private var observers: [NSObjectProtocol] = []
    private let healthStore = HKHealthStore()
    private let healthQueue = DispatchQueue(label: "ai.eliza.mobile-signals.health", qos: .utility)

    public override func load() {
        UIDevice.current.isBatteryMonitoringEnabled = true
        // Re-arm HealthKit background delivery on every cold boot. Apple's
        // background-delivery registration does NOT persist across uninstalls
        // and re-installations of the app, but it does persist across simple
        // launches — the redundant call is cheap and ensures the foreground
        // requestAuthorization → arm flow isn't the only path that turns it on.
        enableHealthBackgroundDelivery()
    }

    @objc func scheduleBackgroundRefresh(_ call: CAPPluginCall) {
        call.resolve([
            "scheduled": false,
            "reason": "iOS mobile signals use foreground monitoring; background scheduled work is routed through the eliza-tasks BackgroundRunner.",
        ])
    }

    @objc func cancelBackgroundRefresh(_ call: CAPPluginCall) {
        call.resolve([
            "cancelled": true,
            "reason": "iOS mobile signals have no refresh job scheduled through this plugin remaining; app-lifetime HealthKit delivery is outside this job-scoped contract.",
        ])
    }

    deinit {
        stopInternal()
        UIDevice.current.isBatteryMonitoringEnabled = false
    }

    @objc func startMonitoring(_ call: CAPPluginCall) {
        if monitoring {
            call.resolve(buildStartResult())
            return
        }

        let generation = monitoringGeneration.begin()
        monitoringHealthQueries.activate(generation: generation)
        monitoring = true
        registerObservers(generation: generation)
        call.resolve(buildStartResult())

        if call.getBool("emitInitial") ?? true {
            emitSignal(reason: "start", generation: generation)
            emitHealthSignal(reason: "start", generation: generation)
        }
    }

    @objc func stopMonitoring(_ call: CAPPluginCall) {
        stopInternal()
        call.resolve(["stopped": true])
    }

    @objc public override func addListener(_ call: CAPPluginCall) {
        signalListenerLifecycle.closeAndDrain()
        guard signalListenerLifecycle.canAcquireListeners else {
            call.reject(
                "Signal listeners are quarantined until native release succeeds.",
                "MOBILE_SIGNALS_LISTENER_RELEASE_PENDING"
            )
            return
        }
        super.addListener(call)
        listenerCalls.track(call)
        signalListenerLifecycle.resume(hasListeners: hasListeners("signal"))
    }

    @objc public override func removeListener(_ call: CAPPluginCall) {
        signalListenerLifecycle.closeAndDrain()
        let storedCall = call.getString("callbackId").flatMap {
            bridge?.savedCall(withID: $0)
        }
        super.removeListener(call)
        if let storedCall {
            listenerCalls.confirmReleased(storedCall)
        }
        signalListenerLifecycle.resume(hasListeners: hasListeners("signal"))
    }

    @objc public override func removeAllListeners(_ call: CAPPluginCall) {
        let removed = releaseAllSignalListenerOwnership()
        if removed {
            call.resolve()
        } else {
            call.reject(
                "Native signal listener ownership could not be released.",
                "MOBILE_SIGNALS_LISTENER_RELEASE_FAILED"
            )
        }
    }

    @objc func releaseSignalListeners(_ call: CAPPluginCall) {
        call.resolve(["removed": releaseAllSignalListenerOwnership()])
    }

    private func releaseAllSignalListenerOwnership() -> Bool {
        signalListenerLifecycle.closeAndDrain()
        let currentListenerCalls = (eventListeners?.allValues ?? []).flatMap { group in
            (group as? [CAPPluginCall]) ?? []
        }
        currentListenerCalls.forEach(listenerCalls.track)
        do {
            guard try listenerCalls.releaseAll(
                using: bridge.map { activeBridge in
                    { listenerCall in activeBridge.releaseCall(listenerCall) }
                }
            ) else {
                signalListenerLifecycle.finishRelease(succeeded: false)
                return false
            }
            eventListeners?.removeAllObjects()
            signalListenerLifecycle.finishRelease(succeeded: true)
            return true
        } catch {
            // error-policy:J1 Capacitor bridge boundary — retain every
            // unconfirmed callback so renderer cleanup can retry.
            signalListenerLifecycle.finishRelease(succeeded: false)
            return false
        }
    }

    @objc public override func checkPermissions(_ call: CAPPluginCall) {
        buildPermissionResult { result in
            self.settlePermissionCall(call, result: result)
        }
    }

    @objc public override func requestPermissions(_ call: CAPPluginCall) {
        let target = call.getString("target") ?? "all"
        if target == "screenTime" {
            resolvePermissionAfterScreenTimeRequest(call)
            return
        }
        if target == "notifications" {
            requestNotificationPermissions(call)
            return
        }

        let shouldRequestScreenTime = target != "health"
        let types = requestedHealthTypes()
        guard !types.isEmpty else {
            resolvePermissionResult(
                call,
                status: "not-applicable",
                canRequest: false,
                reason: "HealthKit sleep and biometric types are unavailable on this device.",
                requestScreenTime: shouldRequestScreenTime
            )
            return
        }

        healthStore.requestAuthorization(toShare: nil, read: Set(types)) { [weak self] success, error in
            DispatchQueue.main.async {
                guard let self = self else { return }
                guard success else {
                    call.reject(
                        "HealthKit permission request failed.",
                        "MOBILE_SIGNALS_HEALTH_AUTHORIZATION_FAILED",
                        error
                    )
                    return
                }
                self.enableHealthBackgroundDelivery()
                self.resolvePermissionResult(
                    call,
                    requestScreenTime: shouldRequestScreenTime
                )
            }
        }
    }

    /// Turn on `HKHealthStore.enableBackgroundDelivery(for:frequency:)` for
    /// the sleep + biometric sample types we already requested authorization
    /// for. iOS will then wake the app — via the `com.apple.developer.healthkit.background-delivery`
    /// entitlement that ships with `App.entitlements` — whenever HealthKit
    /// has a new sample to deliver. The wake itself does not run our code:
    /// it flips the WebView's app state to background-with-network-OK, which
    /// is what the runtime's `HKObserverQuery` / next pull will pick up.
    ///
    /// `.immediate` is the only honest choice for sleep + heart-rate signals;
    /// HealthKit clamps observation cadence to whatever the underlying sensor
    /// chose, so anything coarser would just delay the wake.
    ///
    /// This method is intentionally fire-and-forget — a failure to enable
    /// background delivery is not user-actionable; the foreground monitoring
    /// path already works. We log and move on.
    ///
    /// Entitlement probe: iOS exposes no public API to read the running
    /// binary's code-signing entitlements, so the first sample type doubles as
    /// the capability probe. When the binary is not signed with
    /// `com.apple.developer.healthkit` (simulator lanes built with code
    /// signing disabled, sideload/dev builds signed without the capability)
    /// EVERY call fails identically with "Missing
    /// com.apple.developer.healthkit entitlement" — so the probe failing that
    /// way means the remaining registrations are skipped behind a single info
    /// line instead of one warning per type.
    private func enableHealthBackgroundDelivery() {
        guard HKHealthStore.isHealthDataAvailable() else { return }
        let sampleTypes = backgroundDeliverySampleTypes()
        guard let probeType = sampleTypes.first else { return }

        healthStore.enableBackgroundDelivery(
            for: probeType,
            frequency: .immediate
        ) { [weak self] success, error in
            guard let self = self else { return }
            let outcome = HealthBackgroundDeliveryGate.probeOutcome(
                success: success,
                errorMessage: error?.localizedDescription
            )
            switch outcome {
            case .entitlementMissing:
                NSLog(
                    "[MobileSignalsPlugin] HealthKit background delivery skipped: binary lacks the com.apple.developer.healthkit entitlement (expected for simulator and non-store dev builds); foreground health monitoring is unaffected"
                )
                return
            case .probeFailed:
                Self.logBackgroundDeliveryFailure(probeType, error)
            case .succeeded:
                break
            }
            for sampleType in sampleTypes.dropFirst() {
                self.healthStore.enableBackgroundDelivery(
                    for: sampleType,
                    frequency: .immediate
                ) { ok, err in
                    if !ok {
                        Self.logBackgroundDeliveryFailure(sampleType, err)
                    }
                }
            }
        }
    }

    /// Sleep + biometric sample types eligible for background delivery, in
    /// probe order (the first entry is the entitlement probe).
    private func backgroundDeliverySampleTypes() -> [HKSampleType] {
        var sampleTypes: [HKSampleType] = []
        if let sleepType = HKObjectType.categoryType(forIdentifier: .sleepAnalysis) {
            sampleTypes.append(sleepType)
        }
        for identifier in [
            HKQuantityTypeIdentifier.heartRate,
            HKQuantityTypeIdentifier.restingHeartRate,
            HKQuantityTypeIdentifier.heartRateVariabilitySDNN,
            HKQuantityTypeIdentifier.respiratoryRate,
            HKQuantityTypeIdentifier.oxygenSaturation,
        ] {
            if let qt = HKObjectType.quantityType(forIdentifier: identifier) {
                sampleTypes.append(qt)
            }
        }
        return sampleTypes
    }

    private static func logBackgroundDeliveryFailure(
        _ sampleType: HKSampleType,
        _ error: Error?
    ) {
        NSLog(
            "[MobileSignalsPlugin] enableBackgroundDelivery(%@) failed: %@",
            sampleType.identifier,
            error?.localizedDescription ?? "unknown"
        )
    }

    private func requestNotificationPermissions(_ call: CAPPluginCall) {
        readNotificationPermission { [weak self] notification in
            guard let self = self else { return }
            guard notification.canRequest else {
                self.buildPermissionResult(reason: notification.reason) { result in
                    self.settlePermissionCall(call, result: result)
                }
                return
            }

            UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { [weak self] _, error in
                DispatchQueue.main.async {
                    guard let self = self else { return }
                    if let error {
                        call.reject(
                            "Notification permission request failed.",
                            "MOBILE_SIGNALS_NOTIFICATION_AUTHORIZATION_FAILED",
                            error
                        )
                        return
                    }
                    self.buildPermissionResult { result in
                        self.settlePermissionCall(call, result: result)
                    }
                }
            }
        }
    }

    @objc func openSettings(_ call: CAPPluginCall) {
        let target = call.getString("target") ?? "app"
        let reason: String?
        let actualTarget: String
        let urlString: String

        if target == "notification", #available(iOS 16.0, *) {
            actualTarget = "notification"
            urlString = UIApplication.openNotificationSettingsURLString
            reason = nil
        } else {
            actualTarget = "app"
            urlString = UIApplication.openSettingsURLString
            reason = target == "app" || target == "health" || target == "localNetwork"
                ? nil
                : "iOS only supports stable public deep links to this app's Settings screen."
        }

        guard let url = URL(string: urlString) else {
            call.resolve([
                "opened": false,
                "target": target,
                "actualTarget": actualTarget,
                "reason": "Unable to build iOS settings URL.",
            ])
            return
        }

        DispatchQueue.main.async {
            UIApplication.shared.open(url, options: [:]) { opened in
                let resolvedReason: Any
                if opened {
                    if let reason {
                        resolvedReason = reason
                    } else {
                        resolvedReason = NSNull()
                    }
                } else {
                    resolvedReason = "iOS declined to open Settings."
                }
                call.resolve([
                    "opened": opened,
                    "target": target,
                    "actualTarget": actualTarget,
                    "reason": resolvedReason,
                ])
            }
        }
    }

    @objc func getSnapshot(_ call: CAPPluginCall) {
        let device = buildSnapshot(reason: "snapshot")
        // Renderer health polls belong to the active monitor generation. A
        // concurrent stop can then cancel their native queries and settle this
        // bridge call instead of leaving renderer teardown pinned indefinitely.
        buildHealthSnapshot(
            reason: "snapshot",
            monitoringGeneration: monitoringHealthQueries.currentGeneration
        ) { health in
            call.resolve([
                "supported": true,
                "snapshot": device,
                "healthSnapshot": health,
            ])
        }
    }

    private func registerObservers(generation: UInt64) {
        let center = NotificationCenter.default
        let names: [Notification.Name] = [
            UIApplication.didBecomeActiveNotification,
            UIApplication.willResignActiveNotification,
            UIApplication.didEnterBackgroundNotification,
            UIApplication.willEnterForegroundNotification,
            UIApplication.protectedDataDidBecomeAvailableNotification,
            UIApplication.protectedDataWillBecomeUnavailableNotification,
            Notification.Name.NSProcessInfoPowerStateDidChange,
            UIDevice.batteryStateDidChangeNotification,
        ]

        for name in names {
            let observer = center.addObserver(
                forName: name,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                self?.emitSignal(
                    reason: name.rawValue,
                    generation: generation
                )
                if name == UIApplication.didBecomeActiveNotification ||
                    name == UIApplication.willEnterForegroundNotification ||
                    name == UIApplication.protectedDataDidBecomeAvailableNotification {
                    self?.emitHealthSignal(
                        reason: name.rawValue,
                        generation: generation
                    )
                }
            }
            observers.append(observer)
        }
    }

    private func stopInternal() {
        let center = NotificationCenter.default
        for observer in observers {
            center.removeObserver(observer)
        }
        observers.removeAll()
        monitoring = false
        monitoringGeneration.invalidate()
        let ownedQueries = monitoringHealthQueries.invalidate()
        for entry in ownedQueries {
            healthStore.stop(entry.resource)
            entry.cancelCompletion()
        }
    }

    private func buildStartResult() -> [String: Any] {
        [
            "enabled": monitoring,
            "supported": true,
            "platform": "ios",
            "snapshot": buildSnapshot(reason: "start"),
            "healthSnapshot": NSNull(),
        ]
    }

    private func requestedHealthTypes() -> [HKObjectType] {
        var types: [HKObjectType] = []
        if let sleepType = self.sleepHealthType() {
            types.append(sleepType)
        }
        types.append(contentsOf: biometricHealthTypes())
        return types
    }

    private func sleepHealthType() -> HKObjectType? {
        HKObjectType.categoryType(forIdentifier: .sleepAnalysis)
    }

    private func biometricHealthTypes() -> [HKObjectType] {
        let biometricIdentifiers: [HKQuantityTypeIdentifier] = [
            .heartRate,
            .restingHeartRate,
            .heartRateVariabilitySDNN,
            .respiratoryRate,
            .oxygenSaturation,
        ]
        return biometricIdentifiers.compactMap {
            HKObjectType.quantityType(forIdentifier: $0)
        }
    }

    private struct NotificationPermissionCapture {
        let status: String
        let canRequest: Bool
        let reason: String?
    }

    private func readHealthConsentDecision(
        completion: @escaping (Result<HealthReadConsentDecision, Error>) -> Void
    ) {
        guard HKHealthStore.isHealthDataAvailable() else {
            completion(.success(HealthReadConsentDecision(
                status: "not-applicable",
                canRequest: false,
                reason: "HealthKit is not available on this device."
            )))
            return
        }

        let types = requestedHealthTypes()
        guard !types.isEmpty else {
            completion(.success(HealthReadConsentDecision(
                status: "not-applicable",
                canRequest: false,
                reason: "HealthKit sleep and biometric types are unavailable on this device."
            )))
            return
        }

        healthStore.getRequestStatusForAuthorization(
            toShare: Set<HKSampleType>(),
            read: Set(types)
        ) { requestStatus, error in
            let requestState: HealthReadAuthorizationRequestState
            let failureReason: String?
            if let error {
                requestState = .unknown
                failureReason = "HealthKit request-status lookup failed: \(error.localizedDescription)"
            } else {
                failureReason = nil
                switch requestStatus {
                case .shouldRequest:
                    requestState = .shouldRequest
                case .unnecessary:
                    requestState = .unnecessary
                case .unknown:
                    requestState = .unknown
                @unknown default:
                    requestState = .unknown
                }
            }
            DispatchQueue.main.async {
                completion(Result {
                    try HealthReadConsentPolicy.decide(
                        requestState: requestState,
                        failureReason: failureReason
                    )
                })
            }
        }
    }

    private func readNotificationPermission(
        completion: @escaping (NotificationPermissionCapture) -> Void
    ) {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            let capture: NotificationPermissionCapture
            switch settings.authorizationStatus {
            case .authorized, .provisional, .ephemeral:
                capture = NotificationPermissionCapture(
                    status: "granted",
                    canRequest: false,
                    reason: nil
                )
            case .denied:
                capture = NotificationPermissionCapture(
                    status: "denied",
                    canRequest: false,
                    reason: "Notifications are disabled for Eliza. Open Settings to enable reminders and prompts."
                )
            case .notDetermined:
                capture = NotificationPermissionCapture(
                    status: "not-determined",
                    canRequest: true,
                    reason: "Allow notifications when LifeOps needs to remind or prompt you."
                )
            @unknown default:
                capture = NotificationPermissionCapture(
                    status: "restricted",
                    canRequest: false,
                    reason: "iOS notification authorization is restricted by this device."
                )
            }
            DispatchQueue.main.async {
                completion(capture)
            }
        }
    }

    private func buildPermissionResult(
        status overrideStatus: String? = nil,
        canRequest overrideCanRequest: Bool? = nil,
        reason overrideReason: String? = nil,
        completion: @escaping (Result<[String: Any], Error>) -> Void
    ) {
        readNotificationPermission { [weak self] notification in
            guard let self = self else { return }
            self.readHealthConsentDecision { decision in
                completion(decision.map { healthConsent in
                    self.buildPermissionResultPayload(
                        status: overrideStatus,
                        canRequest: overrideCanRequest,
                        reason: overrideReason,
                        notification: notification,
                        healthConsent: healthConsent
                    )
                })
            }
        }
    }

    private func settlePermissionCall(
        _ call: CAPPluginCall,
        result: Result<[String: Any], Error>
    ) {
        switch result {
        case .success(let payload):
            call.resolve(payload)
        case .failure(let error):
            call.reject(
                "Failed to read mobile signal permissions.",
                "MOBILE_SIGNALS_PERMISSION_CHECK_FAILED",
                error
            )
        }
    }

    private func buildPermissionResultPayload(
        status overrideStatus: String? = nil,
        canRequest overrideCanRequest: Bool? = nil,
        reason overrideReason: String? = nil,
        notification: NotificationPermissionCapture,
        healthConsent: HealthReadConsentDecision
    ) -> [String: Any] {
        let screenTimeStatus = ScreenTimeSupport.buildStatus()
        guard HKHealthStore.isHealthDataAvailable() else {
            return [
                "status": overrideStatus ?? "not-applicable",
                "canRequest": overrideCanRequest ?? false,
                "canOpenSettings": true,
                "settingsTarget": "app",
                "engine": "healthkit-screen-time",
                "capabilities": mobileSignalsCapabilities(),
                "reason": overrideReason ?? "HealthKit is not available on this device.",
                "permissions": [
                    "sleep": false,
                    "biometrics": false,
                ],
                "screenTime": screenTimeStatus,
                "setupActions": buildSetupActions(
                    healthStatus: overrideStatus ?? "not-applicable",
                    healthCanRequest: overrideCanRequest ?? false,
                    screenTimeStatus: screenTimeStatus,
                    notification: notification
                ),
            ]
        }

        let status = overrideStatus ?? healthConsent.status
        let canRequest = overrideCanRequest ?? healthConsent.canRequest
        let settingsTarget: Any = status == "not-applicable" ? NSNull() : "health"
        let reason: Any
        if let permissionReason = overrideReason ?? healthConsent.reason {
            reason = permissionReason
        } else {
            reason = NSNull()
        }

        return [
            "status": status,
            "canRequest": canRequest,
            "canOpenSettings": true,
            "settingsTarget": settingsTarget,
            "engine": "healthkit-screen-time",
            "capabilities": mobileSignalsCapabilities(),
            "reason": reason,
            "screenTime": screenTimeStatus,
            "setupActions": buildSetupActions(
                healthStatus: status,
                healthCanRequest: canRequest,
                screenTimeStatus: screenTimeStatus,
                notification: notification
            ),
            "permissions": [
                // HealthKit intentionally withholds read authorization status.
                "sleep": false,
                "biometrics": false,
            ],
        ]
    }

    private func mobileSignalsCapabilities() -> [String: Any] {
        [
            "health": HKHealthStore.isHealthDataAvailable(),
            "screenTime": true,
            "notifications": true,
            "settings": true,
        ]
    }

    private func resolvePermissionAfterScreenTimeRequest(
        _ call: CAPPluginCall,
        status: String? = nil,
        canRequest: Bool? = nil,
        reason: String? = nil
    ) {
        ScreenTimeSupport.requestAuthorizationIfAvailable { [weak self] screenTimeReason in
            guard let self = self else { return }
            self.buildPermissionResult(
                status: status,
                canRequest: canRequest,
                reason: reason
            ) { result in
                let enriched = result.map { payload in
                    var next = payload
                    if let screenTimeReason {
                        if let existingReason = next["reason"] as? String, !existingReason.isEmpty {
                            next["reason"] = "\(existingReason) \(screenTimeReason)"
                        } else {
                            next["reason"] = screenTimeReason
                        }
                    }
                    return next
                }
                self.settlePermissionCall(call, result: enriched)
            }
        }
    }

    private func resolvePermissionResult(
        _ call: CAPPluginCall,
        status: String? = nil,
        canRequest: Bool? = nil,
        reason: String? = nil,
        requestScreenTime: Bool
    ) {
        if requestScreenTime {
            resolvePermissionAfterScreenTimeRequest(
                call,
                status: status,
                canRequest: canRequest,
                reason: reason
            )
            return
        }

        buildPermissionResult(
            status: status,
            canRequest: canRequest,
            reason: reason
        ) { result in
            self.settlePermissionCall(call, result: result)
        }
    }

    private func buildSetupActions(
        healthStatus: String,
        healthCanRequest: Bool,
        screenTimeStatus: [String: Any],
        notification: NotificationPermissionCapture
    ) -> [[String: Any]] {
        let healthReady = healthStatus == "determined"
        let authorization = screenTimeStatus["authorization"] as? [String: Any] ?? [:]
        let screenTimeAuthStatus = authorization["status"] as? String ?? "unavailable"
        let screenTimeCanRequest = authorization["canRequest"] as? Bool ?? false
        let screenTimeSupported = screenTimeStatus["supported"] as? Bool ?? false
        let screenTimeReady = screenTimeAuthStatus == "approved"
        let screenTimeReason = screenTimeStatus["reason"] ?? NSNull()
        let notificationsReady = notification.status == "granted"

        return [
            [
                "id": "health_permissions",
                "label": "HealthKit",
                "status": healthReady
                    ? "ready"
                    : (healthStatus == "not-applicable" ? "unavailable" : "needs-action"),
                "canRequest": healthCanRequest,
                "canOpenSettings": true,
                "settingsTarget": "health",
                "reason": healthReady
                    ? "iOS keeps individual HealthKit read grants private; monitoring queries return only authorized data."
                    : "Grant Health read access for sleep, heart rate, HRV, respiratory rate, and oxygen saturation.",
            ],
            [
                "id": "screen_time_authorization",
                "label": "Screen Time",
                "status": screenTimeReady
                    ? "ready"
                    : (screenTimeSupported ? "needs-action" : "unavailable"),
                "canRequest": screenTimeCanRequest,
                "canOpenSettings": true,
                "settingsTarget": "screenTime",
                "reason": screenTimeReady ? NSNull() : screenTimeReason,
            ],
            [
                "id": "local_network",
                "label": "Local Network",
                "status": "needs-action",
                "canRequest": false,
                "canOpenSettings": true,
                "settingsTarget": "localNetwork",
                "reason": "Allow Local Network when this phone sends data to a Mac or LAN agent.",
            ],
            [
                "id": "notification_settings",
                "label": "Notifications",
                "status": notificationsReady ? "ready" : "needs-action",
                "canRequest": notification.canRequest,
                "canOpenSettings": true,
                "settingsTarget": "notification",
                "reason": notificationsReady ? NSNull() : (notification.reason ?? "Open notification settings if reminders or telemetry prompts are muted."),
            ],
        ]
    }

    private func buildSnapshot(reason: String) -> [String: Any] {
        let app = UIApplication.shared
        let protectedAvailable = app.isProtectedDataAvailable
        let lowPower = ProcessInfo.processInfo.isLowPowerModeEnabled
        let batteryState = UIDevice.current.batteryState
        let batteryLevel = UIDevice.current.batteryLevel
        let onBattery: Bool? = {
            switch batteryState {
            case .charging, .full:
                return false
            case .unplugged:
                return true
            case .unknown:
                return nil
            @unknown default:
                return nil
            }
        }()
        let state: String = {
            if !protectedAvailable {
                return "locked"
            }
            switch app.applicationState {
            case .active:
                return lowPower ? "idle" : "active"
            case .inactive:
                return "idle"
            case .background:
                return "background"
            @unknown default:
                return "background"
            }
        }()
        let idleState: String = {
            if !protectedAvailable {
                return "locked"
            }
            if lowPower {
                return "idle"
            }
            return state == "active" ? "active" : "idle"
        }()
        let level = batteryLevel >= 0 ? Double(batteryLevel) : nil
        let onBatteryValue: Any = onBattery ?? NSNull()
        let levelValue: Any = level ?? NSNull()

        return [
            "source": "mobile_device",
            "platform": "ios",
            "state": state,
            "observedAt": Int64(Date().timeIntervalSince1970 * 1000),
            "idleState": idleState,
            "idleTimeSeconds": NSNull(),
            "onBattery": onBatteryValue,
            "metadata": [
                "reason": reason,
                "applicationState": app.applicationState.rawValue,
                "isProtectedDataAvailable": protectedAvailable,
                "isLowPowerModeEnabled": lowPower,
                "batteryState": batteryState.rawValue,
                "batteryLevel": levelValue,
            ],
        ]
    }

    private func isMonitoringGenerationActive(_ generation: UInt64) -> Bool {
        monitoringGeneration.isCurrent(generation) &&
            monitoringHealthQueries.isActive(generation: generation)
    }

    private func emitSignal(reason: String, generation: UInt64) {
        guard isMonitoringGenerationActive(generation) else { return }
        publishSignal(buildSnapshot(reason: reason))
    }

    private func emitHealthSignal(reason: String, generation: UInt64) {
        guard isMonitoringGenerationActive(generation) else { return }
        buildHealthSnapshot(
            reason: reason,
            monitoringGeneration: generation
        ) { [weak self] healthSnapshot in
            guard let self = self,
                  self.isMonitoringGenerationActive(generation) else { return }
            self.publishSignal(healthSnapshot)
        }
    }

    private func publishSignal(_ data: [String: Any]) {
        signalListenerLifecycle.publish {
            notifyListeners("signal", data: data)
        }
    }

    private func executeHealthQuery(
        _ query: HKQuery,
        monitoringGeneration generation: UInt64?,
        cancelCompletion: @escaping () -> Void
    ) {
        guard let generation else {
            healthStore.execute(query)
            return
        }
        guard monitoringHealthQueries.register(
            query,
            generation: generation,
            cancelCompletion: cancelCompletion
        ) else {
            cancelCompletion()
            return
        }

        healthStore.execute(query)
        // stopMonitoring can invalidate ownership between registration and
        // execution. Stopping again after execution closes that narrow race.
        if !monitoringHealthQueries.contains(query, generation: generation) {
            healthStore.stop(query)
        }
    }

    private func completeHealthQuery(
        _ query: HKQuery,
        monitoringGeneration generation: UInt64?
    ) {
        guard generation != nil else { return }
        monitoringHealthQueries.complete(query)
    }

    private func buildHealthSnapshot(
        reason: String,
        monitoringGeneration generation: UInt64? = nil,
        completion: @escaping ([String: Any]) -> Void
    ) {
        guard HKHealthStore.isHealthDataAvailable() else {
            completion(makeHealthSnapshot(
                reason: reason,
                capture: HealthCapture(
                    source: "healthkit",
                    screenTime: ScreenTimeSupport.buildStatus(),
                    permissions: ["sleep": false, "biometrics": false],
                    sleep: [
                        "available": false,
                        "isSleeping": false,
                        "asleepAt": NSNull(),
                        "awakeAt": NSNull(),
                        "durationMinutes": NSNull(),
                        "stage": NSNull(),
                    ],
                    biometrics: [
                        "sampleAt": NSNull(),
                        "heartRateBpm": NSNull(),
                        "restingHeartRateBpm": NSNull(),
                        "heartRateVariabilityMs": NSNull(),
                        "respiratoryRate": NSNull(),
                        "bloodOxygenPercent": NSNull(),
                    ],
                    warnings: ["HealthKit is not available on this device"]
                )
            ))
            return
        }

        healthQueue.async {
            let group = DispatchGroup()
            var sleepSummary: HealthCapture?
            var biometricsSummary: HealthCapture?
            var warnings: [String] = []

            group.enter()
            self.fetchSleepSummary(monitoringGeneration: generation) { capture, fetchWarning in
                sleepSummary = capture
                if let fetchWarning {
                    warnings.append(fetchWarning)
                }
                group.leave()
            }

            group.enter()
            self.fetchBiometrics(monitoringGeneration: generation) { capture, fetchWarning in
                biometricsSummary = capture
                if let fetchWarning {
                    warnings.append(fetchWarning)
                }
                group.leave()
            }

            group.notify(queue: .main) {
                let capture = HealthCapture(
                    source: "healthkit",
                    screenTime: ScreenTimeSupport.buildStatus(),
                    permissions: [
                        "sleep": sleepSummary?.permissions["sleep"] ?? false,
                        "biometrics": biometricsSummary?.permissions["biometrics"] ?? false,
                    ],
                    sleep: sleepSummary?.sleep ?? [
                        "available": false,
                        "isSleeping": false,
                        "asleepAt": NSNull(),
                        "awakeAt": NSNull(),
                        "durationMinutes": NSNull(),
                        "stage": NSNull(),
                    ],
                    biometrics: biometricsSummary?.biometrics ?? [
                        "sampleAt": NSNull(),
                        "heartRateBpm": NSNull(),
                        "restingHeartRateBpm": NSNull(),
                        "heartRateVariabilityMs": NSNull(),
                        "respiratoryRate": NSNull(),
                        "bloodOxygenPercent": NSNull(),
                    ],
                    warnings: warnings
                )
                completion(
                    self.makeHealthSnapshot(
                        reason: reason,
                        capture: capture
                    )
                )
            }
        }
    }

    private func makeHealthSnapshot(
        reason: String,
        capture: HealthCapture
    ) -> [String: Any] {
        let deviceBatteryState = UIDevice.current.batteryState
        let onBattery: Bool? = {
            switch deviceBatteryState {
            case .charging, .full:
                return false
            case .unplugged:
                return true
            case .unknown:
                return nil
            @unknown default:
                return nil
            }
        }()
        let state = (capture.sleep["isSleeping"] as? Bool) == true ? "sleeping" : "idle"
        return [
            "source": "mobile_health",
            "platform": "ios",
            "state": state,
            "observedAt": Int64(Date().timeIntervalSince1970 * 1000),
            "idleState": NSNull(),
            "idleTimeSeconds": NSNull(),
            "onBattery": onBattery ?? NSNull(),
            "healthSource": capture.source,
            "screenTime": capture.screenTime,
            "permissions": capture.permissions,
            "sleep": capture.sleep,
            "biometrics": capture.biometrics,
            "warnings": capture.warnings,
            "metadata": [
                "reason": reason,
                "healthSource": capture.source,
                "deviceState": UIApplication.shared.applicationState.rawValue,
            ],
        ]
    }

    private func fetchSleepSummary(
        monitoringGeneration generation: UInt64?,
        completion: @escaping (HealthCapture?, String?) -> Void
    ) {
        guard let sampleType = HKObjectType.categoryType(forIdentifier: .sleepAnalysis) else {
            completion(nil, "Sleep analysis type unavailable")
            return
        }

        let startDate = Calendar.current.date(byAdding: .day, value: -7, to: Date()) ?? Date().addingTimeInterval(-7 * 24 * 60 * 60)
        let predicate = HKQuery.predicateForSamples(
            withStart: startDate,
            end: nil,
            options: .strictStartDate
        )
        let sortDescriptors = [
            NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: true)
        ]
        let callbackQueue = healthQueue
        let completionGate = OneShotCompletionGate()
        let query = HKSampleQuery(
            sampleType: sampleType,
            predicate: predicate,
            limit: HKObjectQueryNoLimit,
            sortDescriptors: sortDescriptors
        ) { [weak self] completedQuery, samples, error in
            self?.completeHealthQuery(
                completedQuery,
                monitoringGeneration: generation
            )
            guard completionGate.claim() else { return }
            callbackQueue.async {
                guard error == nil else {
                    completion(nil, "Sleep analysis query failed")
                    return
                }
                let categories = (samples as? [HKCategorySample]) ?? []
                guard !categories.isEmpty else {
                    completion(
                        HealthCapture(
                            source: "healthkit",
                            screenTime: ScreenTimeSupport.buildStatus(),
                            permissions: ["sleep": false, "biometrics": false],
                            sleep: [
                                "available": false,
                                "isSleeping": false,
                                "asleepAt": NSNull(),
                                "awakeAt": NSNull(),
                                "durationMinutes": NSNull(),
                                "stage": NSNull(),
                            ],
                            biometrics: [
                                "sampleAt": NSNull(),
                                "heartRateBpm": NSNull(),
                                "restingHeartRateBpm": NSNull(),
                                "heartRateVariabilityMs": NSNull(),
                                "respiratoryRate": NSNull(),
                                "bloodOxygenPercent": NSNull(),
                            ],
                            warnings: []
                        ),
                        nil
                    )
                    return
                }

                let latestEpisode = Self.latestSleepEpisode(from: categories)
                let latestAwake = categories.last(where: { $0.value == HKCategoryValueSleepAnalysis.awake.rawValue })
                let now = Date()
                let sleepFreshnessWindow: TimeInterval = 15 * 60
                let isSleeping =
                    latestEpisode != nil &&
                    latestEpisode!.endDate >= now.addingTimeInterval(-sleepFreshnessWindow) &&
                    (latestAwake == nil || latestAwake!.endDate <= latestEpisode!.endDate)
                let asleepAt = latestEpisode?.startDate
                let awakeAt = isSleeping ? nil : latestEpisode?.endDate
                let durationMinutes = latestEpisode?.durationMinutes
                let stage = latestEpisode.map { episode in
                    isSleeping ? Self.sleepStageName(for: episode.latestStageValue) : "awake"
                } ?? "awake"
                completion(
                    HealthCapture(
                        source: "healthkit",
                        screenTime: ScreenTimeSupport.buildStatus(),
                        permissions: ["sleep": true, "biometrics": false],
                        sleep: [
                            "available": true,
                            "isSleeping": isSleeping,
                            "asleepAt": asleepAt.map { Int64($0.timeIntervalSince1970 * 1000) } ?? NSNull(),
                            "awakeAt": awakeAt.map { Int64($0.timeIntervalSince1970 * 1000) } ?? NSNull(),
                            "durationMinutes": durationMinutes.map { Int64($0.rounded()) } ?? NSNull(),
                            "stage": stage,
                        ],
                        biometrics: [
                            "sampleAt": NSNull(),
                            "heartRateBpm": NSNull(),
                            "restingHeartRateBpm": NSNull(),
                            "heartRateVariabilityMs": NSNull(),
                            "respiratoryRate": NSNull(),
                            "bloodOxygenPercent": NSNull(),
                        ],
                        warnings: []
                    ),
                    nil
                )
            }
        }
        executeHealthQuery(
            query,
            monitoringGeneration: generation
        ) {
            guard completionGate.claim() else { return }
            callbackQueue.async {
                completion(nil, nil)
            }
        }
    }

    private func fetchBiometrics(
        monitoringGeneration generation: UInt64?,
        completion: @escaping (HealthCapture?, String?) -> Void
    ) {
        let startDate = Calendar.current.date(byAdding: .day, value: -7, to: Date()) ?? Date().addingTimeInterval(-7 * 24 * 60 * 60)
        let endDate = Date()
        let predicate = HKQuery.predicateForSamples(
            withStart: startDate,
            end: endDate,
            options: .strictStartDate
        )

        let group = DispatchGroup()
        let callbackQueue = healthQueue
        var latestHeartRate: (value: Double, at: Date)?
        var latestRestingHeartRate: (value: Double, at: Date)?
        var latestHrv: (value: Double, at: Date)?
        var latestRespiratoryRate: (value: Double, at: Date)?
        var latestBloodOxygen: (value: Double, at: Date)?

        func fetchLatest(
            identifier: HKQuantityTypeIdentifier,
            unit: HKUnit,
            assign: @escaping (Double, Date) -> Void
        ) {
            guard let sampleType = HKObjectType.quantityType(forIdentifier: identifier) else {
                return
            }
            group.enter()
            let completionGate = OneShotCompletionGate()
            let query = HKSampleQuery(
                sampleType: sampleType,
                predicate: predicate,
                limit: 1,
                sortDescriptors: [
                    NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: false)
                ]
            ) { [weak self] completedQuery, samples, error in
                self?.completeHealthQuery(
                    completedQuery,
                    monitoringGeneration: generation
                )
                guard completionGate.claim() else { return }
                callbackQueue.async {
                    defer { group.leave() }
                    guard error == nil,
                          let sample = samples?.first as? HKQuantitySample else {
                        return
                    }
                    assign(sample.quantity.doubleValue(for: unit), sample.startDate)
                }
            }
            executeHealthQuery(
                query,
                monitoringGeneration: generation
            ) {
                guard completionGate.claim() else { return }
                callbackQueue.async {
                    group.leave()
                }
            }
        }

        fetchLatest(identifier: .heartRate, unit: HKUnit(from: "count/min")) { value, at in
            latestHeartRate = (value, at)
        }
        fetchLatest(identifier: .restingHeartRate, unit: HKUnit(from: "count/min")) { value, at in
            latestRestingHeartRate = (value, at)
        }
        fetchLatest(identifier: .heartRateVariabilitySDNN, unit: HKUnit.secondUnit(with: .milli)) { value, at in
            latestHrv = (value, at)
        }
        fetchLatest(identifier: .respiratoryRate, unit: HKUnit(from: "count/min")) { value, at in
            latestRespiratoryRate = (value, at)
        }
        fetchLatest(identifier: .oxygenSaturation, unit: HKUnit.percent()) { value, at in
            latestBloodOxygen = (value * 100.0, at)
        }

        group.notify(queue: .main) {
            let sampleAt = [
                latestHeartRate?.at,
                latestRestingHeartRate?.at,
                latestHrv?.at,
                latestRespiratoryRate?.at,
                latestBloodOxygen?.at,
            ].compactMap { $0 }.sorted().last
            let hasBiometrics =
                latestHeartRate != nil ||
                latestRestingHeartRate != nil ||
                latestHrv != nil ||
                latestRespiratoryRate != nil ||
                latestBloodOxygen != nil
            let sleep: [String: Any] = [
                "available": false,
                "isSleeping": false,
                "asleepAt": NSNull(),
                "awakeAt": NSNull(),
                "durationMinutes": NSNull(),
                "stage": NSNull(),
            ]
            let biometrics: [String: Any] = [
                "sampleAt": sampleAt.map { Int64($0.timeIntervalSince1970 * 1000) } ?? NSNull(),
                "heartRateBpm": latestHeartRate.map { Int64($0.value.rounded()) } ?? NSNull(),
                "restingHeartRateBpm": latestRestingHeartRate.map { Int64($0.value.rounded()) } ?? NSNull(),
                "heartRateVariabilityMs": latestHrv?.value ?? NSNull(),
                "respiratoryRate": latestRespiratoryRate?.value ?? NSNull(),
                "bloodOxygenPercent": latestBloodOxygen?.value ?? NSNull(),
            ]

            completion(
                HealthCapture(
                    source: "healthkit",
                    screenTime: ScreenTimeSupport.buildStatus(),
                    permissions: [
                        "sleep": false,
                        "biometrics": hasBiometrics,
                    ],
                    sleep: sleep,
                    biometrics: biometrics,
                    warnings: []
                ),
                nil
            )
        }
    }

    private static func isSleepSample(_ value: Int) -> Bool {
        value != HKCategoryValueSleepAnalysis.awake.rawValue &&
        value != HKCategoryValueSleepAnalysis.inBed.rawValue
    }

    private static func latestSleepEpisode(from categories: [HKCategorySample]) -> SleepEpisode? {
        let sleepSamples = categories
            .filter { isSleepSample($0.value) }
            .sorted { left, right in left.startDate < right.startDate }
        guard let first = sleepSamples.first else {
            return nil
        }

        let maxStageGap: TimeInterval = 90 * 60
        var episodes: [SleepEpisode] = []
        var episodeStart = first.startDate
        var episodeEnd = first.endDate
        var episodeDuration = first.endDate.timeIntervalSince(first.startDate) / 60.0
        var latestStageValue = first.value

        for sample in sleepSamples.dropFirst() {
            if sample.startDate.timeIntervalSince(episodeEnd) <= maxStageGap {
                episodeEnd = max(episodeEnd, sample.endDate)
                episodeDuration += sample.endDate.timeIntervalSince(sample.startDate) / 60.0
                latestStageValue = sample.value
                continue
            }
            episodes.append(SleepEpisode(
                startDate: episodeStart,
                endDate: episodeEnd,
                durationMinutes: episodeDuration,
                latestStageValue: latestStageValue
            ))
            episodeStart = sample.startDate
            episodeEnd = sample.endDate
            episodeDuration = sample.endDate.timeIntervalSince(sample.startDate) / 60.0
            latestStageValue = sample.value
        }

        episodes.append(SleepEpisode(
            startDate: episodeStart,
            endDate: episodeEnd,
            durationMinutes: episodeDuration,
            latestStageValue: latestStageValue
        ))
        return episodes.sorted { left, right in left.endDate < right.endDate }.last
    }

    private static func sleepStageName(for value: Int) -> String {
        switch value {
        case HKCategoryValueSleepAnalysis.awake.rawValue:
            return "awake"
        case HKCategoryValueSleepAnalysis.inBed.rawValue:
            return "in_bed"
        default:
            return "asleep"
        }
    }
}
