import CoreGraphics
import Foundation
import ImageIO
import Vision

private struct PixelBox: Codable, Equatable {
    let x: Int
    let y: Int
    let w: Int
    let h: Int
}

private struct WordResult: Codable {
    let text: String
    let box: PixelBox
}

private struct TextResult: Codable {
    let text: String
    let box: PixelBox
    let words: [WordResult]
}

private struct BarcodeResult: Codable {
    let payload: String
    let symbology: String
    let box: PixelBox
}

private struct FrameResult: Codable {
    let ok: Bool
    let width: Int
    let height: Int
    let text: [TextResult]
    let barcodes: [BarcodeResult]
    let error: String?
}

/// Convert Vision's unit rectangle (origin at lower-left) to an outward-rounded,
/// clamped canvas rectangle (origin at top-left).
private func pixelBox(_ rect: CGRect, imageWidth: Int, imageHeight: Int) -> PixelBox {
    let width = max(0, imageWidth)
    let height = max(0, imageHeight)
    let left = min(width, max(0, Int(floor(rect.minX * CGFloat(width)))))
    let top = min(height, max(0, Int(floor((1 - rect.maxY) * CGFloat(height)))))
    let right = min(width, max(left, Int(ceil(rect.maxX * CGFloat(width)))))
    let bottom = min(height, max(top, Int(ceil((1 - rect.minY) * CGFloat(height)))))
    return PixelBox(x: left, y: top, w: right - left, h: bottom - top)
}

private func makeWords(_ candidate: VNRecognizedText, width: Int, height: Int) -> [WordResult] {
    let source = candidate.string
    var words: [WordResult] = []
    var cursor = source.startIndex

    while cursor < source.endIndex {
        while cursor < source.endIndex && source[cursor].isWhitespace { cursor = source.index(after: cursor) }
        guard cursor < source.endIndex else { break }
        let start = cursor
        while cursor < source.endIndex && !source[cursor].isWhitespace { cursor = source.index(after: cursor) }
        let range = start..<cursor
        guard let box = try? candidate.boundingBox(for: range) else { continue }
        words.append(WordResult(text: String(source[range]), box: pixelBox(box.boundingBox, imageWidth: width, imageHeight: height)))
    }
    return words
}

private func recognize(_ png: Data, level: VNRequestTextRecognitionLevel) throws -> FrameResult {
    guard let source = CGImageSourceCreateWithData(png as CFData, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
        throw NSError(domain: "TwitchyOCR", code: 1, userInfo: [NSLocalizedDescriptionKey: "Input is not a decodable PNG image"])
    }
    let width = image.width
    let height = image.height
    let textRequest = VNRecognizeTextRequest()
    textRequest.recognitionLevel = level
    textRequest.usesLanguageCorrection = false

    let barcodeRequest = VNDetectBarcodesRequest()
    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    try handler.perform([textRequest, barcodeRequest])

    let lines = (textRequest.results ?? []).compactMap { observation -> TextResult? in
        guard let candidate = observation.topCandidates(1).first else { return nil }
        return TextResult(
            text: candidate.string,
            box: pixelBox(observation.boundingBox, imageWidth: width, imageHeight: height),
            words: makeWords(candidate, width: width, height: height)
        )
    }
    let barcodes = (barcodeRequest.results ?? []).compactMap { observation -> BarcodeResult? in
        guard let payload = observation.payloadStringValue else { return nil }
        return BarcodeResult(payload: payload, symbology: String(describing: observation.symbology),
                             box: pixelBox(observation.boundingBox, imageWidth: width, imageHeight: height))
    }
    return FrameResult(ok: true, width: width, height: height, text: lines, barcodes: barcodes, error: nil)
}

private func readExactly(_ count: Int) throws -> Data? {
    guard count >= 0 else { throw protocolError("Negative frame length") }
    var data = Data()
    while data.count < count {
        guard let part = try FileHandle.standardInput.read(upToCount: count - data.count), !part.isEmpty else {
            if data.isEmpty { return nil }
            throw protocolError("Truncated frame on stdin")
        }
        data.append(part)
    }
    return data
}

private func protocolError(_ message: String) -> NSError {
    NSError(domain: "TwitchyOCRProtocol", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
}

private func write(_ result: FrameResult) throws {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    var data = try encoder.encode(result)
    data.append(0x0a)
    FileHandle.standardOutput.write(data)
}

private func emitError(_ error: Error) {
    try? write(FrameResult(ok: false, width: 0, height: 0, text: [], barcodes: [], error: error.localizedDescription))
}

private func run(level: VNRequestTextRecognitionLevel) throws {
    let maximumFrameBytes = 128 * 1024 * 1024
    while let header = try readExactly(4) {
        let length = header.reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
        guard length > 0, length <= maximumFrameBytes else {
            throw protocolError("Frame length must be between 1 and \(maximumFrameBytes) bytes")
        }
        guard let frame = try readExactly(Int(length)) else { throw protocolError("Missing frame data") }
        do {
            try write(try recognize(frame, level: level))
        } catch {
            emitError(error)
        }
    }
}

private func selfTestBox() throws {
    let result = pixelBox(CGRect(x: 0.25, y: 0.25, width: 0.5, height: 0.5), imageWidth: 200, imageHeight: 100)
    let data = try JSONEncoder().encode(result)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0a]))
}

let arguments = Array(CommandLine.arguments.dropFirst())
if arguments == ["--self-test-box"] {
    try selfTestBox()
} else {
    let level: VNRequestTextRecognitionLevel
    switch arguments {
    case [], ["--level", "fast"]: level = .fast
    case ["--level", "accurate"]: level = .accurate
    default:
        FileHandle.standardError.write(Data("Usage: twitchy-ocr [--level fast|accurate]\n".utf8))
        exit(2)
    }
    do { try run(level: level) }
    catch {
        FileHandle.standardError.write(Data("Twitchy OCR protocol error: \(error.localizedDescription)\n".utf8))
        exit(1)
    }
}
