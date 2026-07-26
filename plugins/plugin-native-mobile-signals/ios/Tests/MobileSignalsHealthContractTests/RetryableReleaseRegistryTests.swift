/**
 * Pins callback ownership across unavailable and partially failed external
 * release attempts without importing Capacitor into the contract test target.
 */
import XCTest
@testable import MobileSignalsHealthContract

final class RetryableReleaseRegistryTests: XCTestCase {
    private final class Resource {
        let id: String

        init(_ id: String) {
            self.id = id
        }
    }

    func testUnavailableBridgeRetainsOwnershipForRetry() throws {
        let registry = RetryableReleaseRegistry<Resource>()
        let resource = Resource("listener")
        registry.track(resource)

        XCTAssertFalse(try registry.releaseAll(using: nil))
        XCTAssertFalse(registry.isEmpty)

        var released: [String] = []
        XCTAssertTrue(try registry.releaseAll { released.append($0.id) })
        XCTAssertEqual(released, ["listener"])
        XCTAssertTrue(registry.isEmpty)
    }

    func testPartialFailureRetainsOnlyTheUnconfirmedResources() throws {
        struct ReleaseFailure: Error {}
        let registry = RetryableReleaseRegistry<Resource>()
        let first = Resource("first")
        let second = Resource("second")
        registry.track(first)
        registry.track(second)
        var released: [String] = []

        XCTAssertThrowsError(
            try registry.releaseAll { resource in
                if resource === second {
                    throw ReleaseFailure()
                }
                released.append(resource.id)
            }
        )
        XCTAssertFalse(registry.isEmpty)

        XCTAssertTrue(try registry.releaseAll { released.append($0.id) })
        XCTAssertEqual(Set(released), Set(["first", "second"]))
        XCTAssertEqual(released.count, 2)
        XCTAssertTrue(registry.isEmpty)
    }

    func testDuplicateTrackingDoesNotDoubleRelease() throws {
        let registry = RetryableReleaseRegistry<Resource>()
        let resource = Resource("listener")
        registry.track(resource)
        registry.track(resource)
        var releaseCount = 0

        XCTAssertTrue(
            try registry.releaseAll { _ in releaseCount += 1 }
        )
        XCTAssertEqual(releaseCount, 1)
    }

    func testConfirmedIndividualReleaseIsNotRetried() throws {
        let registry = RetryableReleaseRegistry<Resource>()
        let resource = Resource("listener")
        registry.track(resource)

        registry.confirmReleased(resource)

        var releaseCount = 0
        XCTAssertTrue(
            try registry.releaseAll { _ in releaseCount += 1 }
        )
        XCTAssertEqual(releaseCount, 0)
    }
}
