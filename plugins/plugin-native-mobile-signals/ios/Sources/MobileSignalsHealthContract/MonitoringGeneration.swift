/**
 * Monotonic ownership token for asynchronous native monitoring work.
 *
 * Completions publish only while their captured generation is current, so a
 * stopped HealthKit read cannot become active again after an immediate restart.
 */
import Foundation

public final class MonitoringGeneration {
    private let lock = NSLock()
    private var current: UInt64 = 0

    public init() {}

    @discardableResult
    public func begin() -> UInt64 {
        lock.lock()
        defer { lock.unlock() }
        current &+= 1
        return current
    }

    @discardableResult
    public func invalidate() -> UInt64 {
        lock.lock()
        defer { lock.unlock() }
        current &+= 1
        return current
    }

    public func isCurrent(_ generation: UInt64) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return current == generation
    }
}
