/**
 * Proves listener mutation closes publication admission and waits for admitted
 * callbacks, including failed-release quarantine and successful retry.
 */
import XCTest
@testable import MobileSignalsHealthContract

final class SignalListenerLifecycleGateTests: XCTestCase {
    func testStartsClosedAndPublishesOnlyWhileListenersAreOwned() {
        let gate = SignalListenerLifecycleGate()
        var publications = 0

        XCTAssertFalse(gate.publish { publications += 1 })
        gate.resume(hasListeners: true)
        XCTAssertTrue(gate.publish { publications += 1 })
        gate.closeAndDrain()
        XCTAssertFalse(gate.publish { publications += 1 })
        XCTAssertEqual(publications, 1)
    }

    func testCloseDrainsAnAdmittedPublicationBeforeReturning() {
        let gate = SignalListenerLifecycleGate()
        gate.resume(hasListeners: true)
        let publicationEntered = DispatchSemaphore(value: 0)
        let allowPublicationToFinish = DispatchSemaphore(value: 0)
        let publicationFinished = DispatchSemaphore(value: 0)
        let drainFinished = DispatchSemaphore(value: 0)

        DispatchQueue.global().async {
            gate.publish {
                publicationEntered.signal()
                allowPublicationToFinish.wait()
            }
            publicationFinished.signal()
        }
        XCTAssertEqual(
            publicationEntered.wait(timeout: .now() + 1),
            .success
        )

        DispatchQueue.global().async {
            gate.closeAndDrain()
            drainFinished.signal()
        }
        XCTAssertEqual(
            drainFinished.wait(timeout: .now() + 0.1),
            .timedOut
        )

        allowPublicationToFinish.signal()
        XCTAssertEqual(
            publicationFinished.wait(timeout: .now() + 1),
            .success
        )
        XCTAssertEqual(
            drainFinished.wait(timeout: .now() + 1),
            .success
        )
        XCTAssertFalse(gate.publish {})
    }

    func testFailedReleaseQuarantinesAcquisitionUntilSuccessfulRetry() {
        let gate = SignalListenerLifecycleGate()
        gate.resume(hasListeners: true)
        gate.closeAndDrain()
        gate.finishRelease(succeeded: false)

        XCTAssertFalse(gate.canAcquireListeners)
        gate.resume(hasListeners: true)
        XCTAssertFalse(gate.publish {})

        gate.finishRelease(succeeded: true)
        XCTAssertTrue(gate.canAcquireListeners)
        XCTAssertFalse(gate.publish {})
        gate.resume(hasListeners: true)
        XCTAssertTrue(gate.publish {})
    }

    func testRemoveCanCloseMutateAndResumeWithoutDeadlock() {
        let gate = SignalListenerLifecycleGate()
        gate.resume(hasListeners: true)
        XCTAssertTrue(gate.publish {})

        gate.closeAndDrain()
        gate.resume(hasListeners: true)

        XCTAssertTrue(gate.publish {})
    }
}
