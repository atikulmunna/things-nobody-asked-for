import SwiftUI

/// A shape that hangs from the top edge of the screen: concave flares at the top corners that
/// blend into the screen edge, and rounded corners at the bottom.
struct NotchShape: Shape {
    var topRadius: CGFloat
    var bottomRadius: CGFloat
    /// When false the path is left open along the top edge, for stroking a rim that does not
    /// draw a line across the top of the screen.
    var closed = true

    var animatableData: AnimatablePair<CGFloat, CGFloat> {
        get { AnimatablePair(topRadius, bottomRadius) }
        set {
            topRadius = newValue.first
            bottomRadius = newValue.second
        }
    }

    func path(in r: CGRect) -> Path {
        let t = max(0, min(topRadius, r.width / 4, r.height / 2))
        let b = max(0, min(bottomRadius, (r.width - 2 * t) / 2, r.height - t))
        // Cubic handle length for a quarter circle, nudged up slightly for a softer, continuous curve.
        let k: CGFloat = 0.58

        var p = Path()
        p.move(to: CGPoint(x: r.minX, y: r.minY))

        // Top-left flare (concave).
        p.addCurve(to: CGPoint(x: r.minX + t, y: r.minY + t),
                   control1: CGPoint(x: r.minX + t * k, y: r.minY),
                   control2: CGPoint(x: r.minX + t, y: r.minY + t * (1 - k)))
        p.addLine(to: CGPoint(x: r.minX + t, y: r.maxY - b))

        // Bottom-left corner.
        p.addCurve(to: CGPoint(x: r.minX + t + b, y: r.maxY),
                   control1: CGPoint(x: r.minX + t, y: r.maxY - b * (1 - k)),
                   control2: CGPoint(x: r.minX + t + b * (1 - k), y: r.maxY))
        p.addLine(to: CGPoint(x: r.maxX - t - b, y: r.maxY))

        // Bottom-right corner.
        p.addCurve(to: CGPoint(x: r.maxX - t, y: r.maxY - b),
                   control1: CGPoint(x: r.maxX - t - b * (1 - k), y: r.maxY),
                   control2: CGPoint(x: r.maxX - t, y: r.maxY - b * (1 - k)))
        p.addLine(to: CGPoint(x: r.maxX - t, y: r.minY + t))

        // Top-right flare (concave).
        p.addCurve(to: CGPoint(x: r.maxX, y: r.minY),
                   control1: CGPoint(x: r.maxX - t, y: r.minY + t * (1 - k)),
                   control2: CGPoint(x: r.maxX - t * k, y: r.minY))
        if closed { p.closeSubpath() }
        return p
    }
}

/// Notch shape whose corner radii follow its height, growing from the closed radii to the open
/// ones as it expands. Because the radii come from the frame alone, the AppKit glass mask and the
/// SwiftUI layers drawn over it stay in lockstep through every frame of a spring animation.
struct LiquidNotchShape: Shape {
    var collapsedHeight: CGFloat
    var expandedHeight: CGFloat
    var closed = true

    static let closedRadii = (top: CGFloat(6), bottom: CGFloat(13))
    static let openRadii = (top: CGFloat(12), bottom: CGFloat(26))

    static func radii(height: CGFloat, collapsedHeight: CGFloat, expandedHeight: CGFloat) -> (top: CGFloat, bottom: CGFloat) {
        let span = max(1, expandedHeight - collapsedHeight)
        let progress = min(1, max(0, (height - collapsedHeight) / span))
        return (closedRadii.top + (openRadii.top - closedRadii.top) * progress,
                closedRadii.bottom + (openRadii.bottom - closedRadii.bottom) * progress)
    }

    func path(in rect: CGRect) -> Path {
        let r = Self.radii(height: rect.height, collapsedHeight: collapsedHeight, expandedHeight: expandedHeight)
        return NotchShape(topRadius: r.top, bottomRadius: r.bottom, closed: closed).path(in: rect)
    }
}
