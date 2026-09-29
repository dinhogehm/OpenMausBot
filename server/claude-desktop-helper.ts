// Source of the native helper that server/claude-desktop.ts compiles on first
// use (swiftc). Kept as text so it ships inside the packaged server.
// String.raw keeps Swift's backslashes (\(...) interpolation, "\n") intact.
export const DESKTOP_HELPER_SOURCE = String.raw`// omb-desktop: the few native actions OpenMausBot needs to drive the Claude
// desktop app the way a person would. Compiled on first use by
// server/claude-desktop.ts (swiftc), so it needs no Python or extra packages.
//
//   omb-desktop idle                 seconds since the last keyboard/mouse input
//   omb-desktop front                name of the frontmost application
//   omb-desktop ocr                  "x y w h | text" lines for the main display,
//                                    in screen points, origin top-left
//   omb-desktop click X Y            left click at screen point
//   omb-desktop key CODE [cmd]       press a key (virtual key code), optionally with ⌘
//   omb-desktop paste FILE [all]     put FILE's text on the clipboard, optionally ⌘A,
//                                    then ⌘V, then restore the previous clipboard
import AppKit
import CoreGraphics
import Foundation
import IOKit
import Vision

func fail(_ message: String) -> Never {
  FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
  exit(1)
}

func idleSeconds() -> Double {
  var iterator: io_iterator_t = 0
  guard IOServiceGetMatchingServices(kIOMainPortDefault, IOServiceMatching("IOHIDSystem"), &iterator) == KERN_SUCCESS else { return 0 }
  defer { IOObjectRelease(iterator) }
  let entry = IOIteratorNext(iterator)
  defer { IOObjectRelease(entry) }
  var props: Unmanaged<CFMutableDictionary>?
  guard IORegistryEntryCreateCFProperties(entry, &props, kCFAllocatorDefault, 0) == KERN_SUCCESS,
        let dict = props?.takeRetainedValue() as? [String: Any],
        let ns = dict["HIDIdleTime"] as? UInt64 else { return 0 }
  return Double(ns) / 1_000_000_000
}

func post(_ event: CGEvent?) {
  event?.post(tap: .cghidEventTap)
  usleep(60_000)
}

func click(_ x: Double, _ y: Double) {
  let point = CGPoint(x: x, y: y)
  post(CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left))
  post(CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left))
  post(CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left))
}

func key(_ code: CGKeyCode, command: Bool) {
  for down in [true, false] {
    let event = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down)
    if command { event?.flags = .maskCommand }
    post(event)
  }
}

func ocr() {
  // The system screencapture tool: CGDisplayCreateImage is gone in macOS 15.
  let file = NSTemporaryDirectory() + "omb-desktop-\(getpid()).png"
  defer { try? FileManager.default.removeItem(atPath: file) }
  let capture = Process()
  capture.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
  capture.arguments = ["-x", "-o", "-m", file]
  do { try capture.run() } catch { fail("screencapture failed: \(error)") }
  capture.waitUntilExit()
  guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: file) as CFURL, nil),
        let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { fail("screen capture unavailable (Screen Recording permission?)") }
  let pointsWide = Double(CGDisplayBounds(CGMainDisplayID()).width)
  let scale = Double(image.width) / pointsWide
  let request = VNRecognizeTextRequest()
  request.recognitionLevel = .accurate
  request.recognitionLanguages = ["pt-BR", "en-US"]
  do { try VNImageRequestHandler(cgImage: image).perform([request]) } catch { fail("ocr failed: \(error)") }
  let W = Double(image.width), H = Double(image.height)
  for observation in request.results ?? [] {
    guard let top = observation.topCandidates(1).first else { continue }
    let b = observation.boundingBox
    print(String(format: "%.0f %.0f %.0f %.0f | %@",
                 b.minX * W / scale, (1 - b.maxY) * H / scale, b.width * W / scale, b.height * H / scale, top.string))
  }
}

let args = CommandLine.arguments
guard args.count >= 2 else { fail("usage: omb-desktop idle|front|ocr|click|key|paste") }
switch args[1] {
case "idle":
  print(String(format: "%.1f", idleSeconds()))
case "front":
  print(NSWorkspace.shared.frontmostApplication?.localizedName ?? "")
case "ocr":
  ocr()
case "click":
  guard args.count >= 4, let x = Double(args[2]), let y = Double(args[3]) else { fail("click X Y") }
  click(x, y)
case "key":
  guard args.count >= 3, let code = UInt16(args[2]) else { fail("key CODE [cmd]") }
  key(code, command: args.count >= 4 && args[3] == "cmd")
case "paste":
  guard args.count >= 3, let text = try? String(contentsOfFile: args[2], encoding: .utf8) else { fail("paste FILE [all]") }
  let board = NSPasteboard.general
  let previous = board.string(forType: .string)
  board.clearContents()
  board.setString(text, forType: .string)
  if args.count >= 4 && args[3] == "all" { key(0, command: true) } // ⌘A
  key(9, command: true) // ⌘V
  usleep(400_000)
  board.clearContents()
  if let previous { board.setString(previous, forType: .string) }
default:
  fail("unknown command \(args[1])")
}
`;
