/**
 * Pins monitoring-generation invalidation independently of HealthKit timing.
 */
import XCTest
@testable import MobileSignalsHealthContract

final class MonitoringGenerationTests: XCTestCase {
    func testStoppedGenerationCannotEnterImmediateSuccessor() {
        let generations = MonitoringGeneration()
        let first = generations.begin()
        XCTAssertTrue(generations.isCurrent(first))

        generations.invalidate()
        let second = generations.begin()

        XCTAssertFalse(generations.isCurrent(first))
        XCTAssertTrue(generations.isCurrent(second))
    }
}
