/**
 * Pins query ownership and completion races at the platform-neutral boundary
 * used by the iOS HealthKit bridge.
 */
import XCTest
@testable import MobileSignalsHealthContract

final class MonitoringResourceRegistryTests: XCTestCase {
    private final class Resource {}

    func testInvalidateReturnsEveryOwnedResourceAndRejectsLateRegistration() {
        let registry = MonitoringResourceRegistry<Resource>()
        let first = Resource()
        let late = Resource()
        var cancellationCount = 0
        registry.activate(generation: 7)
        XCTAssertEqual(registry.currentGeneration, 7)

        XCTAssertTrue(registry.register(first, generation: 7) {
            cancellationCount += 1
        })
        XCTAssertTrue(registry.contains(first, generation: 7))

        let cancelled = registry.invalidate()
        XCTAssertNil(registry.currentGeneration)
        cancelled.forEach { $0.cancelCompletion() }

        XCTAssertEqual(cancelled.count, 1)
        XCTAssertTrue(cancelled[0].resource === first)
        XCTAssertEqual(cancellationCount, 1)
        XCTAssertFalse(registry.contains(first, generation: 7))
        XCTAssertFalse(registry.register(late, generation: 7, cancelCompletion: {}))

        registry.activate(generation: 8)
        XCTAssertFalse(registry.register(late, generation: 7, cancelCompletion: {}))
        XCTAssertTrue(registry.register(late, generation: 8, cancelCompletion: {}))
    }

    func testCompletedResourceIsNotReturnedForCancellation() {
        let registry = MonitoringResourceRegistry<Resource>()
        let completed = Resource()
        registry.activate(generation: 11)
        XCTAssertTrue(registry.register(completed, generation: 11, cancelCompletion: {}))

        registry.complete(completed)

        XCTAssertTrue(registry.invalidate().isEmpty)
    }

    func testOnlyCancellationOrPlatformCallbackCanClaimCompletion() {
        let gate = OneShotCompletionGate()

        XCTAssertTrue(gate.claim())
        XCTAssertFalse(gate.claim())
    }
}
