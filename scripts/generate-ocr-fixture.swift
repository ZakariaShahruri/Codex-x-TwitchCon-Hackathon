import CoreGraphics
import CoreText
import Foundation
import ImageIO

let arguments = Array(CommandLine.arguments.dropFirst())
let benchmarkMode = arguments.first == "--benchmark"
// --small draws the same lines at editor size (12px Menlo), where OCR is most likely to miss text.
let smallMode = benchmarkMode && arguments.dropFirst().first == "--small"
let matrixMode = arguments.first == "--matrix"
let output = arguments.dropFirst((benchmarkMode ? 1 : 0) + (smallMode ? 1 : 0)).first ??
    (smallMode ? "tools/ocr-vision/fixtures/fake-env-1080p-12px.png" :
     benchmarkMode ? "tools/ocr-vision/fixtures/fake-env-1080p.png" : "tools/ocr-vision/fixtures/screen.png")
let width = benchmarkMode ? 1920 : 1280
let height = benchmarkMode ? 1080 : 360
let colorSpace = CGColorSpaceCreateDeviceRGB()
let bitmapInfo = CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue)
guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8,
                              bytesPerRow: 0, space: colorSpace, bitmapInfo: bitmapInfo.rawValue) else {
    fatalError("Unable to create fixture bitmap")
}
context.setFillColor(benchmarkMode ? CGColor(red: 0.12, green: 0.13, blue: 0.15, alpha: 1) : CGColor(gray: 1, alpha: 1))
context.fill(CGRect(x: 0, y: 0, width: width, height: height))

func draw(_ string: String, baseline: CGFloat, x: CGFloat = 80, size: CGFloat = 52, fontName: String = "Menlo", color: CGColor = CGColor(gray: 0, alpha: 1)) {
    let font = CTFontCreateWithName(fontName as CFString, size, nil)
    let attributes: [NSAttributedString.Key: Any] = [
        NSAttributedString.Key(kCTFontAttributeName as String): font,
        NSAttributedString.Key(kCTForegroundColorAttributeName as String): color,
    ]
    let line = CTLineCreateWithAttributedString(NSAttributedString(string: string, attributes: attributes))
    context.textPosition = CGPoint(x: x, y: baseline)
    CTLineDraw(line, context)
}

func inkBounds(pixels: UnsafePointer<UInt8>, width: Int, height: Int, xRange: Range<Int>,
               baseline: CGFloat, fontSize: Int, background: (Int, Int, Int)) -> [String: Double] {
    func bounds(in rows: Range<Int>) -> (Int, Int, Int, Int)? {
        var left = width
        var top = height
        var right = -1
        var bottom = -1
        for row in rows {
            for x in xRange {
                let offset = (row * width + x) * 4
                let difference = abs(Int(pixels[offset]) - background.0) + abs(Int(pixels[offset + 1]) - background.1) + abs(Int(pixels[offset + 2]) - background.2)
                if difference < 45 { continue }
                left = min(left, x); top = min(top, row); right = max(right, x); bottom = max(bottom, row)
            }
        }
        return right >= left ? (left, top, right, bottom) : nil
    }
    let topOriginCenter = Int((CGFloat(height) - baseline).rounded())
    let radius = fontSize * 2
    let topOriginRows = max(0, topOriginCenter - radius)..<min(height, topOriginCenter + radius + 1)
    let bottomOriginRows = max(0, Int(baseline) - radius)..<min(height, Int(baseline) + radius + 1)
    let hit = bounds(in: topOriginRows).map { ($0, false) } ?? bounds(in: bottomOriginRows).map { ($0, true) }
    guard let (raw, bottomOrigin) = hit else { fatalError("Could not locate rendered secret glyphs") }
    let y = bottomOrigin ? height - raw.3 - 1 : raw.1
    return ["x": Double(raw.0), "y": Double(y), "w": Double(raw.2 - raw.0 + 1), "h": Double(raw.3 - raw.1 + 1)]
}

if matrixMode {
    let directory = URL(fileURLWithPath: arguments.dropFirst().first ?? "tools/ocr-vision/fixtures/full-resolution", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let secrets: [(String, String)] = [
        ("api_key", "OPENAI_API_KEY=" + "sk-" + "proj-" + "twitchy-fake-0123456789abcdef0123456789"),
        ("api_key", "TWITCH_BOT_TOKEN=oauth:fake-twitch-token-abcdef0123456789"),
        ("api_key", "AWS_SECRET_ACCESS_KEY=FAKE_AWS_SECRET_0123456789abcdef"),
        ("password", "DATABASE_URL=postgres://demo:FakePassword123@localhost:5432/app"),
        ("email", "EMAIL=streamer@example.invalid"),
    ]
    let sizes = [10, 11, 12, 14, 16]
    let themes = ["dark", "light"]
    let fonts = ["Menlo", "Monaco"]
    let width = 1920
    let height = 1080
    for size in sizes {
        for theme in themes {
            for fontName in fonts {
                let bg = theme == "dark" ? CGColor(red: 0.12, green: 0.13, blue: 0.15, alpha: 1) : CGColor(red: 0.96, green: 0.96, blue: 0.94, alpha: 1)
                let pixelBuffer = UnsafeMutablePointer<UInt8>.allocate(capacity: width * height * 4)
                pixelBuffer.initialize(repeating: 0, count: width * height * 4)
                defer { pixelBuffer.deallocate() }
                guard let ctx = CGContext(data: pixelBuffer, width: width, height: height, bitsPerComponent: 8,
                                          bytesPerRow: width * 4, space: colorSpace, bitmapInfo: bitmapInfo.rawValue) else {
                    fatalError("Unable to create matrix fixture bitmap")
                }
                ctx.setFillColor(bg)
                ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
                let lineGap: CGFloat = 180
                var boxes: [[String: Any]] = []
                for (index, item) in secrets.enumerated() {
                    let baseline = CGFloat(860) - CGFloat(index) * lineGap
                    let x: CGFloat = 200
                    let font = CTFontCreateWithName(fontName as CFString, CGFloat(size), nil)
                    let attributes: [NSAttributedString.Key: Any] = [
                        NSAttributedString.Key(kCTFontAttributeName as String): font,
                        NSAttributedString.Key(kCTForegroundColorAttributeName as String): theme == "dark"
                            ? CGColor(red: 0.88, green: 0.89, blue: 0.91, alpha: 1)
                            : CGColor(red: 0.12, green: 0.13, blue: 0.15, alpha: 1),
                    ]
                    let attributed = NSAttributedString(string: item.1, attributes: attributes)
                    let ctLine = CTLineCreateWithAttributedString(attributed)
                    ctx.textPosition = CGPoint(x: x, y: baseline)
                    CTLineDraw(ctLine, ctx)

                    let marker = item.1.contains("=") ? item.1.range(of: "=")!.upperBound : item.1.startIndex
                    let secretRange: Range<String.Index>
                    if item.1.hasPrefix("DATABASE_URL=") {
                        secretRange = item.1.range(of: "FakePassword123")!
                    } else if item.1.hasPrefix("EMAIL=") {
                        secretRange = item.1.range(of: "streamer@example.invalid")!
                    } else {
                        secretRange = marker..<item.1.endIndex
                    }
                    let startIndex = item.1.utf16.distance(from: item.1.utf16.startIndex, to: secretRange.lowerBound.samePosition(in: item.1.utf16)!)
                    let endIndex = item.1.utf16.distance(from: item.1.utf16.startIndex, to: secretRange.upperBound.samePosition(in: item.1.utf16)!)
                    let left = Int(floor(x + CTLineGetOffsetForStringIndex(ctLine, startIndex, nil))) - 3
                    let right = Int(ceil(x + CTLineGetOffsetForStringIndex(ctLine, endIndex, nil))) + 3
                    let rgb = theme == "dark" ? (31, 33, 38) : (245, 245, 240)
                    let box = inkBounds(pixels: pixelBuffer, width: width, height: height,
                                        xRange: max(0, left)..<min(width, right), baseline: baseline,
                                        fontSize: size, background: rgb)
                    boxes.append(["kind": item.0, "line": index, "box": box])
                }
                guard let image = ctx.makeImage() else { fatalError("Unable to create matrix image") }
                let name = "font-\(size)-\(theme)-\(fontName.lowercased())"
                let pngURL = directory.appendingPathComponent("\(name).png")
                guard let destination = CGImageDestinationCreateWithURL(pngURL as CFURL, "public.png" as CFString, 1, nil) else {
                    fatalError("Unable to write matrix fixture \(name)")
                }
                CGImageDestinationAddImage(destination, image, nil)
                guard CGImageDestinationFinalize(destination) else { fatalError("Unable to finalize \(name)") }
                let metadata: [String: Any] = ["width": width, "height": height, "fontSize": size, "theme": theme, "font": fontName, "secrets": boxes]
                let json = try JSONSerialization.data(withJSONObject: metadata, options: [.prettyPrinted, .sortedKeys])
                try json.write(to: directory.appendingPathComponent("\(name).json"))
            }
        }
    }
    print("Generated 20 full-resolution OCR variants in \(directory.path)")
    exit(EXIT_SUCCESS)
}

if benchmarkMode {
    let titleBar = CGColor(red: 0.16, green: 0.17, blue: 0.20, alpha: 1)
    let gutter = CGColor(red: 0.17, green: 0.18, blue: 0.20, alpha: 1)
    context.setFillColor(titleBar)
    context.fill(CGRect(x: 0, y: 1018, width: 1920, height: 62))
    context.setFillColor(gutter)
    context.fill(CGRect(x: 0, y: 42, width: 170, height: 976))
    context.setFillColor(CGColor(red: 0.20, green: 0.21, blue: 0.24, alpha: 1))
    context.fill(CGRect(x: 0, y: 0, width: 1920, height: 42))
    for (index, color) in [CGColor(red: 0.96, green: 0.35, blue: 0.33, alpha: 1),
                           CGColor(red: 0.98, green: 0.75, blue: 0.25, alpha: 1),
                           CGColor(red: 0.30, green: 0.78, blue: 0.39, alpha: 1)].enumerated() {
        context.setFillColor(color)
        context.fillEllipse(in: CGRect(x: CGFloat(28 + index * 34), y: 1040, width: 18, height: 18))
    }
    draw("fake .env — Twitchy OCR benchmark", baseline: 1037, x: 800, size: 22,
         color: CGColor(red: 0.82, green: 0.83, blue: 0.85, alpha: 1))
    draw("fake .env", baseline: 980, x: 95, size: 22,
         color: CGColor(red: 0.91, green: 0.92, blue: 0.94, alpha: 1))

    let lines = [
        "# TWITCHY OCR BENCHMARK — FAKE CREDENTIALS ONLY",
        "OPENAI_API_KEY=sk-proj-twitchy-fake-0123456789abcdef0123456789",
        "TWITCH_BOT_TOKEN=oauth:fake-twitch-token-abcdef0123456789",
        "AWS_SECRET_ACCESS_KEY=FAKE_AWS_SECRET_0123456789abcdef",
        "DATABASE_URL=postgres://demo:FakePassword123@localhost:5432/app",
        "EMAIL=streamer@example.invalid",
    ]
    let fontSize: CGFloat = smallMode ? 12 : 34
    let lineHeight: CGFloat = smallMode ? 20 : 112
    for (index, line) in lines.enumerated() {
        let baseline = 860 - CGFloat(index) * lineHeight
        draw(String(index + 1), baseline: baseline, x: 105, size: fontSize,
             color: CGColor(red: 0.48, green: 0.51, blue: 0.56, alpha: 1))
        let color = index == 0 ? CGColor(red: 0.48, green: 0.68, blue: 0.49, alpha: 1) :
            CGColor(red: 0.82, green: 0.85, blue: 0.88, alpha: 1)
        draw(line, baseline: baseline, x: 200, size: fontSize, color: color)
    }
} else {
    draw("EMAIL: streamer@example.com", baseline: 245)
    draw("API_KEY=sk-demo-secret-123", baseline: 145)
}

guard let image = context.makeImage(),
      let destination = CGImageDestinationCreateWithURL(URL(fileURLWithPath: output) as CFURL, "public.png" as CFString, 1, nil) else {
    fatalError("Unable to create fixture PNG")
}
CGImageDestinationAddImage(destination, image, nil)
guard CGImageDestinationFinalize(destination) else { fatalError("Unable to write fixture PNG") }
