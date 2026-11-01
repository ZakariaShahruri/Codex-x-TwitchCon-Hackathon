import CoreGraphics
import CoreText
import Foundation
import ImageIO

let output = CommandLine.arguments.dropFirst().first ?? "tools/ocr-vision/fixtures/screen.png"
let width = 1280
let height = 360
let colorSpace = CGColorSpaceCreateDeviceRGB()
let bitmapInfo = CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue)
guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8,
                              bytesPerRow: 0, space: colorSpace, bitmapInfo: bitmapInfo.rawValue) else {
    fatalError("Unable to create fixture bitmap")
}
context.setFillColor(CGColor(gray: 1, alpha: 1))
context.fill(CGRect(x: 0, y: 0, width: width, height: height))

func draw(_ string: String, baseline: CGFloat) {
    let font = CTFontCreateWithName("Menlo" as CFString, 52, nil)
    let attributes: [NSAttributedString.Key: Any] = [
        NSAttributedString.Key(kCTFontAttributeName as String): font,
        NSAttributedString.Key(kCTForegroundColorAttributeName as String): CGColor(gray: 0, alpha: 1),
    ]
    let line = CTLineCreateWithAttributedString(NSAttributedString(string: string, attributes: attributes))
    context.textPosition = CGPoint(x: 80, y: baseline)
    CTLineDraw(line, context)
}

draw("EMAIL: streamer@example.com", baseline: 245)
draw("API_KEY=sk-demo-secret-123", baseline: 145)

guard let image = context.makeImage(),
      let destination = CGImageDestinationCreateWithURL(URL(fileURLWithPath: output) as CFURL, "public.png" as CFString, 1, nil) else {
    fatalError("Unable to create fixture PNG")
}
CGImageDestinationAddImage(destination, image, nil)
guard CGImageDestinationFinalize(destination) else { fatalError("Unable to write fixture PNG") }
