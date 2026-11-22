import SwiftUI

/// The open pill, wrapped around the hardware notch: page tabs on the left of the notch, the
/// page's actions on the right, and the page below.
///
///     ┌[♪ ⎘ ✦ ⌗]──────[ notch ]──────[actions]┐
///     │                 page                  │
///     └───────────────────────────────────────┘
struct ExpandedView: View {
    @ObservedObject var model: NotchModel
    @ObservedObject var nowPlaying: NowPlayingService
    @ObservedObject var clipboard: ClipboardMonitor
    @ObservedObject var agents: AgentMonitor
    @ObservedObject var screenshots: ScreenshotService
    @ObservedObject var usage: ClaudeUsageService
    @ObservedObject var calls: CallMonitor
    let namespace: Namespace.ID

    @Namespace private var tabNamespace

    private var inset: CGFloat { LiquidNotchShape.openRadii.top + 14 }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 0) {
                TabBar(model: model, agentsWorking: agents.workingCount > 0, onCall: calls.call != nil,
                       namespace: tabNamespace)
                Spacer(minLength: model.baseSize.width + 8)
                actions
                    .transition(.opacity)
                    .id(model.tab)
            }
            .frame(height: model.notchSize.height)
            .padding(.leading, inset - 4)
            .padding(.trailing, inset - 6)
            .padding(.top, 1)

            page
                .id(model.tab)
                .transition(.liquid)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
                .padding(.horizontal, inset)
                .padding(.top, 4)
                .padding(.bottom, 14)
        }
        .frame(width: model.expandedSize.width, height: model.expandedSize.height)
    }

    @ViewBuilder
    private var page: some View {
        switch model.tab {
        case .media:
            if let call = calls.call {
                CallPage(calls: calls, call: call)
            } else {
                MediaPage(nowPlaying: nowPlaying, namespace: namespace)
            }
        case .clipboard: ClipboardPage(clipboard: clipboard)
        case .agents: AgentsPage(model: model, agents: agents, usage: usage)
        case .screenshots: ScreenshotsPage(screenshots: screenshots)
        }
    }

    @ViewBuilder
    private var actions: some View {
        switch model.tab {
        case .media where calls.call != nil:
            HStack(spacing: 6) {
                CallButton(symbol: calls.isMicMuted ? "mic.slash.fill" : "mic.fill",
                           foreground: calls.isMicMuted ? .white : .primary,
                           background: calls.isMicMuted ? Color(red: 1, green: 0.32, blue: 0.3) : Color.primary.opacity(0.14),
                           help: calls.isMicMuted ? "Unmute microphone" : "Mute microphone",
                           action: calls.toggleMute)
                CallButton(symbol: "phone.down.fill", foreground: .white,
                           background: Color(red: 1, green: 0.27, blue: 0.25), help: "End call",
                           action: calls.endCall)
            }
        case .media:
            let info = nowPlaying.info
            HStack(spacing: 0) {
                IconButton(symbol: "backward.fill", pointSize: 11.5, box: 26, action: nowPlaying.previousTrack)
                IconButton(symbol: info.playing ? "pause.fill" : "play.fill", pointSize: 16, box: 30,
                           action: nowPlaying.togglePlayPause)
                IconButton(symbol: "forward.fill", pointSize: 11.5, box: 26, action: nowPlaying.nextTrack)
            }
            .disabled(!info.hasContent)
            .opacity(info.hasContent ? 1 : 0.4)
        case .clipboard:
            if !clipboard.items.isEmpty {
                IconButton(symbol: "trash", pointSize: 11.5, box: 26, action: clipboard.clear)
                    .help("Clear clipboard history")
            }
        case .agents:
            HStack(spacing: 8) {
                if agents.sessions.count > 1 {
                    SessionSwitcher(model: model, sessions: Array(agents.sessions.prefix(5)))
                }
                if agents.workingCount > 0 {
                    Text("\(agents.workingCount) running")
                        .font(.system(size: 10.5, weight: .semibold))
                        .foregroundStyle(AgentPhase.done.color)
                        .padding(.horizontal, 7)
                        .padding(.vertical, 2.5)
                        .background(Capsule().fill(AgentPhase.done.color.opacity(0.16)))
                }
            }
        case .screenshots:
            HStack(spacing: 2) {
                IconButton(symbol: "text.viewfinder", pointSize: 12.5, box: 28, action: screenshots.captureText)
                    .help("Capture text from an area of the screen")
                IconButton(symbol: "camera.viewfinder", pointSize: 12.5, box: 28, action: screenshots.captureArea)
                    .help("Capture an area of the screen")
            }
        }
    }
}

/// Page icons. The selected one sits in a pill that slides between them.
struct TabBar: View {
    @ObservedObject var model: NotchModel
    var agentsWorking: Bool
    var onCall: Bool = false
    let namespace: Namespace.ID

    var body: some View {
        HStack(spacing: 1) {
            ForEach(NotchTab.allCases) { tab in
                let selected = model.tab == tab
                Button {
                    withAnimation(.spring(response: 0.34, dampingFraction: 0.78)) { model.tab = tab }
                } label: {
                    let callTab = tab == .media && onCall
                    Image(systemName: callTab ? "phone.fill" : tab.symbol)
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(callTab ? Color.green : (selected ? Color.primary : Color.secondary))
                        .frame(width: 24, height: 22)
                        .background {
                            if selected {
                                Capsule()
                                    .fill(Color.primary.opacity(0.16))
                                    .matchedGeometryEffect(id: "selectedTab", in: namespace)
                            }
                        }
                        .overlay(alignment: .topTrailing) {
                            if tab == .agents && agentsWorking {
                                Circle().fill(Color.green).frame(width: 5, height: 5).offset(x: -3, y: 3)
                            }
                        }
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help(tab.title)
            }
        }
    }
}

/// One dot per session, colored by phase; click to show that session.
struct SessionSwitcher: View {
    @ObservedObject var model: NotchModel
    let sessions: [AgentSession]

    var body: some View {
        HStack(spacing: 5) {
            ForEach(sessions) { session in
                let selected = (model.selectedAgentID ?? sessions.first?.id) == session.id
                Button {
                    withAnimation(.spring(response: 0.34, dampingFraction: 0.78)) { model.selectedAgentID = session.id }
                } label: {
                    Circle()
                        .fill(session.phase.color.opacity(selected ? 1 : 0.45))
                        .frame(width: selected ? 8 : 6, height: selected ? 8 : 6)
                        .frame(width: 12, height: 18)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help(session.title)
            }
        }
    }
}

/// Round, filled button for call controls.
struct CallButton: View {
    let symbol: String
    let foreground: Color
    let background: Color
    let help: String
    let action: () -> Void

    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 11.5, weight: .bold))
                .foregroundStyle(foreground)
                .contentTransition(.symbolEffect(.replace))
                .frame(width: 27, height: 27)
                .background(Circle().fill(background))
                .brightness(hovering ? 0.08 : 0)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .trackHover($hovering)
        .help(help)
    }
}

/// Placeholder for an empty page.
struct EmptyHint: View {
    let symbol: String
    let text: String

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: symbol)
                .font(.system(size: 15, weight: .medium))
            Text(text)
                .font(.system(size: 12, weight: .medium))
        }
        .foregroundStyle(.secondary)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
