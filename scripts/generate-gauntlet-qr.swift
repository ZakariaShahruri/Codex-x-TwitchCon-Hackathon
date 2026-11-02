// Renders the Leak Gauntlet's QR case: a fake login URL, so no npm QR dependency is needed.
// Run: swift scripts/generate-gauntlet-qr.swift
import AppKit
import CoreImage

let payload = "https://login.example.invalid/device?code=GAUNTLET-QR-7F3K"
let output = URL(fileURLWithPath: "tools/gauntlet/qr-login.png")

guard let filter = CIFilter(name: "CIQRCodeGenerator") else { fatalError("CIQRCodeGenerator unavailable") }
filter.setValue(payload.data(using: .utf8), forKey: "inputMessage")
filter.setValue("M", forKey: "inputCorrectionLevel")
guard let code = filter.outputImage else { fatalError("QR generation failed") }

// 8 px per module plus a 4-module quiet zone, rendered without smoothing so modules stay sharp.
let scaled = code.transformed(by: CGAffineTransform(scaleX: 8, y: 8))
let quiet = 32.0
let size = CGSize(width: scaled.extent.width + 2 * quiet, height: scaled.extent.height + 2 * quiet)
let white = CIImage(color: .white).cropped(to: CGRect(origin: .zero, size: size))
let image = scaled.transformed(by: CGAffineTransform(translationX: quiet, y: quiet)).composited(over: white)
let context = CIContext(options: [.useSoftwareRenderer: true])
guard let cgImage = context.createCGImage(image, from: image.extent) else { fatalError("Render failed") }
let rep = NSBitmapImageRep(cgImage: cgImage)
guard let png = rep.representation(using: .png, properties: [:]) else { fatalError("PNG encoding failed") }
try png.write(to: output)
print("Wrote \(output.path) (\(Int(size.width))x\(Int(size.height)))")
