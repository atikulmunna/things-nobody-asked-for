import AppKit
import SwiftUI

enum NotchPhase: Equatable {
    /// Resting: a black shape hidden behind (or extending) the hardware notch.
    case collapsed
    /// The pointer is on the notch; it swells slightly before opening.
    case peeking
    /// The glass pill is open.
    case expanded
}

/// What the collapsed notch shows on its "wings".
enum LiveActivity: Equatable {
    case none
    case music
    /// A Claude Code session is working (or just finished).
    case agent
    /// Both: the agent on the left wing, the equalizer on the right.
    case musicAndAgent
    /// A call is in progress (app icon and timer).
    case call
    /// A short confirmation (e.g. "Copied").
    case toast(symbol: String, text: String, success: Bool)
}

/// Pages of the open pill.
enum NotchTab: String, CaseIterable, Identifiable {
    case media, clipboard, agents, screenshots

    var id: String { rawValue }

    var symbol: String {
        switch self {
        case .media: "music.note"
        case .clipboard: "doc.on.clipboard"
        case .agents: "sparkles"
        case .screenshots: "camera.viewfinder"
        }
    }

    var title: String {
        switch self {
        case .media: "Now Playing"
        case .clipboard: "Clipboard"
        case .agents: "Agents"
        case .screenshots: "Screenshots"
        }
    }
}

@MainActor
final class NotchModel: ObservableObject {
    @Published var phase: NotchPhase = .collapsed
    @Published var activity: LiveActivity = .none
    @Published var tab: NotchTab = .media
    /// Session shown on the Agents page (nil: the most relevant one).
    @Published var selectedAgentID: String?
    /// The glass layer is rendered only while it is (or is about to be) visible.
    @Published var glassActive = false
    @Published private(set) var notchSize = CGSize(width: 185, height: 32)
    @Published private(set) var hasHardwareNotch = false

    /// Room around the pill inside the window so the glass edge is not clipped.
    static let windowPadding: CGFloat = 40
    /// Width of each side of the open pill beside the notch (tabs left, actions right).
    static let expandedSideWidth: CGFloat = 126
    /// Height of the open pill below the notch, per page. Switching pages springs between them.
    static func bodyHeight(for tab: NotchTab) -> CGFloat {
        switch tab {
        case .media, .screenshots: 80
        case .agents: 94
        case .clipboard: 140
        }
    }

    var expandedSize: CGSize { expandedSize(for: tab) }

    func expandedSize(for tab: NotchTab) -> CGSize {
        CGSize(width: notchSize.width + 2 * Self.expandedSideWidth,
               height: notchSize.height + Self.bodyHeight(for: tab))
    }

    /// Height at which the corners reach their fully open radii (the shortest page), so switching
    /// between pages of different heights never changes the corners.
    var openReferenceHeight: CGFloat {
        NotchTab.allCases.map { expandedSize(for: $0).height }.min() ?? expandedSize.height
    }

    /// The largest the pill gets on any page (sizes the window).
    var maxExpandedSize: CGSize {
        NotchTab.allCases.map { expandedSize(for: $0) }.max { $0.height < $1.height } ?? expandedSize
    }

    func configure(for screen: NSScreen) {
        if screen.safeAreaInsets.top > 0,
           let left = screen.auxiliaryTopLeftArea,
           let right = screen.auxiliaryTopRightArea {
            notchSize = CGSize(width: screen.frame.width - left.width - right.width,
                               height: screen.safeAreaInsets.top)
            hasHardwareNotch = true
        } else {
            let menuBar = screen.frame.maxY - screen.visibleFrame.maxY
            notchSize = CGSize(width: 185, height: max(24, menuBar))
            hasHardwareNotch = false
        }
    }

    /// Black shape that sits exactly behind the hardware notch. It is a few points wider than
    /// the notch so the concave top flares tuck into the screen corners.
    var baseSize: CGSize { CGSize(width: notchSize.width + 4, height: notchSize.height) }

    var wingWidth: CGFloat {
        switch activity {
        case .none: 0
        case .music, .agent, .musicAndAgent: notchSize.height + 10
        case .toast: notchSize.height + 34
        case .call: notchSize.height + 30
        }
    }

    var collapsedSize: CGSize {
        CGSize(width: baseSize.width + 2 * wingWidth, height: baseSize.height)
    }

    var peekSize: CGSize {
        CGSize(width: collapsedSize.width + 18, height: collapsedSize.height + 5)
    }

    /// Size of the shape currently on screen.
    var visibleSize: CGSize {
        switch phase {
        case .collapsed: collapsedSize
        case .peeking: peekSize
        case .expanded: expandedSize
        }
    }

    /// Height of the glass while it hides under the black notch.
    var collapsedGlassHeight: CGFloat { max(0, notchSize.height - 8) }

    /// Glass hides under the black notch until the pill opens, then grows out from behind it.
    var glassSize: CGSize {
        switch phase {
        case .expanded: expandedSize
        case .collapsed, .peeking:
            CGSize(width: max(0, collapsedSize.width - 24), height: collapsedGlassHeight)
        }
    }

    /// Size of the opaque black layer: the full shape while collapsed, just the hardware notch while open.
    var blackSize: CGSize {
        phase == .expanded ? baseSize : visibleSize
    }

    var bottomRadius: CGFloat {
        switch phase {
        case .collapsed: 13
        case .peeking: 16
        case .expanded: LiquidNotchShape.openRadii.bottom
        }
    }
}
