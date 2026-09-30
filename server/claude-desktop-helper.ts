// Source of the native helper that server/claude-desktop.ts compiles on first
// use (swiftc). Kept as text so it ships inside the packaged server.
// String.raw keeps Swift's backslashes (\(...) interpolation, "\n") intact.
export const DESKTOP_HELPER_SOURCE = String.raw`// omb-desktop: the few native actions OpenMausBot needs to drive the Claude
// desktop app the way a person would. Compiled on first use by
// server/claude-desktop.ts (swiftc), so it needs no Python or extra packages.
//
//   omb-desktop idle                 seconds since the last keyboard/mouse input
//   omb-desktop front                bundle id of the frontmost application
//   omb-desktop locked               1 if the screen is locked or the main display asleep, else 0
//   omb-desktop screen               "W H" of the main display, in points
//   omb-desktop activate BUNDLE      bring the running app with that bundle id to the front
//   omb-desktop ocr                  "x y w h | text" lines for the main display,
//                                    in screen points, origin top-left
//   omb-desktop click|rclick X Y     left or right click at screen point
//   omb-desktop key CODE [cmd]       press a key (virtual key code), optionally with ⌘
//   omb-desktop type FILE            type FILE's text as keystrokes (not a paste, so the
//                                    app does not fold it into pasted content)
//   omb-desktop paste FILE [all]     put FILE's text on the clipboard, optionally ⌘A,
//                                    then ⌘V, then restore the previous clipboard
//                                    (every item and type: images and files too)
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

func click(_ x: Double, _ y: Double, right: Bool = false) {
  let point = CGPoint(x: x, y: y)
  post(CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left))
  post(CGEvent(mouseEventSource: nil, mouseType: right ? .rightMouseDown : .leftMouseDown, mouseCursorPosition: point, mouseButton: right ? .right : .left))
  post(CGEvent(mouseEventSource: nil, mouseType: right ? .rightMouseUp : .leftMouseUp, mouseCursorPosition: point, mouseButton: right ? .right : .left))
}

func key(_ code: CGKeyCode, command: Bool) {
  for down in [true, false] {
    let event = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down)
    if command { event?.flags = .maskCommand }
    post(event)
  }
}

func screenLocked() -> Bool {
  if let session = CGSessionCopyCurrentDictionary() as? [String: Any],
     let locked = session["CGSSessionScreenIsLocked"] as? NSNumber, locked.boolValue { return true }
  return CGDisplayIsAsleep(CGMainDisplayID()) != 0
}

/** A copy of everything on the clipboard, every item with every type. */
func saveClipboard(_ board: NSPasteboard) -> [NSPasteboardItem] {
  return (board.pasteboardItems ?? []).map { item in
    let copy = NSPasteboardItem()
    for type in item.types {
      if let data = item.data(forType: type) { copy.setData(data, forType: type) }
    }
    return copy
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
guard args.count >= 2 else { fail("usage: omb-desktop idle|front|locked|screen|activate|ocr|click|key|paste") }
switch args[1] {
case "idle":
  print(String(format: "%.1f", idleSeconds()))
case "front":
  print(NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? "")
case "locked":
  print(screenLocked() ? "1" : "0")
case "screen":
  let bounds = CGDisplayBounds(CGMainDisplayID())
  print(String(format: "%.0f %.0f", bounds.width, bounds.height))
case "activate":
  guard args.count >= 3 else { fail("activate BUNDLE") }
  guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: args[2]).first else { fail("\(args[2]) is not running") }
  app.activate()
case "ocr":
  ocr()
case "click", "rclick":
  guard args.count >= 4, let x = Double(args[2]), let y = Double(args[3]) else { fail("click X Y") }
  click(x, y, right: args[1] == "rclick")
case "key":
  guard args.count >= 3, let code = UInt16(args[2]) else { fail("key CODE [cmd]") }
  key(code, command: args.count >= 4 && args[3] == "cmd")
case "type":
  guard args.count >= 3, let text = try? String(contentsOfFile: args[2], encoding: .utf8) else { fail("type FILE") }
  let units = Array(text.utf16)
  var start = 0
  while start < units.count {
    let chunk = Array(units[start..<min(start + 20, units.count)])
    for down in [true, false] {
      let event = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: down)
      chunk.withUnsafeBufferPointer { buffer in event?.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: buffer.baseAddress) }
      post(event)
    }
    start += 20
  }
case "paste":
  guard args.count >= 3, let text = try? String(contentsOfFile: args[2], encoding: .utf8) else { fail("paste FILE [all]") }
  let board = NSPasteboard.general
  let previous = saveClipboard(board)
  board.clearContents()
  board.setString(text, forType: .string)
  if args.count >= 4 && args[3] == "all" { key(0, command: true) } // ⌘A
  key(9, command: true) // ⌘V
  usleep(400_000)
  // Our text never stays behind: the person's clipboard comes back, or an empty one.
  board.clearContents()
  if !previous.isEmpty { board.writeObjects(previous) }
default:
  fail("unknown command \(args[1])")
}
`;
