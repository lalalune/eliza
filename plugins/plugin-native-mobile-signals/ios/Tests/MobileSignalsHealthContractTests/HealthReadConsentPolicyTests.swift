/**
 * Verifies that HealthKit read consent reports prompt eligibility without
 * inferring the user's private per-type authorization choices.
 */
import XCTest
@testable import MobileSignalsHealthContract

final class HealthReadConsentPolicyTests: XCTestCase {
    func testShouldRequestAllowsTheSystemConsentSheet() throws {
        let decision = try HealthReadConsentPolicy.decide(requestState: .shouldRequest)

        XCTAssertEqual(decision.status, "not-determined")
        XCTAssertTrue(decision.canRequest)
    }

    func testUnnecessaryMeansDecisionMadeRatherThanGranted() throws {
        let decision = try HealthReadConsentPolicy.decide(requestState: .unnecessary)

        XCTAssertEqual(decision.status, "determined")
        XCTAssertFalse(decision.canRequest)
        XCTAssertNotEqual(decision.status, "granted")
    }

    func testUnknownStatusSurfacesTheLookupFailure() {
        XCTAssertThrowsError(
            try HealthReadConsentPolicy.decide(
                requestState: .unknown,
                failureReason: "HealthKit request-status lookup failed."
            )
        ) { error in
            XCTAssertEqual(
                error as? HealthReadConsentError,
                .requestStatusUnavailable("HealthKit request-status lookup failed.")
            )
        }
    }
}
