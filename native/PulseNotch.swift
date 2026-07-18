// PulseNotch: a tiny always-on-top notch overlay for Pulse.
//
// A borderless, non-activating NSPanel pinned top-center above every app and
// every Space (fullscreen included), rendering http://127.0.0.1:4317/notch in
// a transparent WKWebView. The page reports its content height so the window
// is never larger than the pill itself. Right-click the pill to quit.
//
// Compiled on demand by `claude-pulse notch` (needs Xcode command line tools):
//   xcrun -sdk macosx swiftc -O -o ~/.claude-pulse/PulseNotch native/PulseNotch.swift

import Cocoa
import WebKit

let W: CGFloat = 470
let START_H: CGFloat = 64

final class NotchPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

final class Bridge: NSObject, WKScriptMessageHandler {
    weak var panel: NSPanel?
    func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "resize", let h = message.body as? Double, let panel = panel else { return }
        let newH = CGFloat(min(max(h, 44), 420))
        DispatchQueue.main.async {
            var f = panel.frame
            guard abs(f.size.height - newH) > 1 else { return }
            f.origin.y = f.maxY - newH   // keep the top edge glued to the screen top
            f.size.height = newH
            panel.setFrame(f, display: true)
        }
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory) // no Dock icon, no menu bar entry

let urlStr = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "http://127.0.0.1:4317/notch"
guard let screen = NSScreen.main, let url = URL(string: urlStr) else { exit(1) }

let sf = screen.frame
let rect = NSRect(x: sf.midX - W / 2, y: sf.maxY - START_H, width: W, height: START_H)

let panel = NotchPanel(contentRect: rect, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
panel.level = .statusBar                       // floats above normal windows
panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
panel.isOpaque = false
panel.backgroundColor = .clear
panel.hasShadow = false
panel.hidesOnDeactivate = false
panel.isMovableByWindowBackground = true

let bridge = Bridge()
bridge.panel = panel

let cfg = WKWebViewConfiguration()
cfg.userContentController.add(bridge, name: "resize")
let web = WKWebView(frame: NSRect(x: 0, y: 0, width: W, height: START_H), configuration: cfg)
web.autoresizingMask = [.width, .height]
web.setValue(false, forKey: "drawsBackground") // transparent page background
web.load(URLRequest(url: url))
panel.contentView = web
panel.orderFrontRegardless()

// right-click anywhere on the pill closes the overlay
NSEvent.addLocalMonitorForEvents(matching: .rightMouseDown) { _ in
    NSApp.terminate(nil)
    return nil
}

app.run()
