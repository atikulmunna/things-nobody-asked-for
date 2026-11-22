import AppKit
import SwiftUI

/// AppKit Liquid Glass (`NSGlassEffectView`) clipped to the notch shape.
///
/// SwiftUI's `glassEffect` renders large surfaces with the frosted standard material only.
/// AppKit's glass view also has private variants: a lensing one that bends what is behind it like a
/// water drop (11), and a clear, Dock-like one (20). Styles:
///
/// - `.waterdrop`: lens on top, frost underneath. The frost is inset from the edges so the rim
///   refracts the sharp background, while the middle stays frosted and legible.
/// - `.frosted`: the standard material only.
/// - `.clear`: clear glass everywhere.
///
/// The glass views are given the real outline (`_setPath:`, private) so their edge lighting and
/// lensing follow the notch shape, including the concave flares where it meets the screen edge.
/// The outline's top edge is lifted above the screen so no rim is drawn along the top. If a future
/// macOS drops these private calls, the views fall back to the standard material clipped by masks.
///
/// Before macOS 26 there is no Liquid Glass; `FrostedNotchView` draws the classic frosted blur in
/// the same shape instead.
struct GlassLayer: NSViewRepresentable {
    var style: GlassStyle
    var frost: Double
    var tint: NSColor?
    /// Heights between which the corner radii grow (see `LiquidNotchShape`).
    var collapsedHeight: CGFloat
    var expandedHeight: CGFloat
    var active: Bool

    func makeNSView(context: Context) -> NSView {
        if #available(macOS 26, *), !GlassSupport.forceFallback { return NotchGlassView() }
        return FrostedNotchView()
    }

    func updateNSView(_ view: NSView, context: Context) {
        guard let view = view as? NotchGlassBacking else { return }
        view.configure(style: style, frost: frost, tint: tint, active: active)
        view.setHeights(collapsed: collapsedHeight, expanded: expandedHeight)
    }
}

/// A glass background for the notch: Liquid Glass on macOS 26+, frosted blur before.
protocol NotchGlassBacking: NSView {
    func configure(style: GlassStyle, frost: Double, tint: NSColor?, active: Bool)
    func setHeights(collapsed: CGFloat, expanded: CGFloat)
}

enum GlassSupport {
    /// Debug aid (`GLASSNOTCH_FORCE_FALLBACK=1`): show the pre-macOS 26 look on a newer Mac.
    static let forceFallback = ProcessInfo.processInfo.environment["GLASSNOTCH_FORCE_FALLBACK"] != nil

    /// Whether real Liquid Glass is available (macOS 26 or later).
    static var liquidGlass: Bool {
        if #available(macOS 26, *) { return !forceFallback }
        return false
    }
}

/// The notch background on macOS 14–15: the classic behind-window blur, clipped to the notch shape.
final class FrostedNotchView: NSView, NotchGlassBacking {
    private let effect = NSVisualEffectView()
    private let shapeMask = CAShapeLayer()
    private var collapsedHeight: CGFloat = 24
    private var expandedHeight: CGFloat = 96

    init() {
        super.init(frame: .zero)
        wantsLayer = true
        effect.material = .hudWindow
        effect.blendingMode = .behindWindow
        effect.state = .active
        addSubview(effect)
        layer?.mask = shapeMask
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    func configure(style: GlassStyle, frost: Double, tint: NSColor?, active: Bool) {
        if isHidden == active { isHidden = !active }
        let material: NSVisualEffectView.Material = style == .clear ? .popover : .hudWindow
        if effect.material != material { effect.material = material }
    }

    func setHeights(collapsed: CGFloat, expanded: CGFloat) {
        guard collapsed != collapsedHeight || expanded != expandedHeight else { return }
        collapsedHeight = collapsed
        expandedHeight = expanded
        needsLayout = true
    }

    override func layout() {
        super.layout()
        effect.frame = bounds
        let radii = LiquidNotchShape.radii(height: bounds.height, collapsedHeight: collapsedHeight,
                                           expandedHeight: expandedHeight)
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        shapeMask.frame = bounds
        var flip = CGAffineTransform(scaleX: 1, y: -1).translatedBy(x: 0, y: -bounds.height)
        shapeMask.path = NotchShape(topRadius: radii.top, bottomRadius: radii.bottom).path(in: bounds).cgPath
            .copy(using: &flip)
        CATransaction.commit()
    }
}

@available(macOS 26, *)
final class NotchGlassView: NSView, NotchGlassBacking {
    /// How far the frost stays inside the lens edge, so the rim refracts the sharp background.
    private static let frostSideInset: CGFloat = 6
    private static let frostBottomInset: CGFloat = 14

    private let frostView = NSGlassEffectView()
    private let lensView = NSGlassEffectView()
    private let frostMask = CAShapeLayer()
    private let lensMask = CAShapeLayer()
    private var collapsedHeight: CGFloat = 24
    private var expandedHeight: CGFloat = 96
    private var style: GlassStyle?

    private static let trace = ProcessInfo.processInfo.environment["GLASSNOTCH_TRACE"] != nil
    /// Lens strength; slightly below 1 so its edge light is not glaring.
    private static let lensOpacity: CGFloat = 0.9
    /// Darkness at the very bottom of the lens, to tame the bright band it draws along that edge.
    private static let bottomShadeStrength: CGFloat = 0.5
    private static let bottomShadeHeight: CGFloat = 22
    /// How far the outline's top edge is pushed above the screen edge.
    private static let topLift: CGFloat = 60

    private typealias SetPathFn = @convention(c) (AnyObject, Selector, CGPath?) -> Void
    private static let setPathSelector = NSSelectorFromString("_setPath:")
    private static let setPath: SetPathFn? = class_getInstanceMethod(NSGlassEffectView.self, setPathSelector)
        .map { unsafeBitCast(method_getImplementation($0), to: SetPathFn.self) }

    init() {
        super.init(frame: .zero)
        wantsLayer = true
        // Order matters: the lens samples (and bends) the frost beneath it.
        for glass in [frostView, lensView] {
            glass.wantsLayer = true
            addSubview(glass)
        }
        if Self.setPath == nil {
            frostView.layer?.mask = frostMask
            lensView.layer?.mask = lensMask
        }
        lensView.alphaValue = Self.lensOpacity
        // The lens draws its edge light above anything SwiftUI layers over it, so the darkening for
        // the bottom edge lives inside the glass, as its content placed above the glass surface.
        bottomShade.colors = [NSColor.clear.cgColor, NSColor.black.withAlphaComponent(Self.bottomShadeStrength).cgColor]
        bottomShade.startPoint = CGPoint(x: 0.5, y: 1)
        bottomShade.endPoint = CGPoint(x: 0.5, y: 0)
        let content = NSView()
        content.wantsLayer = true
        content.layer?.addSublayer(bottomShade)
        lensView.contentView = content
        Self.setPrivate(lensView, true, forKey: "_placesContentAboveGlass")
    }

    private let bottomShade = CAGradientLayer()

    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    func configure(style: GlassStyle, frost: Double, tint: NSColor?, active: Bool) {
        if isHidden == active { isHidden = !active }
        if self.style != style {
            self.style = style
            switch style {
            case .waterdrop:
                Self.setPrivate(lensView, 11, forKey: "_variant")
                Self.setPrivate(lensView, 0, forKey: "_contentLensing")
            case .clear:
                Self.setPrivate(lensView, 20, forKey: "_variant")
                Self.setPrivate(lensView, 1, forKey: "_contentLensing")
            case .frosted:
                break
            }
            lensView.isHidden = style == .frosted
            frostView.isHidden = style == .clear
            needsLayout = true
        }
        let alpha = style == .waterdrop ? CGFloat(min(1, max(0, frost))) : 1
        if frostView.alphaValue != alpha { frostView.alphaValue = alpha }
        let wantedTint = tint?.withAlphaComponent(0.35)
        if frostView.tintColor != wantedTint { frostView.tintColor = wantedTint }
    }

    func setHeights(collapsed: CGFloat, expanded: CGFloat) {
        guard collapsed != collapsedHeight || expanded != expandedHeight else { return }
        collapsedHeight = collapsed
        expandedHeight = expanded
        needsLayout = true
    }

    override func layout() {
        super.layout()
        if Self.trace {
            FileHandle.standardError.write("glass \(Int(bounds.width))x\(Int(bounds.height))\n".data(using: .utf8)!)
        }
        layoutGlass()
    }

    private func layoutGlass() {
        let size = bounds.size
        guard size.width > 0, size.height > 0 else { return }
        let radii = LiquidNotchShape.radii(height: size.height, collapsedHeight: collapsedHeight,
                                           expandedHeight: expandedHeight)
        let t = radii.top, b = radii.bottom
        let side = Self.frostSideInset, bottom = Self.frostBottomInset
        let innerRect = CGRect(x: 0, y: 0, width: size.width, height: max(0, size.height - bottom))
        let frostInset = style == .waterdrop

        CATransaction.begin()
        CATransaction.setDisableActions(true)
        defer { CATransaction.commit() }

        if let setPath = Self.setPath {
            lensView.frame = bounds
            lensView.cornerRadius = 0
            frostView.frame = bounds
            frostView.cornerRadius = 0
            let lensPath = flipped(Self.hanging(in: bounds, top: t, bottom: b, lift: Self.topLift), height: size.height)
            let frostPath = frostInset
                ? flipped(Self.hanging(in: innerRect, top: t + side, bottom: max(0, b - side), lift: Self.topLift),
                          height: size.height)
                : lensPath
            setPath(lensView, Self.setPathSelector, lensPath)
            bottomShade.frame = CGRect(x: 0, y: 0, width: size.width, height: min(size.height, Self.bottomShadeHeight))
            setPath(frostView, Self.setPathSelector, frostPath)
            return
        }

        // Fallback: rounded-rectangle lens lined up with the body, both clipped by masks.
        lensView.cornerRadius = b
        lensView.frame = CGRect(x: t, y: 0, width: max(0, size.width - 2 * t), height: size.height + b)
        frostView.cornerRadius = 0
        frostView.frame = bounds
        let outer = flipped(NotchShape(topRadius: t, bottomRadius: b).path(in: bounds).cgPath, height: size.height)
        frostMask.frame = frostView.bounds
        frostMask.path = frostInset
            ? flipped(NotchShape(topRadius: t + side, bottomRadius: max(0, b - side)).path(in: innerRect).cgPath,
                      height: size.height)
            : outer
        var shift = CGAffineTransform(translationX: -lensView.frame.minX, y: -lensView.frame.minY)
        lensMask.frame = lensView.bounds
        lensMask.path = outer.copy(using: &shift)
    }

    /// The notch outline (drawn top-down) with its top edge pushed `lift` points above the rect.
    private static func hanging(in rect: CGRect, top: CGFloat, bottom: CGFloat, lift: CGFloat) -> CGPath {
        let path = CGMutablePath()
        path.addPath(NotchShape(topRadius: top, bottomRadius: bottom, closed: false).path(in: rect).cgPath)
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.minY - lift))
        path.addLine(to: CGPoint(x: rect.minX, y: rect.minY - lift))
        path.closeSubpath()
        return path
    }

    /// NotchShape is drawn top-down; these layers have their origin at the bottom left.
    private func flipped(_ path: CGPath, height: CGFloat) -> CGPath {
        var flip = CGAffineTransform(scaleX: 1, y: -1).translatedBy(x: 0, y: -height)
        return path.copy(using: &flip) ?? path
    }

    private static func setPrivate(_ glass: NSGlassEffectView, _ value: Any, forKey key: String) {
        guard glass.responds(to: NSSelectorFromString("set\(key):")) else { return }
        glass.setValue(value, forKey: key)
    }
}
