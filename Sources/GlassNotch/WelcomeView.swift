import AppKit
import ServiceManagement
import SwiftUI

/// First-launch window: what GlassNotch does, and which permissions macOS may ask for and why.
/// Reopen it from the menu bar icon ("Welcome & Permissions…").
@MainActor
final class WelcomeWindowController {
    private var window: NSWindow?
    var onFinish: (() -> Void)?

    static let shownKey = "welcomeShown"

    static var hasBeenShown: Bool { UserDefaults.standard.bool(forKey: shownKey) }

    func show() {
        if window == nil {
            let view = WelcomeView { [weak self] in self?.finish() }
            let hosting = NSHostingController(rootView: view)
            let window = NSWindow(contentViewController: hosting)
            window.styleMask = [.titled, .closable, .fullSizeContentView]
            window.titlebarAppearsTransparent = true
            window.titleVisibility = .hidden
            window.isMovableByWindowBackground = true
            window.isReleasedWhenClosed = false
            window.title = "Welcome to GlassNotch"
            window.setContentSize(hosting.view.fittingSize)
            window.center()
            self.window = window
        }
        NSApp.activate()
        window?.makeKeyAndOrderFront(nil)
    }

    private func finish() {
        UserDefaults.standard.set(true, forKey: Self.shownKey)
        window?.close()
        onFinish?()
    }
}

struct WelcomeView: View {
    let onDone: () -> Void

    @State private var launchAtLogin = SMAppService.mainApp.status == .enabled

    var body: some View {
        VStack(spacing: 18) {
            VStack(spacing: 8) {
                Image(nsImage: NSApp.applicationIconImage)
                    .resizable()
                    .frame(width: 76, height: 76)
                Text("Welcome to GlassNotch")
                    .font(.system(size: 22, weight: .bold))
                Text("Your notch, in glass. Hover over the notch to open it: now playing, clipboard, Claude Code activity and screenshots.")
                    .font(.system(size: 13))
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.top, 14)

            VStack(alignment: .leading, spacing: 12) {
                Text("What macOS may ask you, and why")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(.secondary)
                PermissionRow(symbol: "folder.fill", tint: .blue,
                              title: "Desktop folder",
                              detail: "To show your recent screenshots, which macOS saves to the Desktop.",
                              when: "Asked the first time you open the Screenshots page.")
                PermissionRow(symbol: "rectangle.dashed.badge.record", tint: .pink,
                              title: "Screen Recording",
                              detail: "Only to capture the area you select with Capture Area or Capture Text. GlassNotch never records your screen on its own.",
                              when: "Asked the first time you capture.")
                PermissionRow(symbol: "phone.down.fill", tint: .green,
                              title: "Accessibility (optional)",
                              detail: "Only to press the End button in your call app when you click End in the notch. Call detection and mute need no permission.",
                              when: "Asked the first time you end a call from the notch.")
                PermissionRow(symbol: "gauge.with.dots.needle.33percent", tint: .orange,
                              title: "Claude usage limits (optional)",
                              detail: "Adds a small status line script to Claude Code's settings so GlassNotch can show your 5-hour and weekly limits. Your terminal looks the same.",
                              when: "Only if you choose Connect, in the menu or on the Agents page.")
            }
            .padding(16)
            .liquidGlass(in: RoundedRectangle(cornerRadius: 18, style: .continuous))

            Label("Everything stays on your Mac. GlassNotch doesn't connect to the internet or collect anything, and clipboard history lives only in memory.",
                  systemImage: "lock.fill")
                .font(.system(size: 11.5))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            HStack {
                Toggle("Open at login", isOn: $launchAtLogin)
                    .toggleStyle(.switch)
                    .controlSize(.small)
                    .onChange(of: launchAtLogin) { _, enabled in
                        do {
                            if enabled { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
                        } catch {
                            launchAtLogin = SMAppService.mainApp.status == .enabled
                        }
                    }
                Spacer()
                Button("Get Started", action: onDone)
                    .prominentGlassButton()
                    .controlSize(.large)
                    .keyboardShortcut(.defaultAction)
            }
        }
        .padding(.horizontal, 26)
        .padding(.bottom, 22)
        .frame(width: 470)
    }
}

private struct PermissionRow: View {
    let symbol: String
    let tint: Color
    let title: String
    let detail: String
    let when: String

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: symbol)
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: 30, height: 30)
                .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(tint.gradient))
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.system(size: 13, weight: .semibold))
                Text(detail)
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Text(when)
                    .font(.system(size: 11))
                    .foregroundStyle(.tertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}
