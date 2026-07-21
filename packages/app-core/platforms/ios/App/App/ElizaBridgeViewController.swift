/**
 * Hosts the iOS Capacitor WebView with startup tracing and app-local bridge
 * plugins that cannot be discovered through generated package metadata.
 */

import Capacitor
import WebKit

@objc(ElizaBridgeViewController)
class ElizaBridgeViewController: CAPBridgeViewController {
    override func webViewConfiguration(for instanceConfiguration: InstanceConfiguration) -> WKWebViewConfiguration {
        let configuration = super.webViewConfiguration(for: instanceConfiguration)
        configuration.userContentController.addUserScript(
            WKUserScript(
                source: ElizaStartupTrace.documentStartScript,
                injectionTime: .atDocumentStart,
                forMainFrameOnly: true
            )
        )
        return configuration
    }

    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        // App-local plugins are not present in Capacitor's generated package
        // class list. Explicit registration keeps the native queue reachable
        // when an App Intent resumes an already-running WebView.
        bridge?.registerPluginInstance(NativeComposerPlugin())
        NSLog("[ElizaStartupTrace] iOS startupTraceId=%@", ElizaStartupTrace.currentId)
    }
}
