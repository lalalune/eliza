/**
 * Serializes signal publication with listener mutation and release. Closing
 * admission drains already-admitted callbacks before teardown can acknowledge,
 * while a failed release quarantines new listeners until a retry succeeds.
 */
import Foundation

public final class SignalListenerLifecycleGate: @unchecked Sendable {
    private let condition = NSCondition()
    private var acceptingPublications = false
    private var activePublications = 0
    private var releaseQuarantined = false

    public init() {}

    public var canAcquireListeners: Bool {
        condition.lock()
        defer { condition.unlock() }
        return !releaseQuarantined
    }

    public func resume(hasListeners: Bool) {
        condition.lock()
        acceptingPublications = hasListeners && !releaseQuarantined
        condition.unlock()
    }

    public func closeAndDrain() {
        condition.lock()
        acceptingPublications = false
        while activePublications > 0 {
            condition.wait()
        }
        condition.unlock()
    }

    public func finishRelease(succeeded: Bool) {
        condition.lock()
        releaseQuarantined = !succeeded
        acceptingPublications = false
        condition.broadcast()
        condition.unlock()
    }

    @discardableResult
    public func publish(_ body: () -> Void) -> Bool {
        condition.lock()
        guard acceptingPublications else {
            condition.unlock()
            return false
        }
        activePublications += 1
        condition.unlock()

        defer {
            condition.lock()
            activePublications -= 1
            if activePublications == 0 {
                condition.broadcast()
            }
            condition.unlock()
        }
        body()
        return true
    }
}
