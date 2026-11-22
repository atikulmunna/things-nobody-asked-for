// Draws the GlassNotch app icon and writes Resources/AppIcon.icns.
// Run from the project root:  swift Scripts/make-icon.swift
import AppKit

let canvas: CGFloat = 1024

func roundedSquircle(_ rect: CGRect, radius: CGFloat) -> CGPath {
    CGPath(roundedRect: rect, cornerWidth: radius, cornerHeight: radius, transform: nil)
}

/// Notch outline (y grows downward from `top`), concave flares at the top corners.
func notchPath(centerX: CGFloat, top: CGFloat, width: CGFloat, height: CGFloat, flare: CGFloat, bottom: CGFloat) -> CGPath {
    let minX = centerX - width / 2, maxX = centerX + width / 2
    let k: CGFloat = 0.58
    let p = CGMutablePath()
    // Coordinates in a flipped space: we draw with a y-down transform applied by the caller.
    p.move(to: CGPoint(x: minX, y: top))
    p.addCurve(to: CGPoint(x: minX + flare, y: top + flare),
               control1: CGPoint(x: minX + flare * k, y: top), control2: CGPoint(x: minX + flare, y: top + flare * (1 - k)))
    p.addLine(to: CGPoint(x: minX + flare, y: top + height - bottom))
    p.addCurve(to: CGPoint(x: minX + flare + bottom, y: top + height),
               control1: CGPoint(x: minX + flare, y: top + height - bottom * (1 - k)),
               control2: CGPoint(x: minX + flare + bottom * (1 - k), y: top + height))
    p.addLine(to: CGPoint(x: maxX - flare - bottom, y: top + height))
    p.addCurve(to: CGPoint(x: maxX - flare, y: top + height - bottom),
               control1: CGPoint(x: maxX - flare - bottom * (1 - k), y: top + height),
               control2: CGPoint(x: maxX - flare, y: top + height - bottom * (1 - k)))
    p.addLine(to: CGPoint(x: maxX - flare, y: top + flare))
    p.addCurve(to: CGPoint(x: maxX, y: top),
               control1: CGPoint(x: maxX - flare, y: top + flare * (1 - k)), control2: CGPoint(x: maxX - flare * k, y: top))
    p.closeSubpath()
    return p
}

func color(_ hex: UInt32, _ alpha: CGFloat = 1) -> CGColor {
    CGColor(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255, alpha: alpha)
}

func drawIcon(size: Int) -> Data {
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8,
                               samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                               bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let ctx = NSGraphicsContext.current!.cgContext
    let scale = CGFloat(size) / canvas
    ctx.scaleBy(x: scale, y: scale)
    // Work top-down.
    ctx.translateBy(x: 0, y: canvas)
    ctx.scaleBy(x: 1, y: -1)
    let space = CGColorSpace(name: CGColorSpace.sRGB)!

    // Body: Apple's icon grid (824pt body, ~185pt corners) with a soft drop shadow.
    let body = CGRect(x: 100, y: 100, width: 824, height: 824)
    let bodyPath = roundedSquircle(body, radius: 186)
    ctx.saveGState()
    ctx.setShadow(offset: CGSize(width: 0, height: 14), blur: 30, color: color(0x000000, 0.35))
    ctx.addPath(bodyPath)
    ctx.setFillColor(color(0x10131c))
    ctx.fillPath()
    ctx.restoreGState()

    ctx.saveGState()
    ctx.addPath(bodyPath)
    ctx.clip()
    // Background: deep blue gradient with colorful glows, like a wallpaper under glass.
    let bg = CGGradient(colorsSpace: space, colors: [color(0x2a3358), color(0x0b0e18)] as CFArray, locations: [0, 1])!
    ctx.drawLinearGradient(bg, start: CGPoint(x: 512, y: 100), end: CGPoint(x: 512, y: 924), options: [])
    for (center, hex, radius) in [(CGPoint(x: 300, y: 560), UInt32(0xff5f8f), CGFloat(330)),
                                  (CGPoint(x: 760, y: 470), UInt32(0x3fd1c9), CGFloat(300)),
                                  (CGPoint(x: 560, y: 820), UInt32(0x7a5cff), CGFloat(320))] {
        let glow = CGGradient(colorsSpace: space, colors: [color(hex, 0.55), color(hex, 0)] as CFArray, locations: [0, 1])!
        ctx.drawRadialGradient(glow, startCenter: center, startRadius: 0, endCenter: center, endRadius: radius, options: [])
    }

    // Glass pill hanging from the top edge of the "screen".
    let pill = notchPath(centerX: 512, top: 100, width: 700, height: 330, flare: 40, bottom: 92)
    ctx.saveGState()
    ctx.addPath(pill)
    ctx.clip()
    let glass = CGGradient(colorsSpace: space, colors: [color(0xffffff, 0.30), color(0xffffff, 0.12)] as CFArray,
                           locations: [0, 1])!
    ctx.drawLinearGradient(glass, start: CGPoint(x: 512, y: 100), end: CGPoint(x: 512, y: 430), options: [])
    // Darker band at the top so it melts into the notch.
    let top = CGGradient(colorsSpace: space, colors: [color(0x000000, 0.35), color(0x000000, 0)] as CFArray,
                         locations: [0, 1])!
    ctx.drawLinearGradient(top, start: CGPoint(x: 512, y: 100), end: CGPoint(x: 512, y: 230), options: [])
    ctx.restoreGState()
    // Rim: bright along the edges, softer at the bottom.
    ctx.saveGState()
    ctx.addPath(pill)
    ctx.setLineWidth(5)
    ctx.setStrokeColor(color(0xffffff, 0.55))
    ctx.strokePath()
    ctx.restoreGState()

    // Hardware notch.
    let notch = notchPath(centerX: 512, top: 100, width: 300, height: 92, flare: 16, bottom: 40)
    ctx.addPath(notch)
    ctx.setFillColor(color(0x000000))
    ctx.fillPath()

    // Content on the glass: album tile, two text lines, a progress bar.
    let tile = CGRect(x: 238, y: 236, width: 128, height: 128)
    ctx.saveGState()
    ctx.addPath(roundedSquircle(tile, radius: 30))
    ctx.clip()
    let art = CGGradient(colorsSpace: space, colors: [color(0xffb45c), color(0xe0533d)] as CFArray, locations: [0, 1])!
    ctx.drawLinearGradient(art, start: CGPoint(x: tile.minX, y: tile.minY), end: CGPoint(x: tile.maxX, y: tile.maxY), options: [])
    ctx.restoreGState()
    for (y, width, alpha) in [(CGFloat(252), CGFloat(330), CGFloat(0.92)), (CGFloat(296), CGFloat(220), CGFloat(0.55))] {
        ctx.addPath(roundedSquircle(CGRect(x: 396, y: y, width: width, height: 26), radius: 13))
        ctx.setFillColor(color(0xffffff, alpha))
        ctx.fillPath()
    }
    ctx.addPath(roundedSquircle(CGRect(x: 396, y: 342, width: 390, height: 14), radius: 7))
    ctx.setFillColor(color(0xffffff, 0.22))
    ctx.fillPath()
    ctx.addPath(roundedSquircle(CGRect(x: 396, y: 342, width: 210, height: 14), radius: 7))
    ctx.setFillColor(color(0xffb45c))
    ctx.fillPath()

    ctx.restoreGState()
    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])!
}

let fm = FileManager.default
let iconset = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("AppIcon.iconset")
try? fm.removeItem(at: iconset)
try fm.createDirectory(at: iconset, withIntermediateDirectories: true)
for base in [16, 32, 128, 256, 512] {
    try drawIcon(size: base).write(to: iconset.appendingPathComponent("icon_\(base)x\(base).png"))
    try drawIcon(size: base * 2).write(to: iconset.appendingPathComponent("icon_\(base)x\(base)@2x.png"))
}
let output = URL(fileURLWithPath: "Resources/AppIcon.icns")
let iconutil = Process()
iconutil.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
iconutil.arguments = ["-c", "icns", iconset.path, "-o", output.path]
try iconutil.run()
iconutil.waitUntilExit()
try drawIcon(size: 512).write(to: URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("GlassNotch-icon-preview.png"))
print(iconutil.terminationStatus == 0 ? "Wrote \(output.path)" : "iconutil failed")
