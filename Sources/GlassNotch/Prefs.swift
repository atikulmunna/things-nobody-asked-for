import Foundation
import Combine

enum GlassStyle: String, CaseIterable, Identifiable {
    /// Lensing glass that refracts like a water drop, over a layer of frost.
    case waterdrop
    /// Apple's standard (frosted) Liquid Glass material.
    case frosted
    /// Clear glass like the Dock, with a light dim.
    case clear

    var id: String { rawValue }
    var title: String {
        switch self {
        case .waterdrop: "Waterdrop"
        case .frosted: "Frosted"
        case .clear: "Clear"
        }
    }
}

/// User preferences, persisted in UserDefaults.
@MainActor
final class Prefs: ObservableObject {
    static let shared = Prefs()

    private let defaults = UserDefaults.standard

    private enum Key {
        static let glassStyle = "glassStyleV2"
        static let frost = "frost"
        static let tint = "tintWithArtwork"
        static let dark = "darkGlass"
        static let music = "showMusicActivity"
        static let agents = "showAgentActivity"
        static let calls = "showCallActivity"
        static let haptics = "haptics"
        static let hoverDelay = "hoverDelay"
        static let statsWidget = "showStatsWidget"
        static let keepIconsClear = "keepDesktopIconsClear"
    }

    @Published var glassStyle: GlassStyle { didSet { defaults.set(glassStyle.rawValue, forKey: Key.glassStyle) } }
    /// Opacity of the frost layer under the Waterdrop lens (0...1).
    @Published var frost: Double { didSet { defaults.set(frost, forKey: Key.frost) } }
    @Published var tintWithArtwork: Bool { didSet { defaults.set(tintWithArtwork, forKey: Key.tint) } }
    @Published var darkGlass: Bool { didSet { defaults.set(darkGlass, forKey: Key.dark) } }
    @Published var showMusicActivity: Bool { didSet { defaults.set(showMusicActivity, forKey: Key.music) } }
    @Published var showAgentActivity: Bool { didSet { defaults.set(showAgentActivity, forKey: Key.agents) } }
    @Published var showCallActivity: Bool { didSet { defaults.set(showCallActivity, forKey: Key.calls) } }
    @Published var haptics: Bool { didSet { defaults.set(haptics, forKey: Key.haptics) } }
    /// Seconds the pointer has to rest on the notch before it opens.
    @Published var hoverDelay: Double { didSet { defaults.set(hoverDelay, forKey: Key.hoverDelay) } }
    /// The system gauges (temperatures, memory, disk) on the desktop.
    @Published var showStatsWidget: Bool {
        didSet { defaults.set(showStatsWidget, forKey: Key.statsWidget) }
    }
    /// Move desktop icons that end up under the stats widget to free spots.
    @Published var keepIconsClear: Bool {
        didSet { defaults.set(keepIconsClear, forKey: Key.keepIconsClear) }
    }

    private init() {
        defaults.register(defaults: [
            Key.glassStyle: GlassStyle.waterdrop.rawValue,
            Key.frost: 0.88,
            Key.tint: true,
            Key.dark: true,
            Key.music: true,
            Key.agents: true,
            Key.calls: true,
            Key.haptics: true,
            Key.hoverDelay: 0.12,
            Key.statsWidget: true,
            Key.keepIconsClear: true,
        ])
        glassStyle = GlassStyle(rawValue: defaults.string(forKey: Key.glassStyle) ?? "") ?? .waterdrop
        frost = defaults.double(forKey: Key.frost)
        tintWithArtwork = defaults.bool(forKey: Key.tint)
        darkGlass = defaults.bool(forKey: Key.dark)
        showMusicActivity = defaults.bool(forKey: Key.music)
        showAgentActivity = defaults.bool(forKey: Key.agents)
        showCallActivity = defaults.bool(forKey: Key.calls)
        haptics = defaults.bool(forKey: Key.haptics)
        hoverDelay = defaults.double(forKey: Key.hoverDelay)
        showStatsWidget = defaults.bool(forKey: Key.statsWidget)
        keepIconsClear = defaults.bool(forKey: Key.keepIconsClear)
    }
}
