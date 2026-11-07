import AppKit
// Focus exactly the supervised native player. Never launch a second application.
guard CommandLine.arguments.count == 2,
      let pid = Int32(CommandLine.arguments[1]),
      let player = NSRunningApplication(processIdentifier: pid),
      player.bundleIdentifier == "com.moonlight-stream.Moonlight",
      !player.isTerminated else { exit(2) }
exit(player.activate(options: [.activateAllWindows]) ? 0 : 2)
