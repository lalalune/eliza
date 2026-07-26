/**
 * Retains native callback resources until their external owner confirms each
 * release, allowing teardown to be retried after an unavailable bridge.
 */
import Foundation

public final class RetryableReleaseRegistry<Resource: AnyObject>: @unchecked Sendable {
    private let lock = NSLock()
    private var resources: [ObjectIdentifier: Resource] = [:]

    public init() {}

    public func track(_ resource: Resource) {
        lock.lock()
        resources[ObjectIdentifier(resource)] = resource
        lock.unlock()
    }

    public var isEmpty: Bool {
        lock.lock()
        defer { lock.unlock() }
        return resources.isEmpty
    }

    public func confirmReleased(_ resource: Resource) {
        let identifier = ObjectIdentifier(resource)
        lock.lock()
        if resources[identifier] === resource {
            resources.removeValue(forKey: identifier)
        }
        lock.unlock()
    }

    public func releaseAll(
        using release: ((Resource) throws -> Void)?
    ) throws -> Bool {
        guard let release else {
            return isEmpty
        }

        while true {
            lock.lock()
            let next = resources.first
            lock.unlock()
            guard let (identifier, resource) = next else {
                return true
            }

            try release(resource)

            lock.lock()
            if resources[identifier] === resource {
                resources.removeValue(forKey: identifier)
            }
            lock.unlock()
        }
    }
}
