import CoreGraphics
import CoreText
import Foundation
import ImageIO

let arguments = Array(CommandLine.arguments.dropFirst())
let benchmarkMode = arguments.first == "--benchmark"
// --small draws the same lines at editor size (12px Menlo), where OCR is most likely to miss text.
let smallMode = benchmarkMode && arguments.dropFirst().first == "--small"
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

func draw(_ string: String, baseline: CGFloat, x: CGFloat = 80, size: CGFloat = 52, color: CGColor = CGColor(gray: 0, alpha: 1)) {
    let font = CTFontCreateWithName("Menlo" as CFString, size, nil)
    let attributes: [NSAttributedString.Key: Any] = [
        NSAttributedString.Key(kCTFontAttributeName as String): font,
        NSAttributedString.Key(kCTForegroundColorAttributeName as String): color,
    ]
    let line = CTLineCreateWithAttributedString(NSAttributedString(string: string, attributes: attributes))
    context.textPosition = CGPoint(x: x, y: baseline)
    CTLineDraw(line, context)
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
