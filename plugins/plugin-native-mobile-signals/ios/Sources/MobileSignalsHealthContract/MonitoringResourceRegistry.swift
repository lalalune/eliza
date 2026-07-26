/**
 * Owns generation-scoped native resources and one-shot completion claims so
 * teardown can cancel work without racing a platform callback.
 */
import Foundation

public struct MonitoringResourceEntry<Resource: AnyObject> {
    public let resource: Resource
    public let cancelCompletion: () -> Void

    public init(resource: Resource, cancelCompletion: @escaping () -> Void) {
        self.resource = resource
        self.cancelCompletion = cancelCompletion
    }
}

public final class MonitoringResourceRegistry<Resource: AnyObject>: @unchecked Sendable {
    private let lock = NSLock()
    private var activeGeneration: UInt64?
    private var entries: [ObjectIdentifier: MonitoringResourceEntry<Resource>] = [:]

    public init() {}

    public var currentGeneration: UInt64? {
        lock.lock()
        defer { lock.unlock() }
        return activeGeneration
    }

    public func activate(generation: UInt64) {
        lock.lock()
        activeGeneration = generation
        lock.unlock()
    }

    public func isActive(generation: UInt64) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return activeGeneration == generation
    }

    public func register(
        _ resource: Resource,
        generation: UInt64,
        cancelCompletion: @escaping () -> Void
    ) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard activeGeneration == generation else {
            return false
        }
        entries[ObjectIdentifier(resource)] = MonitoringResourceEntry(
            resource: resource,
            cancelCompletion: cancelCompletion
        )
        return true
    }

    public func complete(_ resource: Resource) {
        lock.lock()
        entries.removeValue(forKey: ObjectIdentifier(resource))
        lock.unlock()
    }

    public func contains(_ resource: Resource, generation: UInt64) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return activeGeneration == generation &&
            entries[ObjectIdentifier(resource)] != nil
    }

    public func invalidate() -> [MonitoringResourceEntry<Resource>] {
        lock.lock()
        activeGeneration = nil
        let ownedEntries = Array(entries.values)
        entries.removeAll()
        lock.unlock()
        return ownedEntries
    }
}

public final class OneShotCompletionGate: @unchecked Sendable {
    private let lock = NSLock()
    private var claimed = false

    public init() {}

    public func claim() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard !claimed else {
            return false
        }
        claimed = true
        return true
    }
}
