import AppKit
import SwiftUI

/// The glass look chosen in the menu (Waterdrop, Frosted or Clear), handed down to `ShapedGlass`.
struct GlassLook: Equatable {
    var style: GlassStyle
    var frost: Double
}

private struct GlassLookKey: EnvironmentKey {
    static let defaultValue = GlassLook(style: .waterdrop, frost: 0.88)
}

extension EnvironmentValues {
    var glassLook: GlassLook {
        get { self[GlassLookKey.self] }
        set { self[GlassLookKey.self] = newValue }
    }
}

/// Glass in any shape, with the notch's looks: Waterdrop (a lens that bends what's behind it like a
/// water drop, over frost), Frosted or Clear.
///
/// SwiftUI's `glassEffect` only draws the frosted standard material, so this uses AppKit's
/// `NSGlassEffectView` with its private variants and outline (see `GlassLayer`). Before macOS 26, or
/// if a future macOS drops the private calls, it falls back to `liquidGlass(in:)`.
struct ShapedGlass<S: Shape>: View {
    var shape: S
    /// How far the frost stays inside the lens edge in Waterdrop, so the rim refracts the sharp
    /// background and the middle stays legible. nil leaves just the lens.
    var frostInset: CGFloat?

    @Environment(\.glassLook) private var look

    var body: some View {
        if #available(macOS 26, *), !GlassSupport.forceFallback, NSGlassEffectView.supportsOutline {
            let inset = frostInset
            ShapedGlassRepresentable(
                outline: { shape.path(in: $0).cgPath },
                frostOutline: inset.map { inset in { shape.path(in: $0.insetBy(dx: inset, dy: inset)).cgPath } },
                look: look)
        } else {
            Color.clear.liquidGlass(in: shape)
        }
    }
}

@available(macOS 26, *)
private struct ShapedGlassRepresentable: NSViewRepresentable {
    var outline: (CGRect) -> CGPath
    var frostOutline: ((CGRect) -> CGPath)?
    var look: GlassLook

    func makeNSView(context: Context) -> ShapedGlassView { ShapedGlassView() }

    func updateNSView(_ view: ShapedGlassView, context: Context) {
        view.outline = outline
        view.frostOutline = frostOutline
        view.configure(look)
    }
}

@available(macOS 26, *)
final class ShapedGlassView: NSView {
    /// The shape, drawn top-down in the view's bounds (SwiftUI coordinates).
    var outline: ((CGRect) -> CGPath)? { didSet { needsLayout = true } }
    var frostOutline: ((CGRect) -> CGPath)? { didSet { needsLayout = true } }

    /// Lens strength; slightly below 1 so its edge light is not glaring.
    private static let lensOpacity: CGFloat = 0.9

    private let frostView = NSGlassEffectView()
    private let lensView = NSGlassEffectView()
    private var look: GlassLook?

    init() {
        super.init(frame: .zero)
        wantsLayer = true
        // Order matters: the lens samples (and bends) the frost beneath it.
        for glass in [frostView, lensView] {
            glass.wantsLayer = true
            addSubview(glass)
        }
        lensView.alphaValue = Self.lensOpacity
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    func configure(_ look: GlassLook) {
        guard look != self.look else { return }
        if look.style != self.look?.style {
            switch look.style {
            case .waterdrop:
                lensView.setPrivateValue(11, forKey: "_variant")
                lensView.setPrivateValue(0, forKey: "_contentLensing")
            case .clear:
                lensView.setPrivateValue(20, forKey: "_variant")
                lensView.setPrivateValue(1, forKey: "_contentLensing")
            case .frosted:
                break
            }
        }
        self.look = look
        frostView.alphaValue = look.style == .waterdrop ? CGFloat(min(1, max(0, look.frost))) : 1
        needsLayout = true
    }

    override func layout() {
        super.layout()
        guard let outline, let style = look?.style, bounds.width > 0, bounds.height > 0 else { return }
        let lensPath = flipped(outline(bounds))
        let frostPath: CGPath? = switch style {
        case .waterdrop: frostOutline.map { flipped($0(bounds)) }
        case .frosted: lensPath
        case .clear: nil
        }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        lensView.frame = bounds
        lensView.isHidden = style == .frosted
        lensView.setOutline(lensPath)
        frostView.frame = bounds
        frostView.isHidden = frostPath == nil
        if let frostPath { frostView.setOutline(frostPath) }
        CATransaction.commit()
    }

    /// SwiftUI paths are drawn top-down; these views have their origin at the bottom left.
    private func flipped(_ path: CGPath) -> CGPath {
        var flip = CGAffineTransform(scaleX: 1, y: -1).translatedBy(x: 0, y: -bounds.height)
        return path.copy(using: &flip) ?? path
    }
}

@available(macOS 26, *)
extension NSGlassEffectView {
    private typealias SetPathFn = @convention(c) (AnyObject, Selector, CGPath?) -> Void
    private static let setPathSelector = NSSelectorFromString("_setPath:")
    private static let setPathIMP: SetPathFn? = class_getInstanceMethod(NSGlassEffectView.self, setPathSelector)
        .map { unsafeBitCast(method_getImplementation($0), to: SetPathFn.self) }

    /// Whether this macOS still lets glass take an arbitrary outline (private `_setPath:`).
    static var supportsOutline: Bool { setPathIMP != nil }

    /// Gives the glass an arbitrary outline, so its edge light and lensing follow it.
    func setOutline(_ path: CGPath) {
        Self.setPathIMP?(self, Self.setPathSelector, path)
    }

    /// Sets one of the glass view's private properties, if this macOS still has it.
    func setPrivateValue(_ value: Any, forKey key: String) {
        guard responds(to: NSSelectorFromString("set\(key):")) else { return }
        setValue(value, forKey: key)
    }
}
