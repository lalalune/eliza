/**
 * Maps HealthKit's authorization-request decision into an honest read-consent
 * status without claiming access that iOS deliberately keeps private.
 */
import Foundation

public enum HealthReadAuthorizationRequestState: Equatable, Sendable {
    case shouldRequest
    case unnecessary
    case unknown
}

public struct HealthReadConsentDecision: Equatable, Sendable {
    public let status: String
    public let canRequest: Bool
    public let reason: String?

    public init(status: String, canRequest: Bool, reason: String?) {
        self.status = status
        self.canRequest = canRequest
        self.reason = reason
    }
}

public enum HealthReadConsentError: Error, Equatable, LocalizedError, Sendable {
    case requestStatusUnavailable(String)

    public var errorDescription: String? {
        switch self {
        case .requestStatusUnavailable(let reason):
            return reason
        }
    }
}

public enum HealthReadConsentPolicy {
    public static func decide(
        requestState: HealthReadAuthorizationRequestState,
        failureReason: String? = nil
    ) throws -> HealthReadConsentDecision {
        switch requestState {
        case .shouldRequest:
            return HealthReadConsentDecision(
                status: "not-determined",
                canRequest: true,
                reason: "Allow Health read access for sleep, heart rate, HRV, respiratory rate, and oxygen saturation."
            )
        case .unnecessary:
            return HealthReadConsentDecision(
                status: "determined",
                canRequest: false,
                reason: "iOS does not disclose individual HealthKit read grants; queries return only data the user authorized."
            )
        case .unknown:
            throw HealthReadConsentError.requestStatusUnavailable(
                failureReason ??
                    "HealthKit returned an unknown authorization request status."
            )
        }
    }
}
